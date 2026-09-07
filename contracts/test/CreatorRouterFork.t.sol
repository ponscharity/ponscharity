// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityLaunchpadV2, IPonsV2Factory} from "../src/CharityLaunchpadV2.sol";
import {CharityDistributorV2} from "../src/CharityDistributorV2.sol";
import {CreatorRouter} from "../src/CreatorRouter.sol";
import {CharityFeeClaims} from "../src/CharityFeeClaims.sol";
import {CreatorRouterFactory} from "../src/CreatorRouterFactory.sol";
import {IPoolManager} from "../src/V4Seller.sol";

interface IERC20Meta {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function symbol() external view returns (string memory);
}

/**
 * The whole new stack, launched for real against live Robinhood Chain.
 *
 * ## ⛔⛔ WHY THIS EXISTS WHEN THERE ARE ALREADY 20 UNIT TESTS
 *
 * The unit tests prove the arithmetic against doubles I wrote. A double agrees with whatever I
 * believed when I wrote it, which is exactly the belief under test. Everything that has actually
 * gone wrong on this chain went wrong at the seam with somebody else's contract: a curve that wants
 * `quoteIn == msg.value` to the wei, a `graduated()` that flips and takes `buy` with it, a launch
 * record whose fields are not in the order a doc page claims.
 *
 * ➤ So this makes a REAL launch on the REAL factory and drives the real curve.
 *
 *   node scripts/rpc-proxy.mjs &
 *   forge test --match-path test/CreatorRouterFork.t.sol -vv
 */
