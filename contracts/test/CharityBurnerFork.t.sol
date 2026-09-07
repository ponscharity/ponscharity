// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityBurner} from "../src/CharityBurner.sol";

interface IERC20Meta {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/**
 * The burner, driven against $CHARITY's REAL live Uniswap V4 pool on Robinhood Chain.
 *
 * ## ⛔⛔ WHY A FORK TEST AND NOT A MOCK
 *
 * A mocked pool manager agrees with whatever I believed about V4 when I wrote it, and that belief
 * is the thing under test. The BalanceDelta sign convention, the sync/settle/take order, whether
 * Pons's hook lets an outside buyer through at all — every one of those is a seam with somebody
 * else's contract, and every bug this stack has actually shipped lived at such a seam.
 *
 *   node scripts/rpc-proxy.mjs &
 *   forge test --match-path test/CharityBurnerFork.t.sol -vv
 */
contract CharityBurnerForkTest is Test {
    address constant TOKEN = 0x030FA758daD53f0D6e23cfD3a8Fe7bC7B54E5Ac9; // $CHARITY
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant NATIVE = address(0);
    uint24 constant POOL_FEE = 0;
    int24 constant TICK_SPACING = 200;

    /* ⛔ NOT anvil's dev accounts: on this chain those are real addresses with real history, and a
       balance asserted against one can move underneath the test. This exists nowhere. */
    address constant FUNDER = 0x00000000000000000000000000000000CaFe0011;

    CharityBurner burner;

    function setUp() public {
        try vm.createSelectFork(vm.envOr("RHC_RPC", string("http://127.0.0.1:8899"))) {}
        catch {
            vm.skip(true);
            return;
        }
        burner = new CharityBurner(TOKEN, NATIVE, POOL_MANAGER, HOOK, POOL_FEE, TICK_SPACING);
    }

    /**
     * ⭐⭐ THE WHOLE POINT. Buy on the live pool, and assert the token's `totalSupply` FELL.
     *
     * ⛔⛔ Asserting that tokens landed on `0xdEaD` would be the wrong test and would have passed on
     * $CAT, whose 29.37M "burn" was a transfer — supply never moved and never will. Supply is the
     * only figure that cannot be faked by moving tokens around.
     */
    function test_buysOnLivePoolAndSupplyFalls() public {
        uint256 supplyBefore = IERC20Meta(TOKEN).totalSupply();

        vm.deal(FUNDER, 1 ether);
        vm.prank(FUNDER);
        (bool sent,) = address(burner).call{value: 0.01 ether}("");
        assertTrue(sent, "burner must accept a plain send");

        (uint256 pairHeld,) = burner.pending();
        assertEq(pairHeld, 0.01 ether, "funding did not land");

        /* ⚠ Simulate first and floor at 99% of it, which is what the keeper is expected to do.
           Passing a floor derived from the same call it protects would be theatre, so this reverts
           the probe and reuses only the quantity. */
        uint256 quoted = _quote();
        assertGt(quoted, 0, "live pool quoted nothing - no liquidity?");

        (uint256 bought, uint256 burned) = burner.buyAndBurn((quoted * 99) / 100);

        assertGt(bought, 0, "bought nothing");
        assertEq(burned, bought, "everything bought must be burned");
        assertEq(IERC20Meta(TOKEN).balanceOf(address(burner)), 0, "burner must hold no tokens after");
        assertEq(address(burner).balance, 0, "burner must have spent the whole balance");

        uint256 supplyAfter = IERC20Meta(TOKEN).totalSupply();
        assertEq(supplyBefore - supplyAfter, burned, unicode"⛔ SUPPLY DID NOT FALL BY THE BURN");

        assertEq(burner.totalBurned(), burned, "counter");
        assertEq(burner.totalPairSpent(), 0.01 ether, "counter");

        console.log("burned tokens :", burned);
        console.log("supply before :", supplyBefore);
        console.log("supply after  :", supplyAfter);
    }

    /// A probe buy in a reverted branch, purely to size the floor.
    function _quote() private returns (uint256 out) {
        uint256 snap = vm.snapshot();
        CharityBurner probe =
            new CharityBurner(TOKEN, NATIVE, POOL_MANAGER, HOOK, POOL_FEE, TICK_SPACING);
        vm.deal(address(probe), 0.01 ether);
        (out,) = probe.buyAndBurn(1);
        vm.revertTo(snap);
    }

    /**
     * ⭐ The token side of a Pons sweep needs no swap. Fees arrive in BOTH currencies, and routing
     * $CHARITY through a buy would pay slippage to end up holding what we already held.
     */
    function test_burnHeldTorchesTokensWithoutTouchingThePool() public {
        deal(TOKEN, address(burner), 1_000e18);
        uint256 supplyBefore = IERC20Meta(TOKEN).totalSupply();

        uint256 burned = burner.burnHeld();

        assertEq(burned, 1_000e18);
        assertEq(supplyBefore - IERC20Meta(TOKEN).totalSupply(), 1_000e18, "supply must fall");
        assertEq(IERC20Meta(TOKEN).balanceOf(address(burner)), 0);
    }

    /// ⛔ A permissionless standing buy with no floor is a sandwich invitation. Rejected outright.
    function test_zeroFloorIsRejected() public {
        vm.deal(address(burner), 0.01 ether);
        vm.expectRevert(CharityBurner.NoFloor.selector);
        burner.buyAndBurn(0);
    }

    function test_emptyBurnerReverts() public {
        vm.expectRevert(CharityBurner.NothingToBurn.selector);
        burner.buyAndBurn(1);

        vm.expectRevert(CharityBurner.NothingToBurn.selector);
        burner.burnHeld();
    }

    /// ⛔ Only the pool manager may drive the callback, even though V4 already guarantees it.
    function test_unlockCallbackIsPoolManagerOnly() public {
        vm.prank(FUNDER);
        vm.expectRevert(CharityBurner.NotPoolManager.selector);
        burner.unlockCallback(abi.encode(uint256(1)));
    }

    /**
     * ⛔⛔ THE GUARANTEE, ASSERTED AS A PROPERTY RATHER THAN READ OFF THE SOURCE.
     *
     * The reason anyone should be willing to send money here is that there is no way to get it out
     * again. A reviewer can satisfy themselves of that by reading the file; this asserts it against
     * the compiled artifact, so a later edit that quietly adds an escape hatch fails the suite.
     */
    function test_noEscapeHatchExistsInTheBytecode() public view {
        bytes memory code = address(burner).code;
        string[9] memory forbidden = [
            "withdraw(uint256)",
            "withdraw()",
            "rescue(address,uint256)",
            "sweep(address)",
            "owner()",
            "transferOwnership(address)",
            "setPairToken(address)",
            "upgradeTo(address)",
            "execute(address,uint256,bytes)"
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            bytes4 sel = bytes4(keccak256(bytes(forbidden[i])));
            assertFalse(_contains(code, sel), forbidden[i]);
        }
    }

    function _contains(bytes memory haystack, bytes4 sel) private pure returns (bool) {
        if (haystack.length < 4) return false;
        for (uint256 i = 0; i + 4 <= haystack.length; i++) {
            if (
                haystack[i] == sel[0] && haystack[i + 1] == sel[1] && haystack[i + 2] == sel[2]
                    && haystack[i + 3] == sel[3]
            ) return true;
        }
        return false;
    }

    /// ⚠ Native ETH must sort below the token for the pool key to match the live pool.
    function test_poolKeyOrientationMatchesTheLivePool() public view {
        assertTrue(uint160(NATIVE) < uint160(TOKEN), "native must be currency0 here");
    }
}
