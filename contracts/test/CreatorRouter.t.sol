// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CreatorRouter} from "../src/CreatorRouter.sol";

/* ------------------------------------------------------------------ test doubles -- */

contract MockToken {
    string public name = "Mock";
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function burn(uint256 a) external { balanceOf[msg.sender] -= a; totalSupply -= a; }
}

/// A curve that hands out tokens at a fixed rate and can be told it has graduated.
contract MockCurve {
    MockToken public immutable token;
    address public immutable pair;
    bool public graduated;
    uint256 public rate = 1000; // tokens per unit of quote

    constructor(MockToken t, address p) { token = t; pair = p; }
    function setGraduated(bool g) external { graduated = g; }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external payable returns (uint256 out)
    {
        if (pair == address(0)) require(msg.value == quoteIn, "value must equal quoteIn");
        else MockToken(pair).transferFrom(msg.sender, address(this), quoteIn);
        out = quoteIn * rate;
        require(out >= minTokensOut, "min out");
        token.mint(recipient, out);
    }
}

/// Pons's factory, answering with a record we control.
contract MockPonsFactory {
    struct Rec { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken;
        uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled;
        uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }
    mapping(address => Rec) internal recs;
    address public memeHook;
    function set(address t, address curve, address feeRecipient, address pair) external {
        Rec storage r = recs[t];
        r.token = t; r.curve = curve; r.creatorFeeRecipient = feeRecipient; r.pairToken = pair;
        r.poolFee = 3000; r.tickSpacing = 60; r.exists = true;
    }
    function getLaunchedToken(address t) external view returns (Rec memory) { return recs[t]; }
}

/// Our launchpad's registry: the thing an attacker cannot forge.
contract MockLaunchpad {
    mapping(address => address) public distributorOf;
    function register(address token, address distributor) external { distributorOf[token] = distributor; }
    function isCharityLaunch(address token) external view returns (bool) { return distributorOf[token] != address(0); }
}

/// A distributor is only ever read for one thing here: who it pays the creator's half to.
contract MockDistributor {
    address public opsVault;
    function setOps(address v) external { opsVault = v; }
}

contract MockClaims {
    mapping(address => mapping(bytes32 => mapping(address => uint256))) public credited;
    function fund(address launch, bytes32 beneficiary, address asset, uint256 amount) external payable {
        if (asset == address(0)) require(msg.value == amount, "value");
        else MockToken(asset).transferFrom(msg.sender, address(this), amount);
        credited[launch][beneficiary][asset] += amount;
    }
}

/* ------------------------------------------------------------------------- tests -- */

/**
 * The creator's remainder, split three ways.
 *
 * ⛔ These are UNIT tests against doubles. They prove the arithmetic, the accounting and the refusals
 * — the things that are true regardless of what Pons's contracts do. What a real curve and a real V4
 * pool do is a different question and is answered on a fork, not here.
 */
