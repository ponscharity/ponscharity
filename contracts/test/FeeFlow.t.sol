// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityLaunchpad, IPonsV2Factory} from "../src/CharityLaunchpad.sol";
import {CharityDistributor, IPonsFeeEscrow} from "../src/CharityDistributor.sol";
import {IPoolManager} from "../src/V4Seller.sol";

interface ICurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    /* ⛔ `sweepFees(uint256)`, NOT `sweepFees()`. The argument is the slippage floor for the buyback
       leg. A no-arg version compiles fine, is a different selector, and reverts with no data, which
       is indistinguishable from a permission failure. */
    function sweepFees(uint256 minBuybackTokensOut) external;
    function getReserves() external view returns (uint256, uint256);
}
interface IERC20 { function balanceOf(address) external view returns (uint256); function approve(address,uint256) external returns (bool); }

/**
 * The whole money path, executed on a fork of live Robinhood Chain: launch, trade, sweep, harvest,
 * and the charity's share landing in the vault.
 *
 * ⛔⛔ WHY THIS IS SEPARATE FROM THE UNIT TESTS. Those prove the distributor splits what it is given,
 * against a mock escrow written by the same hand. This proves that a REAL trade on a REAL Pons curve
 * produces fees that a REAL escrow hands over. Every step between "somebody buys the token" and
 * "the charity's share exists" is somebody else's contract, and the only way to know they connect is
 * to make them connect.
 */
contract FeeFlowTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address constant VAULT = 0x00000000000000000000000000000000caFe0001;
    address constant CREATOR = 0x00000000000000000000000000000000caFe0002;
    address constant LAUNCHER = 0x00000000000000000000000000000000CaFe0003;
    address constant TRADER = 0x00000000000000000000000000000000caFe0004;
    bytes32 constant ST_JUDE = 0xdc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46;

    CharityLaunchpad pad;
    IPonsV2Factory f = IPonsV2Factory(FACTORY);

    function setUp() public {
        try vm.createSelectFork(vm.envOr("RHC_RPC", string("http://127.0.0.1:8899"))) {}
        catch { vm.skip(true); return; }
        pad = new CharityLaunchpad(f, IPoolManager(POOL_MANAGER), USDG, 200, 5_000);
    }

    function test_aRealTradeProducesFeesThatReachTheVault() public {
        // ── launch ────────────────────────────────────────────────────────────────────────────
        IPonsV2Factory.LaunchParams memory p;
        p.name = "Fee Flow";
        p.symbol = "FLOW";
        p.socials = IPonsV2Factory.Socials("", "", "", "", "");
        p.expectedEconomics = f.previewLaunchEconomics(0, address(0));
        p.salt = keccak256("fee-flow-1");

        vm.deal(LAUNCHER, 1 ether);
        vm.prank(LAUNCHER);
        (address token, address curve, address dist) =
            pad.launch{value: f.launchFee()}(p, 0, address(0), VAULT, ST_JUDE, CREATOR, 9_000);

        // ── somebody buys ─────────────────────────────────────────────────────────────────────
        vm.deal(TRADER, 20 ether);
        vm.prank(TRADER);
        ICurve(curve).buy{value: 10 ether}(10 ether, 0, TRADER);
        uint256 bought = IERC20(token).balanceOf(TRADER);
        assertGt(bought, 0, "the buy produced no tokens");

        // ── and sells, because a fee is charged on both legs ───────────────────────────────────
        vm.startPrank(TRADER);
        IERC20(token).approve(curve, bought);
        ICurve(curve).sell(bought / 2, 0, TRADER);
        vm.stopPrank();

        /*
          ⚠⚠ THE SWEEP IS A SEPARATE STEP AND IT IS NOT OURS. Fees accrue on the curve and reach the
          escrow only when somebody sweeps. A test that harvested without sweeping would read zero
          and look like a broken distributor, when the money simply had not moved yet.
        */
        /*
          ⛔⛔ `sweepFees` IS PERMISSIONED, and it reverts `NotFeeSweepOperator()` for everyone but
          Pons's own operator and THIS LAUNCH'S FEE RECIPIENT. The fee recipient is the distributor,
          so the distributor is the only party on our side that may sweep.
        */
        /* ⭐⭐ Swept THROUGH the distributor by a stranger, which is the whole reason the passthrough
           exists: no key of ours is involved anywhere in the chain from trade to payout. */
        vm.prank(address(0xbeef));
        CharityDistributor(payable(dist)).sweepCurve(curve, 0);

        uint256 owed = CharityDistributor(payable(dist)).pending(address(0));
        console.log("swept into the escrow for this launch (wei):", owed);
        assertGt(owed, 0, "trading produced no claimable fees");

        // ── harvest: permissionless, so anybody can trigger the payout ─────────────────────────
        uint256 vaultBefore = VAULT.balance;
        uint256 creatorBefore = CREATOR.balance;
        vm.prank(address(0xdead)); // ⭐ a stranger, to prove it needs no privileged key
        CharityDistributor(payable(dist)).harvest();

        uint256 toCharity = VAULT.balance - vaultBefore;
        uint256 toCreator = CREATOR.balance - creatorBefore;
        console.log("to the charity vault (wei):", toCharity);
        console.log("to the creator (wei):     ", toCreator);

        assertGt(toCharity, 0, "the charity share never arrived");
        assertEq(toCharity + toCreator, owed, "every wei was split and pushed");
        // 90/10, with the division dust falling on the charity side.
        assertEq(toCreator, (owed * 1_000) / 10_000, "the creator got exactly its tenth");
        assertEq(CharityDistributor(payable(dist)).totalToCharity(address(0)), toCharity, "the ledger agrees");
        assertEq(address(dist).balance, 0, "nothing rested in the distributor");
    }
}
