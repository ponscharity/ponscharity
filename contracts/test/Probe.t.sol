// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityDistributor, IPonsFeeEscrow} from "../src/CharityDistributor.sol";
import {V4Seller, IPoolManager} from "../src/V4Seller.sol";

interface IERC20Meta { function balanceOf(address) external view returns (uint256); }

/// Diagnostics against live state. Not assertions about behaviour — measurements of the market.
contract ProbeTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address constant CHARITY = 0x00000000000000000000000000000000caFe0001;
    address constant OPS = 0x00000000000000000000000000000000caFe0002;

    CharityDistributor d;
    uint24[4] fees = [uint24(100), 500, 3000, 10000];
    int24[4] tss = [int24(1), 10, 60, 200];

    function setUp() public {
        try vm.createSelectFork(vm.envOr("RHC_RPC", string("http://127.0.0.1:8899"))) {}
        catch { vm.skip(true); return; }
        d = new CharityDistributor(IPonsFeeEscrow(FEE_ESCROW), CHARITY, OPS, 9_000,
            IPoolManager(POOL_MANAGER), USDG, 200);
    }

    function test_probeMstrTiers() public view {
        console.log("MSTR/USDG tiers:");
        for (uint256 i = 0; i < 4; i++) {
            (uint160 sq, uint128 liq) = d.poolState(MSTR, fees[i], tss[i]);
            console.log("  fee", fees[i]);
            console.log("    sqrtPriceX96 (0 = uninitialised)", sq);
            console.log("    liquidity", liq);
        }
    }

    function test_probeGmeCapacity() public {
        console.log("GME/USDG tiers:");
        for (uint256 i = 0; i < 4; i++) {
            (uint160 sq, uint128 liq) = d.poolState(GME, fees[i], tss[i]);
            console.log("  fee", fees[i]);
            console.log("    sq", sq);
            console.log("    liq", liq);
        }
        console.log("how much GME can actually be sold, per tier:");
        uint256[6] memory sizes = [uint256(1e17), 5e17, 1e18, 5e18, 2e19, 5e19];
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = 0; j < 6; j++) {
                uint256 snap = vm.snapshotState();
                deal(GME, address(d), sizes[j]);
                try d.quoteSpot(GME, fees[i], tss[i], sizes[j]) returns (uint256 spot) {
                    try d.sellAllForUsdg(GME, fees[i], tss[i], (spot * 9_800) / 10_000) returns (uint256 out) {
                        console.log("  OK   fee", fees[i]);
                        console.log("       shares(e18)", sizes[j] / 1e16);
                        console.log("       usdg out", out);
                    } catch { console.log("  fail fee", fees[i]); console.log("       shares(e16)", sizes[j] / 1e16); }
                } catch { console.log("  no pool fee", fees[i]); }
                vm.revertToState(snap);
            }
        }
    }
}