contract CreatorRouterTest is Test {
    MockToken token;
    MockToken pairErc20;
    MockCurve curveNative;
    MockClaims claims;
    MockPonsFactory ponsFactory;
    MockLaunchpad launchpad;

    address constant WALLET = 0x00000000000000000000000000000000caFe0001;
    uint256 constant X_ACCOUNT_ID = 1234567890;
    bytes32 constant X_BENEFICIARY = keccak256("x:1234567890");

    function setUp() public {
        token = new MockToken();
        pairErc20 = new MockToken();
        curveNative = new MockCurve(token, address(0));
        claims = new MockClaims();
        ponsFactory = new MockPonsFactory();
        launchpad = new MockLaunchpad();
    }

    /**
     * Deploy, wire the two registries the way a real launch does, and bind.
     *
     * ⚠ The order matters and mirrors the chain of immutables on chain: the router exists first,
     * the distributor names it, the launch names the distributor, and only then can it bind.
     */
    function _router(CreatorRouter.Split[] memory splits, address pair, MockCurve c)
        internal returns (CreatorRouter r)
    {
        r = new CreatorRouter(address(ponsFactory), address(launchpad), address(claims), address(0), splits);
        MockDistributor dist = new MockDistributor();
        dist.setOps(address(r));
        launchpad.register(address(token), address(dist));
        ponsFactory.set(address(token), address(c), address(dist), pair);
        r.initialize(address(token));
    }

    /**
     * Construction ALONE, for the refusals.
     *
     * ⚠ Separate from {_router} on purpose. `vm.expectRevert` covers the next call only, so using
     * the full helper here would catch the constructor's revert and then run the wiring that
     * follows it against a router that was never created — which reverts again, for an unrelated
     * reason, and reports as the same failure.
     */
    function _deployOnly(CreatorRouter.Split[] memory splits) internal returns (CreatorRouter) {
        return new CreatorRouter(address(ponsFactory), address(launchpad), address(claims), address(0), splits);
    }

    /**
     * ⚠ Derives `provider` and `accountId` from the mode, because the contract now REFUSES an
     * XAccount share whose declared account does not hash to its beneficiary. A helper that let a
     * test build a mismatched pair by accident would make every other test here a coin flip.
     */
    function _one(CreatorRouter.Mode m, uint16 bps, address w, bytes32 b)
        internal pure returns (CreatorRouter.Split memory)
    {
        bool acct = m == CreatorRouter.Mode.XAccount;
        return CreatorRouter.Split({
            mode: m, bps: bps, wallet: w, beneficiary: b,
            provider: acct ? 1 : 0,
            accountId: acct ? X_ACCOUNT_ID : 0
        });
    }

    /* ------------------------------------------------------------ the shape rules -- */

    function test_sharesMustAddToExactlyTenThousand() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](2);
        s[0] = _one(CreatorRouter.Mode.Wallet, 5000, WALLET, bytes32(0));
        s[1] = _one(CreatorRouter.Mode.Burn, 4000, address(0), bytes32(0));
        vm.expectRevert(CreatorRouter.BadSplit.selector);
        _deployOnly(s);
    }

    /// ⛔ A share that promises something and moves nothing is the one thing an immutable
    /// commitment must never be able to say.
    function test_aZeroBpsShareIsRefused() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](2);
        s[0] = _one(CreatorRouter.Mode.Wallet, 10000, WALLET, bytes32(0));
        s[1] = _one(CreatorRouter.Mode.Burn, 0, address(0), bytes32(0));
        vm.expectRevert(CreatorRouter.BadSplit.selector);
        _deployOnly(s);
    }

    function test_aWalletShareNeedsAWalletAndNoBeneficiary() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = _one(CreatorRouter.Mode.Wallet, 10000, address(0), bytes32(0));
        vm.expectRevert(CreatorRouter.BadSplit.selector);
        _deployOnly(s);

        s[0] = _one(CreatorRouter.Mode.Wallet, 10000, WALLET, X_BENEFICIARY);
        vm.expectRevert(CreatorRouter.BadSplit.selector);
        _deployOnly(s);
    }

    function test_anXAccountShareNeedsABeneficiaryAndNoWallet() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = _one(CreatorRouter.Mode.XAccount, 10000, address(0), bytes32(0));
        vm.expectRevert(CreatorRouter.BadSplit.selector);
        _deployOnly(s);

        s[0] = _one(CreatorRouter.Mode.XAccount, 10000, WALLET, X_BENEFICIARY);
        vm.expectRevert(CreatorRouter.BadSplit.selector);
        _deployOnly(s);
    }

    /* ------------------------------------------------------------- all three legs -- */

    function _allThree() internal returns (CreatorRouter) {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](3);
        s[0] = _one(CreatorRouter.Mode.Wallet, 5000, WALLET, bytes32(0));
        s[1] = _one(CreatorRouter.Mode.XAccount, 3000, address(0), X_BENEFICIARY);
        s[2] = _one(CreatorRouter.Mode.Burn, 2000, address(0), bytes32(0));
        return _router(s, address(0), curveNative);
    }

    /// ⭐⭐ The combination the whole feature exists for: a wallet, an X account and a burn at once.
    function test_allThreeLegsArePaidFromOneNativeFee() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 ether);

        r.distribute(address(0));

        assertEq(WALLET.balance, 0.5 ether, "wallet");
        assertEq(claims.credited(address(token), X_BENEFICIARY, address(0)), 0.3 ether, "x account");
        assertEq(r.burnReserve(address(0)), 0.2 ether, "burn reserve");
        assertEq(address(r).balance, 0.2 ether, "only the burn share is still held");
    }

    /**
     * ⛔⛔ THE HAZARD THIS CONTRACT IS SHAPED AROUND. `distribute` is permissionless, so anyone can
     * call it twice. If the burn reserve were not excluded from the pool it splits, the second call
     * would pay the wallet and the X account a cut of money already accounted to the burn — and it
     * would do so on every call, for ever, until the burn leg had nothing left.
     */
    function test_callingDistributeAgainPaysNobodyTwice() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 ether);
        r.distribute(address(0));

        vm.expectRevert(CreatorRouter.NothingToDistribute.selector);
        r.distribute(address(0));

        assertEq(WALLET.balance, 0.5 ether, "the wallet was not paid twice");
        assertEq(r.burnReserve(address(0)), 0.2 ether, "the burn reserve was not raided");
    }

    /// A second fee is split on its own terms and adds to the reserve rather than replacing it.
    function test_aSecondFeeSplitsOnTopOfTheFirst() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 ether);
        r.distribute(address(0));
        vm.deal(address(r), address(r).balance + 1 ether);
        r.distribute(address(0));

        assertEq(WALLET.balance, 1 ether);
        assertEq(claims.credited(address(token), X_BENEFICIARY, address(0)), 0.6 ether);
        assertEq(r.burnReserve(address(0)), 0.4 ether);
    }

    /// ⚠ The last share takes the remainder, so integer division cannot leave dust behind.
    function test_dustGoesToTheLastShareRatherThanBeingStranded() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 wei);
        r.distribute(address(0));
        // 1 wei: wallet gets 0, claims gets 0, and the last leg takes what is left.
        assertEq(WALLET.balance + r.burnReserve(address(0)), 1, "not one wei stranded");
        assertEq(address(r).balance, r.burnReserve(address(0)), "held == reserved");
    }

    /* --------------------------------------------------------------- buy and burn -- */

    function test_theBurnLegBuysTheTokenBackAndDestroysIt() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 ether);
        r.distribute(address(0));

        uint256 supplyBefore = token.totalSupply();
        (uint256 bought, uint256 burned) = r.buyAndBurn(0);

        assertEq(bought, 0.2 ether * 1000, "bought at the curve rate");
        assertEq(burned, bought, "everything bought was burned");
        assertEq(token.totalSupply(), supplyBefore, "supply is back where it started, not raised");
        assertEq(token.balanceOf(address(r)), 0, "the router keeps none of it");
        assertEq(r.burnReserve(address(0)), 0, "the reserve was spent");
        assertEq(r.totalTokensBurned(), burned);
    }

    /// ⚠⚠ Zero is not "no limit", it is "any fill is acceptable" — so a real floor must be honoured.
    function test_aSlippageFloorIsEnforced() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 ether);
        r.distribute(address(0));
        vm.expectRevert(); // the curve itself refuses before we get to check
        r.buyAndBurn(type(uint256).max);
    }

    function test_burningWithNothingReservedIsRefusedRatherThanSilent() public {
        CreatorRouter r = _allThree();
        vm.expectRevert(CreatorRouter.NothingToBurn.selector);
        r.buyAndBurn(0);
    }

    /// ⛔ `curve.buy` stops working the moment a launch graduates, so the curve leg refuses too.
    function test_theCurveLegRefusesOnceGraduated() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 ether);
        r.distribute(address(0));
        curveNative.setGraduated(true);
        vm.expectRevert(CreatorRouter.AlreadyGraduated.selector);
        r.buyAndBurn(0);
    }

    function test_thePoolLegRefusesWhileStillOnTheCurve() public {
        CreatorRouter r = _allThree();
        vm.deal(address(r), 1 ether);
        r.distribute(address(0));
        vm.expectRevert(CreatorRouter.StillOnCurve.selector);
        r.buyAndBurnOnPool(0);
    }

    /* -------------------------------------------------- a launch priced in a stock -- */

    /**
     * ⭐⭐ THE CASE V2 OF THE DISTRIBUTOR EXISTS FOR: fees arrive as the stock, and the burn leg
     * spends the stock directly on the curve rather than selling it to USDG and buying it back.
     */
    function test_aStockPairedLaunchBurnsWithTheStockItself() public {
        MockCurve stockCurve = new MockCurve(token, address(pairErc20));
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](2);
        s[0] = _one(CreatorRouter.Mode.Wallet, 4000, WALLET, bytes32(0));
        s[1] = _one(CreatorRouter.Mode.Burn, 6000, address(0), bytes32(0));
        CreatorRouter r = _router(s, address(pairErc20), stockCurve);

        pairErc20.mint(address(r), 100e18);
        r.distribute(address(pairErc20));

        assertEq(pairErc20.balanceOf(WALLET), 40e18, "the wallet is paid in the stock");
        assertEq(r.burnReserve(address(pairErc20)), 60e18);

        (uint256 bought, uint256 burned) = r.buyAndBurn(0);
        assertEq(bought, 60e18 * 1000, "bought with the stock, one swap");
        assertEq(burned, bought);
        assertEq(pairErc20.balanceOf(address(r)), 0, "no stock left over");
    }

    /// The X leg works in an ERC-20 too — a launch can pay an X account in AAPL.
    function test_anXAccountShareIsCreditedInWhateverTheFeeArrivedAs() public {
        MockCurve stockCurve = new MockCurve(token, address(pairErc20));
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = _one(CreatorRouter.Mode.XAccount, 10000, address(0), X_BENEFICIARY);
        CreatorRouter r = _router(s, address(pairErc20), stockCurve);

        pairErc20.mint(address(r), 7e18);
        r.distribute(address(pairErc20));

        assertEq(claims.credited(address(token), X_BENEFICIARY, address(pairErc20)), 7e18);
        assertEq(pairErc20.balanceOf(address(r)), 0);
    }

    /* ------------------------------------------------- the declared account -- */

    /**
     * ⛔⛔ THE ATTACK THE ON-CHAIN CHECK EXISTS TO MAKE IMPOSSIBLE.
     *
     * `provider` and `accountId` are what a token page NAMES the payee from. Left unchecked they
     * are two numbers a launcher sets to anything they like — so a launch could pay
     * `keccak256("x:<their own id>")` while declaring somebody else's account, and the page would
     * truthfully render a link to a person receiving nothing. It is a lie with no cleverness in it:
     * type one account, declare another.
     *
     * ⚠ Verifying in the front end instead would make that DETECTABLE rather than impossible, and
     * only for readers using our page.
     */
    function test_aSplitCannotDeclareAnAccountItDoesNotPay() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = CreatorRouter.Split({
            mode: CreatorRouter.Mode.XAccount, bps: 10000, wallet: address(0),
            beneficiary: keccak256("x:1234567890"),
            provider: 1,
            accountId: 999   // ⛔ a different account from the one being paid
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                CreatorRouter.BeneficiaryMismatch.selector, keccak256("x:1234567890"), keccak256("x:999")
            )
        );
        _deployOnly(s);
    }

    /// ⛔ And the provider is part of the identity, so claiming GitHub for an X beneficiary fails.
    function test_theDeclaredProviderMustMatchTheBeneficiaryToo() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = CreatorRouter.Split({
            mode: CreatorRouter.Mode.XAccount, bps: 10000, wallet: address(0),
            beneficiary: keccak256("x:1234567890"),
            provider: 2,                 // ⛔ says GitHub
            accountId: 1234567890
        });
        vm.expectRevert();
        _deployOnly(s);
    }

    /// ✅ A correctly declared account is accepted, for both services.
    function test_aCorrectlyDeclaredAccountIsAccepted() public {
        for (uint8 p = 1; p <= 2; p++) {
            CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
            bytes32 b = keccak256(abi.encodePacked(p == 1 ? "x:" : "github:", "1234567890"));
            s[0] = CreatorRouter.Split({
                mode: CreatorRouter.Mode.XAccount, bps: 10000, wallet: address(0),
                beneficiary: b, provider: p, accountId: 1234567890
            });
            CreatorRouter r = _deployOnly(s);
            assertEq(r.splits()[0].provider, p);
            assertEq(r.splits()[0].accountId, 1234567890);
        }
    }

    /// ⛔ A wallet or burn share must not carry account metadata that means nothing there.
    function test_onlyAnAccountShareMayDeclareAnAccount() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = CreatorRouter.Split({
            mode: CreatorRouter.Mode.Burn, bps: 10000, wallet: address(0),
            beneficiary: bytes32(0), provider: 1, accountId: 5
        });
        vm.expectRevert(CreatorRouter.BadSplit.selector);
        _deployOnly(s);
    }

    /* ---------------------------------------------------------------- binding -- */

    /**
     * ⛔⛔ THE HIJACK `initialize` EXISTS TO REFUSE.
     *
     * A router's address is public the moment it is deployed and `initialize` is one-shot,
     * permissionless and unowned — so whoever binds it first binds it for ever. An attacker can
     * deploy their own distributor naming this router as its `opsVault` and make a real Pons launch
     * pointing at it. What they cannot do is write an entry into OUR launchpad's registry.
     *
     * Without the registry check this passes and the router is bound to their token for the rest of
     * its life: every fee it ever receives would be spent buying a coin it has nothing to do with,
     * and the real launch's own `initialize` would revert `AlreadyInitialized`.
     */
    function test_aStrangerCannotBindThisRouterToTheirOwnLaunch() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = _one(CreatorRouter.Mode.Burn, 10000, address(0), bytes32(0));
        CreatorRouter r = _deployOnly(s);

        // The attacker does everything they are actually able to do.
        MockToken theirToken = new MockToken();
        MockCurve theirCurve = new MockCurve(theirToken, address(0));
        MockDistributor theirDistributor = new MockDistributor();
        theirDistributor.setOps(address(r));                       // names OUR router
        ponsFactory.set(address(theirToken), address(theirCurve), address(theirDistributor), address(0));

        // ⛔ But the token is not in our registry, so it is not one of ours.
        vm.expectRevert(abi.encodeWithSelector(CreatorRouter.NotOurLaunch.selector, address(theirToken)));
        r.initialize(address(theirToken));

        assertFalse(r.initialized(), "the router is still free to bind to its real launch");
    }

    /// ⛔ And a launch of ours whose distributor pays somebody else is refused too.
    function test_aRegisteredLaunchWhoseDistributorPaysElsewhereIsRefused() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = _one(CreatorRouter.Mode.Burn, 10000, address(0), bytes32(0));
        CreatorRouter r = _deployOnly(s);

        MockDistributor other = new MockDistributor();
        other.setOps(address(0xdead));
        launchpad.register(address(token), address(other));
        ponsFactory.set(address(token), address(curveNative), address(other), address(0));

        vm.expectRevert(abi.encodeWithSelector(CreatorRouter.NotOurLaunch.selector, address(token)));
        r.initialize(address(token));
    }

    function test_bindingIsOneShot() public {
        CreatorRouter r = _allThree();
        vm.expectRevert(CreatorRouter.AlreadyInitialized.selector);
        r.initialize(address(token));
    }

    /// ⚠ Nothing may move before the launch is bound: a fee split now would ring-fence money
    /// against the zero address, unclaimable by anyone for ever.
    function test_nothingMovesBeforeBinding() public {
        CreatorRouter.Split[] memory s = new CreatorRouter.Split[](1);
        s[0] = _one(CreatorRouter.Mode.Wallet, 10000, WALLET, bytes32(0));
        CreatorRouter r = _deployOnly(s);
        vm.deal(address(r), 1 ether);
        vm.expectRevert(CreatorRouter.NotInitialized.selector);
        r.distribute(address(0));
    }

    /* ------------------------------------------------- the cross-layer contract -- */

    /**
     * ⛔⛔ THE ENUM'S NUMBERING IS AN API, NOT AN IMPLEMENTATION DETAIL.
     *
     * Three separate codebases encode these integers: this contract, the launch form that builds a
     * split, and the claim server that reads `splits()` back to decide who a launch pays. None of
     * them imports the others. Reordering `Mode` — or inserting a value in the middle, which is the
     * innocent-looking version — would compile everywhere, deploy cleanly, and silently send a
     * wallet share to the burn leg or credit a burn to somebody's X account.
     *
     * ➤ So the numbers are asserted rather than assumed, and this test is the thing that fails.
     */
    function test_theModeNumbersAreFixedBecauseTwoOtherCodebasesEncodeThem() public pure {
        assertEq(uint8(CreatorRouter.Mode.Wallet), 0, "web: leg === wallet ? 0");
        assertEq(uint8(CreatorRouter.Mode.XAccount), 1, "api: MODE_XACCOUNT = 1");
        assertEq(uint8(CreatorRouter.Mode.Burn), 2, "web: otherwise 2");
    }

    /**
     * ⛔⛔ AND THE BENEFICIARY IS `keccak256("<provider>:<numeric id>")`, WITH THE PROVIDER IN IT.
     *
     * The server derives this from the signed-in account and the form derives it from the resolved
     * account; this contract only ever stores it. If the three disagreed the chain would credit one
     * key and every claim would be checked against another — money visibly present, every claim
     * reverting, and nothing anywhere saying why.
     *
     * ⚠ The literal below is the value `api/identity.mjs` produces for the same pair, checked by
     * hand. The provider is folded in because X account 1 and GitHub account 1 are different people
     * and both services number from small integers.
     */
    function test_theBeneficiaryShapeMatchesWhatTheServerDerives() public pure {
        assertEq(
            keccak256("x:1234567890"),
            0x6d62ba5ee2a7f6870c8d2dd1573c225b808716c5d6dfb4f93a8395c5a3ee8900,
            "the server derives a different beneficiary for this account"
        );
        assertTrue(keccak256("x:1") != keccak256("github:1"), "the provider must be part of the identity");
    }

    /* ------------------------------------------------------------- immutability -- */

    /// ⛔ There is no setter for any of it. This is what the token committed to.
    function test_thereIsNoWayToChangeTheSplitsAfterDeployment() public {
        CreatorRouter r = _allThree();
        CreatorRouter.Split[] memory got = r.splits();
        assertEq(got.length, 3);
        assertEq(uint8(got[0].mode), uint8(CreatorRouter.Mode.Wallet));
        assertEq(got[0].bps, 5000);
        assertEq(got[0].wallet, WALLET);
        assertEq(got[1].beneficiary, X_BENEFICIARY);
        assertEq(uint8(got[2].mode), uint8(CreatorRouter.Mode.Burn));
    }
}