contract CreatorRouterForkTest is Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /* ⛔ NOT anvil's dev accounts: on this chain those are real addresses with real history and a
       balance asserted against one can move underneath the test. These exist nowhere. */
    address constant CHARITY = 0x00000000000000000000000000000000caFe0001;
    address constant CREATOR = 0x00000000000000000000000000000000CaFe0003;
    address constant WALLET = 0x00000000000000000000000000000000caFe0004;
    address constant SIGNER = 0x00000000000000000000000000000000caFe0005;

    uint256 constant X_ACCOUNT_ID = 1234567890;
    bytes32 constant X_BENEFICIARY = keccak256("x:1234567890");
    bytes32 constant CHARITY_ID = keccak256("a-charity");

    CharityLaunchpadV2 pad;
    CharityFeeClaims claims;

    function setUp() public {
        try vm.createSelectFork(vm.envOr("RHC_RPC", string("http://127.0.0.1:8899"))) {}
        catch { vm.skip(true); return; }

        /* ⛔ (owner, signer) — the deploy script had these the wrong way round once, and this test did
           not catch it because it never read them back. It does now. */
        claims = new CharityFeeClaims(address(this), SIGNER);
        require(claims.owner() == address(this) && claims.signer() == SIGNER, "claims wired backwards");
        /* ⚠ Three contracts, and the order is forced: the launchpad needs the factory's address at
           construction, so the factory exists first. Same shape as the real deploy script. */
        CreatorRouterFactory routers = new CreatorRouterFactory();
        pad = new CharityLaunchpadV2(
            IPonsV2Factory(PONS_FACTORY), IPoolManager(POOL_MANAGER), USDG, 200, 5_000,
            address(claims), address(routers)
        );
    }

    /// 50% charity, then the remainder 50 wallet / 30 X account / 20 burn.
    function _splits() internal pure returns (CreatorRouter.Split[] memory s) {
        s = new CreatorRouter.Split[](3);
        s[0] = CreatorRouter.Split(CreatorRouter.Mode.Wallet, 5000, WALLET, bytes32(0), 0, 0);
        s[1] = CreatorRouter.Split(CreatorRouter.Mode.XAccount, 3000, address(0), X_BENEFICIARY, 1, X_ACCOUNT_ID);
        s[2] = CreatorRouter.Split(CreatorRouter.Mode.Burn, 2000, address(0), bytes32(0), 0, 0);
    }

    function _launch()
        internal
        returns (address token, address curve, address distributor, address router)
    {
        uint256 fee = IPonsV2Factory(PONS_FACTORY).launchFee();
        vm.deal(CREATOR, fee + 10 ether);

        IPonsV2Factory.LaunchParams memory p;
        p.name = "Router Rehearsal";
        p.symbol = "RRH";

        CharityLaunchpadV2.CharityTerms memory terms = CharityLaunchpadV2.CharityTerms({
            charity: CHARITY,
            charityId: CHARITY_ID,
            creatorPayout: WALLET,
            charityBps: 5_000,
            splits: _splits()
        });

        vm.prank(CREATOR);
        (token, curve, distributor, router) = pad.launchWithBuy{value: fee}(
            p, 0, address(0), terms,
            CharityLaunchpadV2.DevBuy({quoteIn: 0, minTokensOut: 0}),
            new address[](0)
        );
    }

    /**
     * ⭐⭐ THE ONE THAT MATTERS: a real launch, all three legs paid, and a real buy-and-burn on the
     * real curve that actually reduces `totalSupply`.
     */
    function test_aRealLaunchSplitsThreeWaysAndBurnsOnTheRealCurve() public {
        (address token,, address distributor, address router) = _launch();

        assertTrue(router != address(0), "a router was deployed");
        assertEq(CreatorRouter(payable(router)).token(), token, "bound to its own launch");
        assertEq(CharityDistributorV2(payable(distributor)).opsVault(), router, "distributor pays the router");

        /* A fee arriving. Sent directly rather than traded up: `_release` works off the balance on
           purpose, so a donation and a fee are the same thing to it — which is the property being
           relied on here, not a shortcut around one. */
        vm.deal(address(this), 1 ether);
        (bool ok,) = distributor.call{value: 1 ether}("");
        assertTrue(ok, "the distributor took the fee");

        CharityDistributorV2(payable(distributor)).release(address(0));

        assertEq(CHARITY.balance, 0.5 ether, "the charity's half went straight out");
        assertEq(router.balance, 0.5 ether, "the creator's half reached the router");

        CreatorRouter(payable(router)).distribute(address(0));

        assertEq(WALLET.balance, 0.25 ether, "wallet: 50% of the remainder");
        assertEq(claims.claimable(token, X_BENEFICIARY, address(0)), 0.15 ether, "X account: 30%");
        assertEq(CreatorRouter(payable(router)).burnReserve(address(0)), 0.1 ether, "burn: 20%");

        uint256 supplyBefore = IERC20Meta(token).totalSupply();
        (uint256 bought, uint256 burned) = CreatorRouter(payable(router)).buyAndBurn(0);

        console.log("bought off the real curve", bought);
        console.log("burned                   ", burned);
        console.log("supply before            ", supplyBefore);
        console.log("supply after             ", IERC20Meta(token).totalSupply());

        assertGt(bought, 0, "the real curve sold us tokens");
        assertEq(burned, bought, "everything bought was burned");
        /* ⛔⛔ ASSERTS THE SUPPLY FELL, not that tokens moved to a dead address. A plain transfer to
           0xdEaD leaves `totalSupply` untouched for ever and every holder still sees the old number
           — this repo has shipped that mistake once already. */
        assertLt(IERC20Meta(token).totalSupply(), supplyBefore, "totalSupply actually FELL");
        assertEq(IERC20Meta(token).balanceOf(router), 0, "the router kept none of it");
    }

    /// ⭐ A launch that wants none of this pays no gas for it and gets no router.
    function test_aLaunchWithNoSplitsDeploysNoRouter() public {
        uint256 fee = IPonsV2Factory(PONS_FACTORY).launchFee();
        vm.deal(CREATOR, fee + 1 ether);

        IPonsV2Factory.LaunchParams memory p;
        p.name = "No Router";
        p.symbol = "NRT";

        vm.prank(CREATOR);
        (address token,, address distributor, address router) =
            pad.launch{value: fee}(p, 0, address(0), CHARITY, CHARITY_ID, WALLET, 5_000);

        assertEq(router, address(0), "no router");
        assertEq(CharityDistributorV2(payable(distributor)).opsVault(), WALLET, "paid straight to the wallet");
        assertTrue(token != address(0));
    }
}
