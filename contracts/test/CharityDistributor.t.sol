// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {CharityDistributor, IPonsFeeEscrow} from "../src/CharityDistributor.sol";
import {V4Seller, IPoolManager} from "../src/V4Seller.sol";

/// ⚠ Six decimals and NO RETURN VALUE — the shape that makes a bare `IERC20.transfer` revert on a
/// decode rather than on a transfer, indistinguishable in the logs. USDG is what this mostly holds.
contract NoReturnToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    constructor(uint8 d) { decimals = d; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }
}

contract MockEscrow is IPonsFeeEscrow {
    mapping(address => uint256) public nativeOf;
    mapping(address => mapping(address => uint256)) public tokenOf;
    function credit(address to) external payable { nativeOf[to] += msg.value; }
    function creditToken(address to, address t, uint256 a) external { tokenOf[to][t] += a; }
    function balanceOf(address r) external view returns (uint256) { return nativeOf[r]; }
    function balanceOfToken(address r, address t) external view returns (uint256) { return tokenOf[r][t]; }
    function claim() external returns (uint256 a) {
        a = nativeOf[msg.sender]; require(a != 0, "NothingToClaim"); nativeOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}(""); require(ok, "send");
    }
    function claimToken(address t) external returns (uint256 a) {
        a = tokenOf[msg.sender][t]; require(a != 0, "NothingToClaim"); tokenOf[msg.sender][t] = 0;
        NoReturnToken(t).transfer(msg.sender, a);
    }
}

interface IUnlockCallback { function unlockCallback(bytes calldata) external returns (bytes memory); }

/**
 * Enough of the v4 singleton to exercise the real thing: `extsload` off a computed slot, the
 * unlock/callback dance, a packed `BalanceDelta`, and sync/settle/take.
 *
 * ⚠ It does NOT reimplement v4's swap maths. Output is a rate the test sets, so what is under test
 * is the WIRING — the delta sign convention, the settlement, and the slippage floor — rather than a
 * second copy of Uniswap that could agree with a wrong reading of the first.
 */
