// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

interface IRelay {
    function donateNative(bytes32 configId, uint256 tipBps, address creditedTo, bytes calldata message) external payable;
    function donateToken(bytes32 configId, address token, uint256 amountIn, uint256 tipBps, address creditedTo, bytes calldata message) external;
}
interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/**
 * The last mile, executed rather than assumed: a real USDC donation to a real charity through
 * donate.gg's public relay, on a fork of Base.
 *
 * ⛔⛔ WHY THIS TEST EXISTS. Everything upstream of it was proven — fees accrue, stocks sell,
 * Relay bridges — but "and then the charity is paid" was a simulation of `donateNative` and a
 * reading of their docs. If `donateToken` reverts on an approval quirk, or the relay rejects a
 * config id we scraped, every launch made through this site would earn fees that stop one hop short
 * of the charity, and we would find out from a charity rather than from a test.
 */
contract DonateRelayTest is Test {
    address constant RELAY = 0x02A0d2a39732082b824a5A3D3b026C54d581DCC8;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC on Base

    /// St. Jude, read from donate.gg's own API.
    bytes32 constant ST_JUDE = 0xdc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46;
    /// WaterAid.
    bytes32 constant WATERAID = 0x883716acf0f34171c0fa754ceea2df902091e62da1655bd57d1894355d8455ba;

    address constant DONOR = 0x00000000000000000000000000000000cafE0009;

    function setUp() public {
        try vm.createSelectFork(vm.envOr("BASE_RPC", string("http://127.0.0.1:8546"))) {}
        catch { vm.skip(true); return; }
    }

    /// ⭐⭐ The one that matters: real USDC actually leaves and the relay accepts it.
    function test_aRealUsdcDonationGoesThrough() public {
        uint256 amount = 250e6; // 250 USDC, six decimals
        deal(USDC, DONOR, amount);
        assertEq(IERC20(USDC).balanceOf(DONOR), amount, "deal did not take");

        vm.startPrank(DONOR);
        IERC20(USDC).approve(RELAY, amount);
        IRelay(RELAY).donateToken(ST_JUDE, USDC, amount, 0, DONOR, "");
        vm.stopPrank();

        // ⚠ The donor's balance falling is the proof. The relay pools per epoch and settles later,
        // so asserting the charity's own balance here would assert something that has not happened
        // yet and would fail for the right reasons at the wrong time.
        assertEq(IERC20(USDC).balanceOf(DONOR), 0, "the USDC did not leave the donor");
        console.log("donated 250 USDC to St. Jude through the relay");
    }

    function test_aSecondCharityAlsoWorks() public {
        uint256 amount = 100e6;
        deal(USDC, DONOR, amount);
        vm.startPrank(DONOR);
        IERC20(USDC).approve(RELAY, amount);
        IRelay(RELAY).donateToken(WATERAID, USDC, amount, 0, DONOR, "");
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(DONOR), 0);
    }

    /// ⭐ Native ETH is the other route the remit can take.
    function test_aNativeDonationGoesThrough() public {
        vm.deal(DONOR, 1 ether);
        vm.prank(DONOR);
        IRelay(RELAY).donateNative{value: 0.5 ether}(ST_JUDE, 0, DONOR, "");
        assertEq(DONOR.balance, 0.5 ether);
    }

    /**
     * ⛔⛔ THE FINDING THAT SHAPES EVERYTHING UPSTREAM: an id belonging to nobody is ACCEPTED.
     *
     * This is not a bug to fix, it is a property to design around. The relay takes any bytes32 and
     * the transaction succeeds, so a mistyped or invented config id sends real money into an epoch
     * that will never settle to anyone, and the transaction looks exactly like a successful
     * donation. Nothing downstream can catch it. It is why config ids are read from donate.gg's own
     * API and never typed.
     */
    function test_anInventedConfigIdIsAcceptedWhichIsWhyProvenanceMatters() public {
        uint256 amount = 10e6;
        deal(USDC, DONOR, amount);
        vm.startPrank(DONOR);
        IERC20(USDC).approve(RELAY, amount);
        IRelay(RELAY).donateToken(bytes32(uint256(0xdeadbeef)), USDC, amount, 0, DONOR, "");
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(DONOR), 0, "it took the money for an id that means nothing");
    }
}
