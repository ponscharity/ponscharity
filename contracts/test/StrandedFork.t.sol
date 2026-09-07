// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityDistributor} from "../src/CharityDistributor.sol";
import {V4Seller} from "../src/V4Seller.sol";

interface IERC20Meta {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * The rehearsal for wiring `sell.ts` into the keeper, run against the **LIVE, ALREADY-DEPLOYED**
 * distributors that are holding real stranded fees right now.
 *
 * ## ⛔⛔ WHY THIS IS NOT `Fork.t.sol`
 *
 * `Fork.t.sol` deploys a FRESH `CharityDistributor` from local source and sells `deal`t balances
 * through it. That proves the contract this repo can compile is correct. It proves **nothing** about
 * the twelve distributors the launchpad actually deployed, whose bytecode was frozen weeks ago and
 * which are the only ones holding money. Those are what the keeper would be calling.
 *
 * ➤ So every address below is read off chain, nothing is deployed, and the amounts are whatever the
 * escrow really owes at the forked block. A `deal` anywhere in here would defeat the purpose.
 *
 * ## What it proves, in the order the keeper would do it
 *
 * 1. `harvestToken(stock)` on a live distributor SUCCEEDS and the stock lands in the distributor —
 *    it is held, not pushed at `charityVault` where no bridge would take it.
 * 2. A tier can be found by simulation for the real balance, at the real size.
 * 3. `sellAllForUsdg` converts it and pushes USDG through the split to the REAL charity vault.
 *
 *   node scripts/rpc-proxy.mjs &
 *   forge test --match-path test/StrandedFork.t.sol -vv
 */
contract StrandedForkTest is Test {
    address constant VAULT = 0x7F954db64FeC530C679c6b093a139eFB8089D7D2;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /**
     * The five launches with a non-zero escrow balance, read from `page()` on the launchpad
     * `0xF1755477…EeEfE3` and confirmed by simulating `harvestToken` against each, 6 Sep 2026.
     *
     * ⚠ The amounts are NOT asserted. They are fee balances on a live chain and they move; pinning
     * them would make this suite fail on a day somebody traded. What is asserted is the PROPERTY —
     * that whatever is there can be harvested, sold and delivered.
     */
    struct Position {
        address distributor;
        address stock;
        string label;
    }

    Position[] positions;

    function setUp() public {
        try vm.createSelectFork(vm.envOr("RHC_RPC", string("http://127.0.0.1:8899"))) {}
        catch { vm.skip(true); return; }

        positions.push(Position(0x7F6c6FdDa4C8632F62407494A86650f4199e647B, 0x1b0E319c6A659F002271B69dB8A7df2F911c153E, "GME"));
        positions.push(Position(0xd856a64E66f52bA0349A10B3128902Aa3113419C, 0x1D11f0496982706C5e14A514D4E79F2e6BdE4516, "DJT-a"));
        positions.push(Position(0xa884639Bd3803e4D4a2d9ABe2494b818CC637D4d, 0x1D11f0496982706C5e14A514D4E79F2e6BdE4516, "DJT-b"));
        positions.push(Position(0xa24533B97F9A18c39a5676886D43B3B86Eb46741, 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, "SPCX-a"));
        positions.push(Position(0xE6810d90c086c6565eB8C8e0429cc9eFdCD71Ef7, 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, "SPCX-b"));
    }

    /**
     * ⭐⭐ THE ONE THAT UNBLOCKS THE WHOLE CHANGE.
     *
     * The keeper refuses to harvest a stock-paired launch, on the belief that `harvest` "does not
     * merely claim, it PUSHES the charity's share into RemitVault". That was true of an earlier
     * contract. If it is still true of the DEPLOYED one, wiring the sell path strands money the
     * first time it runs, so it is checked here against the deployed bytecode rather than reasoned
     * about from source.
     */
    function test_harvestingAStockOnALiveDistributorHoldsItRatherThanPushingIt() public {
        for (uint256 i = 0; i < positions.length; i++) {
            Position memory p = positions[i];
            CharityDistributor d = CharityDistributor(payable(p.distributor));

            uint256 vaultBefore = IERC20Meta(p.stock).balanceOf(VAULT);
            uint256 heldBefore = IERC20Meta(p.stock).balanceOf(p.distributor);

            uint256 gained = d.harvestToken(p.stock);

            assertEq(
                IERC20Meta(p.stock).balanceOf(p.distributor) - heldBefore,
                gained,
                string.concat(p.label, ": the harvest did not land in the distributor")
            );
            assertEq(
                IERC20Meta(p.stock).balanceOf(VAULT),
                vaultBefore,
                string.concat(p.label, ": a stock reached the vault, which cannot bridge it")
            );

            console.log(p.label);
            console.log("  harvested (18dp)", gained);
        }
    }

    /**
     * The full path, per position: harvest, find a tier by simulation, sell, and check the charity
     * vault's USDG actually rose.
     *
     * ⚠ Reports rather than asserts a sale for every position. A pool with no depth for a real
     * balance is a true answer about the market, not a broken contract — and the keeper has to
     * handle it either way. What is asserted is that a sale which REPORTS success moved USDG.
     */
    function test_theStrandedBalancesCanActuallyReachTheVaultAsUsdg() public {
        uint256 delivered;
        uint256 sold;

        for (uint256 i = 0; i < positions.length; i++) {
            Position memory p = positions[i];
            CharityDistributor d = CharityDistributor(payable(p.distributor));

            d.harvestToken(p.stock);
            uint256 balance = IERC20Meta(p.stock).balanceOf(p.distributor);
            if (balance == 0) { console.log(string.concat(p.label, ": nothing harvestable")); continue; }

            (uint24 fee, int24 ts, uint256 simulated) = _bestTier(d, p.stock, balance);
            if (simulated == 0) {
                console.log(string.concat(p.label, ": NO TIER CAN SELL THIS"));
                console.log("  balance (18dp) ", balance);
                continue;
            }

            uint256 vaultBefore = IERC20Meta(USDG).balanceOf(VAULT);
            uint256 got = d.sellAllForUsdg(p.stock, fee, ts, (simulated * 9_950) / 10_000);
            uint256 rose = IERC20Meta(USDG).balanceOf(VAULT) - vaultBefore;

            assertGt(got, 0, string.concat(p.label, ": the sell reported zero"));
            assertGt(rose, 0, string.concat(p.label, ": USDG never reached the vault"));

            sold++;
            delivered += rose;

            console.log(p.label);
            console.log("  balance (18dp)  ", balance);
            console.log("  fee tier        ", fee);
            console.log("  USDG out (6dp)  ", got);
            console.log("  to VAULT (6dp)  ", rose);
        }

        console.log("positions sold  ", sold);
        console.log("USDG to vault   ", delivered);
        assertGt(sold, 0, "not one stranded position could be sold");
    }

    /**
     * ⛔⛔ THE SIZE IS THE WHOLE QUESTION FOR A THIN POOL. `sell.ts` has `findMaxTranche` precisely
     * because GME refuses a balance it cannot fill. This reports, for each position, whether the
     * REAL balance fits in one trade — which is what decides whether the keeper needs tranching on
     * day one or only later.
     */
    function test_whetherTheRealBalancesFitInOneTrade() public {
        for (uint256 i = 0; i < positions.length; i++) {
            Position memory p = positions[i];
            CharityDistributor d = CharityDistributor(payable(p.distributor));
            d.harvestToken(p.stock);
            uint256 balance = IERC20Meta(p.stock).balanceOf(p.distributor);
            if (balance == 0) continue;

            (uint24 fee, int24 ts, uint256 whole) = _bestTier(d, p.stock, balance);

            console.log(p.label);
            console.log("  whole balance fills", whole > 0);
            /* ⛔⛔ PROBED WITH `sellForUsdg`, NOT `sellAllForUsdg`. `sellAll` ignores the size you
               priced and sells the WHOLE held balance, so flooring a half-size quote and calling it
               trips `SlippageTooLoose` — the contract refusing a floor far under its own spot, not
               the pool refusing the trade. Probing that way reported "half does not fit" for all
               five positions, which is arithmetically impossible and was purely this harness. */
            if (whole > 0) {
                console.log("  half  balance fills", _fits(d, p.stock, fee, ts, balance / 2));
            }
        }
    }

    /// Whether one tranche of exactly `amount` clears the pool, priced and floored at that size.
    function _fits(CharityDistributor d, address stock, uint24 fee, int24 ts, uint256 amount)
        internal
        returns (bool ok)
    {
        if (amount == 0) return false;
        uint256 snap = vm.snapshotState();
        try d.quoteSpot(stock, fee, ts, amount) returns (uint256 spot) {
            try d.sellForUsdg(stock, fee, ts, amount, (spot * 9_800) / 10_000) returns (uint256 out) {
                ok = out > 0;
            } catch { ok = false; }
        } catch { ok = false; }
        vm.revertToState(snap);
    }

    function _bestTier(CharityDistributor d, address stock, uint256 amount)
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
