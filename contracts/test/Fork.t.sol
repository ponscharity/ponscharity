// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityDistributor, IPonsFeeEscrow} from "../src/CharityDistributor.sol";
import {V4Seller, IPoolManager} from "../src/V4Seller.sol";

interface IERC20Meta {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * The rehearsal against real Robinhood Chain state.
 *
 * ## ⛔⛔ WHY A MOCK WAS NEVER GOING TO BE ENOUGH
 *
 * `MockPoolManager` in the unit tests is a v4 singleton written by the same hand that wrote the
 * code calling it. If the `BalanceDelta` sign convention is read backwards, the mock packs it
 * backwards too and every test passes — the exact failure that shipped live on the stonks indexer,
 * where a v4 `Swap` read with v3's pool-perspective labelled every buy a sell and nothing on screen
 * looked wrong. A mock proves the wiring is self-consistent. Only the real singleton proves it is
 * RIGHT.
 *
 * ## ⚠⚠ Run it through the loopback proxy, not against the RPC directly
 *
 * Cloudflare 403s Foundry's User-Agent. `cast` takes `--rpc-headers`; **forge does not**, and
 * `ETH_RPC_HEADERS` does not reach the fork backend. See `scripts/rpc-proxy.mjs`.
 *
 *   node scripts/rpc-proxy.mjs &
 *   forge test --match-path test/Fork.t.sol -vv
 */
contract ForkTest is Test {
    /* Live addresses, read off chain rather than pasted from docs. */
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e; // factory.feeEscrow()
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;

    /**
     * ⛔⛔ NOT anvil's dev accounts. On this chain those are REAL addresses with real history, and a
     * balance asserted against one can change underneath the test — a trap this repo has already
     * been bitten by. These two are chosen to exist nowhere.
     */
    address constant CHARITY = 0x00000000000000000000000000000000caFe0001;
    address constant OPS = 0x00000000000000000000000000000000caFe0002;

    CharityDistributor d;

    function setUp() public {
        /* ⚠ Skips rather than fails when the proxy is not up. A fork suite that breaks the default
           `forge test` for everyone without a running proxy gets excluded from CI, and a suite
           nobody runs is worse than no suite. Start it with `node scripts/rpc-proxy.mjs &`. */
        try vm.createSelectFork(vm.envOr("RHC_RPC", string("http://127.0.0.1:8899"))) {}
        catch { vm.skip(true); return; }
        d = new CharityDistributor(
            IPonsFeeEscrow(FEE_ESCROW), CHARITY, OPS, 9_000,
            IPoolManager(POOL_MANAGER), USDG, 200
        );
    }

    /// The real escrow answers the interface this contract was written against.
    function test_theRealEscrowMatchesTheInterface() public view {
        assertEq(d.pending(address(0)), 0, "a fresh recipient is owed nothing");
        assertEq(d.pending(USDG), 0);
    }

    /**
     * ⭐⭐ THE ONE THAT MATTERS: a real swap, on the real singleton, against real liquidity.
     *
     * Proves in one shot the delta sign convention, the exact-input encoding, sync/settle/take, the
     * hookless pool key, and the decimals — 18dp stock in, 6dp USDG out.
     */
    function test_sellingRealAaplForRealUsdg() public {
        _sellAndAssert(AAPL, 5e18);
    }

    function test_sellingRealSpy() public { _sellAndAssert(SPY, 2e18); }
    function test_sellingRealNvda() public { _sellAndAssert(NVDA, 5e18); }
    /**
     * ⛔⛔ A THIN POOL HAS A CEILING, AND IT IS SMALL.
     *
     * Measured on the fork: GME/USDG at `fee=10000` fills 0.1 / 0.5 / 1 / 5 shares fine (~$17.90 a
     * share) and REFUSES 20 — not because the pool is empty but because the price impact exceeds
     * the 2% the contract will accept. Selling a GME fee balance therefore has to be TRANCHED; a
     * service that tries the whole balance and gives up sells nothing, forever, and looks healthy
     * doing it. See `sizeTranches` in `remit/src/sell.ts`.
     */
    function test_sellingRealGme_withinWhatTheThinPoolTakes() public { _sellAndAssert(GME, 5e18); }

    /**
     * A size the book cannot fill is refused rather than filled at any price.
     *
     * ⚠⚠ THE SIZE IS DELIBERATELY ABSURD, AND IT USED NOT TO BE. This asserted 20 GME, measured
     * against a pool that then refused it. The pool has since deepened — `fee=10000` now holds real
     * liquidity where it held almost none — so 20 shares fill comfortably and the test began failing
     * with "next call did not revert as expected". Nothing about the contract had changed.
     *
     * ➤ A test pinned to a live pool's depth is a test that fails on a day the market moved. What is
     * being asserted is the PROPERTY, that price impact past the book trips the slippage floor, so
     * the size is now far beyond any depth this pool will plausibly reach. ⛔ `fee=3000` is still
     * initialised holding zero, which is why the tier is named rather than discovered.
     */
    function test_gmeRefusesAnOversizedSale() public {
        uint256 absurd = 2_000_000e18;
        deal(GME, address(d), absurd);
        uint256 spot = d.quoteSpot(GME, 10000, 200, absurd);
        vm.expectPartialRevert(V4Seller.SoldTooCheap.selector);
        d.sellAllForUsdg(GME, 10000, 200, (spot * 9_800) / 10_000);
    }

    function _sellAndAssert(address stock, uint256 amount) internal {
        deal(stock, address(d), amount);
        assertEq(IERC20Meta(stock).balanceOf(address(d)), amount, "deal did not take");

        (uint24 fee, int24 ts, uint256 simulated) = _bestTier(stock, amount);
        assertGt(simulated, 0, "no tier could sell this");

        // ⭐ The service's discipline, exercised here: simulate, then floor the simulation.
        uint256 minOut = (simulated * 9_950) / 10_000;
        uint256 got = d.sellAllForUsdg(stock, fee, ts, minOut);

        uint256 toCharity = IERC20Meta(USDG).balanceOf(CHARITY);
        uint256 toOps = IERC20Meta(USDG).balanceOf(OPS);

        console.log(IERC20Meta(stock).symbol());
        console.log("  fee tier        ", fee);
        console.log("  USDG out (6dp)  ", got);
        console.log("  to charity      ", toCharity);
        console.log("  to ops          ", toOps);

        assertGe(got, minOut, "filled under the floor");
        assertEq(toCharity + toOps, got, "every unit was split and pushed");
        assertEq(toCharity, got - (got * 1_000) / 10_000, "90% and the dust");
        assertEq(IERC20Meta(stock).balanceOf(address(d)), 0, "the whole balance sold");
        assertEq(IERC20Meta(USDG).balanceOf(address(d)), 0, "nothing rested in the distributor");

        // ⚠ Sanity on the DECIMALS, not just the plumbing: a 5-share sale of a real equity is worth
        // tens or hundreds of dollars. A units bug lands orders of magnitude away from that.
        uint256 usd = got / 1e6;
        assertGt(usd, 10, "suspiciously cheap - check decimals");
        assertLt(usd, 1_000_000, "suspiciously dear - check decimals");
    }

    /**
     * ⛔⛔ PRICED, BUT EMPTY — and the two failure modes are DIFFERENT reverts.
     *
     * A tier that was never initialised reverts `PoolNotInitialised`; one that is initialised and
     * holds nothing reverts `NoLiquidity`. A caller that expects one and gets the other concludes
     * the wrong thing about the market.
     *
     * ⚠⚠ THE TIER COUNT USED TO BE ASSERTED HERE AND IT WAS WRONG TO. This read
     * `assertEq(initialised, 1)` on the strength of a measurement taken 28 Aug 2026 — and by 6 Sep
     * MSTR was initialised at TWO tiers, so the suite went red without one line of this repo
     * changing. A number describing somebody else's live order book is not a fact a test may pin:
     * it is a reading, and it moves.
     *
     * ➤ So what is asserted is the PROPERTY the code depends on — that every initialised MSTR tier
     * is empty, so nothing can sell it — plus the two reverts, discovered rather than named. The day
     * MSTR genuinely gains depth this test fails on the assertion that says so, which is the failure
     * worth having.
     */
    function test_mstrIsPricedButEmpty() public {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        int24[4] memory tss = [int24(1), 10, 60, 200];

        uint256 initialised;
        uint256 emptyTier = type(uint256).max;
        uint256 absentTier = type(uint256).max;

        for (uint256 i = 0; i < 4; i++) {
            (uint160 sq, uint128 liq) = d.poolState(MSTR, fees[i], tss[i]);
            if (sq != 0) {
                initialised++;
                assertEq(liq, 0, "MSTR GAINED LIQUIDITY - it may be sellable now, revisit `remit`");
                if (emptyTier == type(uint256).max) emptyTier = i;
            } else if (absentTier == type(uint256).max) {
                absentTier = i;
            }
        }

        assertGt(initialised, 0, "MSTR is priced somewhere, or this test is about nothing");
        assertTrue(absentTier != type(uint256).max, "no uninitialised tier left to check the other revert");

        deal(MSTR, address(d), 1e18);
        vm.expectRevert(V4Seller.NoLiquidity.selector);
        d.sellAllForUsdg(MSTR, fees[emptyTier], tss[emptyTier], 1);      // priced, empty
        vm.expectRevert(V4Seller.PoolNotInitialised.selector);
        d.sellAllForUsdg(MSTR, fees[absentTier], tss[absentTier], 1);    // not there at all
    }

    /// 🔴🔴 The guard that matters most, proven against a real pool rather than a mock.
    function test_aLooseMinOutIsRefusedOnARealPool() public {
        deal(AAPL, address(d), 1e18);
        (uint24 fee, int24 ts,) = _bestTier(AAPL, 1e18);
        vm.expectPartialRevert(V4Seller.SlippageTooLoose.selector);
        d.sellAllForUsdg(AAPL, fee, ts, 0);
    }

    /// ⛔ A stock must never be payable, on any chain state.
    function test_aRealStockCannotBePaidOut() public {
        deal(AAPL, address(d), 1e18);
        vm.expectRevert(CharityDistributor.NotPayable.selector);
        d.release(AAPL);
    }

    /**
     * Simulate every candidate tier and keep the best fill — the same rule `sell.ts` applies.
     *
     * ⚠⚠ Simulated at the CONTRACT'S OWN floor, never at zero. Zero is rejected by
     * `SlippageTooLoose` before the swap runs, so probing at zero reports every tier dead and the
     * stock looks unsellable — a total failure that looks exactly like an illiquid market.
     */
    function _bestTier(address stock, uint256 amount)
        internal
        returns (uint24 bestFee, int24 bestTs, uint256 bestOut)
    {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        int24[4] memory tss = [int24(1), 10, 60, 200];
        for (uint256 i = 0; i < 4; i++) {
            uint256 snap = vm.snapshotState();
            try d.quoteSpot(stock, fees[i], tss[i], amount) returns (uint256 spot) {
                uint256 floorOut = (spot * 9_800) / 10_000;
                try d.sellAllForUsdg(stock, fees[i], tss[i], floorOut) returns (uint256 out) {
                    if (out > bestOut) { bestOut = out; bestFee = fees[i]; bestTs = tss[i]; }
                } catch { /* thin tier */ }
            } catch { /* uninitialised or empty */ }
            vm.revertToState(snap);
        }
    }
}