contract MockPoolManager {
    mapping(bytes32 => bytes32) public store;
    uint256 public outPerWholeStock; // USDG out per 1e18 stock in
    address public stockToken;

    function seed(address c0, address c1, uint24 fee, int24 ts, uint160 sq, uint128 liq) external {
        bytes32 id = keccak256(abi.encode(c0, c1, fee, ts, address(0)));
        bytes32 base = keccak256(abi.encode(id, uint256(6)));
        store[base] = bytes32(uint256(sq));
        store[bytes32(uint256(base) + 3)] = bytes32(uint256(liq));
    }
    function setFill(address stock, uint256 outPer) external { stockToken = stock; outPerWholeStock = outPer; }
    function extsload(bytes32 slot) external view returns (bytes32) { return store[slot]; }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(IPoolManager.PoolKey memory key, IPoolManager.SwapParams memory p, bytes calldata)
        external view returns (int256)
    {
        uint256 amountIn = uint256(-p.amountSpecified);
        uint256 out = Math.mulDiv(amountIn, outPerWholeStock, 1e18);
        int128 a0; int128 a1;
        if (p.zeroForOne) { a0 = -int128(int256(amountIn)); a1 = int128(int256(out)); }
        else { a1 = -int128(int256(amountIn)); a0 = int128(int256(out)); }
        key; // silence
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    address public synced; uint256 public syncedBefore;
    function sync(address c) external { synced = c; syncedBefore = NoReturnToken(c).balanceOf(address(this)); }
    function settle() external payable returns (uint256 paid) {
        paid = NoReturnToken(synced).balanceOf(address(this)) - syncedBefore;
        require(paid != 0, "settled nothing");
    }
    function take(address c, address to, uint256 amount) external { NoReturnToken(c).transfer(to, amount); }
}

contract CharityDistributorTest is Test {
    MockEscrow escrow;
    MockPoolManager pm;
    NoReturnToken usdg;
    NoReturnToken aapl;
    CharityDistributor d;

    address charity = address(0xC4A217);
    address ops = address(0x09501);

    uint24 constant FEE = 3000;
    int24 constant TS = 60;
    uint256 constant PRICE_USD = 100; // $100 a share

    function setUp() public {
        escrow = new MockEscrow();
        pm = new MockPoolManager();
        usdg = new NoReturnToken(6);
        aapl = new NoReturnToken(18);
        d = new CharityDistributor(
            IPonsFeeEscrow(address(escrow)), charity, ops, 9_000,
            IPoolManager(address(pm)), address(usdg), 200 // 2% max slippage
        );
        _seedPool();
    }

    /// sqrtPriceX96 for "1e18 stock = 100e6 USDG", whichever way round the addresses sort.
    function _seedPool() internal {
        bool stockIsZero = uint160(address(aapl)) < uint160(address(usdg));
        (address c0, address c1) = stockIsZero ? (address(aapl), address(usdg)) : (address(usdg), address(aapl));
        // price = amount1/amount0, raw
        (uint256 num, uint256 den) = stockIsZero ? (PRICE_USD * 1e6, uint256(1e18)) : (uint256(1e18), PRICE_USD * 1e6);
        uint160 sq = uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
        pm.seed(c0, c1, FEE, TS, sq, 1e24);
        pm.setFill(address(aapl), PRICE_USD * 1e6); // a perfect fill, for now
    }

    /* ------------------------------------------------------------ the basics -- */

    function test_nativeFeesReachTheCharity() public {
        vm.deal(address(this), 10 ether);
        escrow.credit{value: 1 ether}(address(d));
        d.harvest();
        assertEq(charity.balance, 0.9 ether);
        assertEq(ops.balance, 0.1 ether);
        assertEq(address(d).balance, 0, "nothing may rest in the distributor");
    }

    function test_usdgFeesReachTheCharity_andNativeStaysZero() public {
        usdg.mint(address(escrow), 1_000e6);
        escrow.creditToken(address(d), address(usdg), 1_000e6);
        assertEq(d.pending(address(0)), 0, "native reads zero for a USDG launch, forever");
        d.harvestToken(address(usdg));
        assertEq(usdg.balanceOf(charity), 900e6);
        assertEq(usdg.balanceOf(ops), 100e6);
    }

    function test_harvestingNothingIsQuietAndCheap() public {
        d.harvest();
        d.harvestToken(address(usdg));
        assertEq(charity.balance, 0);
    }

    function test_roundingFavoursTheCharity() public {
        vm.deal(address(this), 1 ether);
        escrow.credit{value: 9_999}(address(d));
        d.harvest();
        assertEq(ops.balance, 999);
        assertEq(charity.balance, 9_000, "the dust went to the charity");
    }

    function test_directDonationsSplitTheSameWay() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(d).call{value: 1 ether}(""); assertTrue(ok);
        d.release(address(0));
        assertEq(charity.balance, 0.9 ether);
    }

    /* --------------------------------------------- stocks: sell, then bridge -- */

    /// ⛔⛔ The stranding bug, made unreachable. A harvested stock is HELD, never pushed to a vault.
    function test_aHarvestedStockIsHeldNotPushed() public {
        aapl.mint(address(escrow), 10e18);
        escrow.creditToken(address(d), address(aapl), 10e18);
        d.harvestToken(address(aapl));
        assertEq(aapl.balanceOf(address(d)), 10e18, "held for sale");
        assertEq(aapl.balanceOf(charity), 0, "a stock must NEVER reach a vault - no bridge takes it");
    }

    function test_anUnbridgeableAssetCannotBePaidOutAtAll() public {
        aapl.mint(address(d), 1e18);
        vm.expectRevert(CharityDistributor.NotPayable.selector);
        d.release(address(aapl));
    }

    function test_sellingAStockPaysTheCharityInUsdg() public {
        aapl.mint(address(escrow), 10e18);
        escrow.creditToken(address(d), address(aapl), 10e18);
        d.harvestToken(address(aapl));
        usdg.mint(address(pm), 10_000e6); // the pool's side of the trade

        uint256 out = d.sellAllForUsdg(address(aapl), FEE, TS, 990e6);

        assertEq(out, 1_000e6, "10 shares at $100");
        assertEq(usdg.balanceOf(charity), 900e6);
        assertEq(usdg.balanceOf(ops), 100e6);
        assertEq(aapl.balanceOf(address(d)), 0, "the stock was fully sold");
        assertEq(usdg.balanceOf(address(d)), 0, "and the proceeds left in the same transaction");
    }

    /// ⭐ The spot quote must survive `sqrtPriceX96` squaring, which overflows uint256 naively.
    function test_spotQuoteIsRightInBothOrderings() public view {
        assertApproxEqRel(d.quoteSpot(address(aapl), FEE, TS, 1e18), 100e6, 1e12, "1 share = $100");
        assertApproxEqRel(d.quoteSpot(address(aapl), FEE, TS, 250e18), 25_000e6, 1e12);
    }

    /* ------------------------------------------------------- the sell guards -- */

    /// 🔴🔴 A permissionless sell that trusts a caller's `minOut` is a free sandwich.
    function test_aLooseMinOutIsRefused() public {
        aapl.mint(address(d), 10e18);
        usdg.mint(address(pm), 10_000e6);
        /* ⚠ The floor is derived, not typed: seeding the mock's price goes through an integer
           sqrt, so a hardcoded 980e6 is off by one unit in 1e9 and the test fails on rounding
           rather than on behaviour. Assert the RELATIONSHIP the contract promises. */
        uint256 floorOut = (d.quoteSpot(address(aapl), FEE, TS, 10e18) * 9_800) / 10_000;
        vm.expectRevert(abi.encodeWithSelector(V4Seller.SlippageTooLoose.selector, uint256(0), floorOut));
        d.sellAllForUsdg(address(aapl), FEE, TS, 0);
        assertApproxEqRel(floorOut, 980e6, 1e12, "2% under a $1,000 sale");
    }

    function test_aCallerMayAlwaysAskForMoreThanTheFloor() public {
        aapl.mint(address(d), 10e18);
        usdg.mint(address(pm), 10_000e6);
        d.sellAllForUsdg(address(aapl), FEE, TS, 1_000e6); // exactly spot, tighter than the floor
        assertEq(usdg.balanceOf(charity), 900e6);
    }

    function test_aBadFillIsRejectedEvenWhenTheFloorPassed() public {
        aapl.mint(address(d), 10e18);
        usdg.mint(address(pm), 10_000e6);
        pm.setFill(address(aapl), 95e6); // the pool fills 5% under spot
        vm.expectRevert(abi.encodeWithSelector(V4Seller.SoldTooCheap.selector, uint256(950e6), uint256(985e6)));
        d.sellAllForUsdg(address(aapl), FEE, TS, 985e6); // passes the 2% floor, fails the real one
    }

    /// ⛔⛔ MSTR/USDG is initialised at fee=100 on RHC and holds ZERO liquidity. Priced, but empty.
    function test_anInitialisedButEmptyPoolIsALoudFailure() public {
        NoReturnToken mstr = new NoReturnToken(18);
        bool z = uint160(address(mstr)) < uint160(address(usdg));
        (address c0, address c1) = z ? (address(mstr), address(usdg)) : (address(usdg), address(mstr));
        pm.seed(c0, c1, FEE, TS, uint160(1 << 96), 0); // priced, but empty
        mstr.mint(address(d), 1e18);
        vm.expectRevert(V4Seller.NoLiquidity.selector);
        d.sellAllForUsdg(address(mstr), FEE, TS, 1);
    }

    function test_anUninitialisedPoolIsALoudFailure() public {
        NoReturnToken nope = new NoReturnToken(18);
        nope.mint(address(d), 1e18);
        vm.expectRevert(V4Seller.PoolNotInitialised.selector);
        d.sellAllForUsdg(address(nope), FEE, TS, 1);
    }

    function test_usdgCannotBeSoldForItself() public {
        vm.expectRevert(V4Seller.NotSellable.selector);
        d.sellAllForUsdg(address(usdg), FEE, TS, 1);
    }

    function test_theUnlockCallbackIsClosedToEveryoneButThePoolManager() public {
        vm.expectRevert(V4Seller.NotPoolManager.selector);
        d.unlockCallback("");
    }

    /* --------------------------------------------------------- immutability -- */

    function test_thereIsNoWayToChangeTheDestination() public view {
        assertEq(d.charityVault(), charity);
        assertEq(d.charityBps(), 9_000);
        assertEq(d.usdg(), address(usdg));
        // ⚠ Asserted by the ABI, not by a call: `immutable` + no setter means no selector exists to
        // try. If a future edit adds one, this file will not fail — a reviewer must catch it.
    }

    function test_hundredPercentToCharityIsAllowed() public {
        CharityDistributor full = new CharityDistributor(
            IPonsFeeEscrow(address(escrow)), charity, address(0), 10_000,
            IPoolManager(address(pm)), address(usdg), 200
        );
        vm.deal(address(this), 1 ether);
        escrow.credit{value: 1 ether}(address(full));
        full.harvest();
        assertEq(charity.balance, 1 ether);
    }

    function test_aSplitOverOneHundredPercentIsRefused() public {
        vm.expectRevert(CharityDistributor.BadSplit.selector);
        new CharityDistributor(IPonsFeeEscrow(address(escrow)), charity, ops, 10_001,
            IPoolManager(address(pm)), address(usdg), 200);
    }

    function test_aPayableRemainderNeedsAnOpsVault() public {
        vm.expectRevert(CharityDistributor.ZeroAddress.selector);
        new CharityDistributor(IPonsFeeEscrow(address(escrow)), charity, address(0), 9_000,
            IPoolManager(address(pm)), address(usdg), 200);
    }
}
