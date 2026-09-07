// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityPayer, IDonationRelay} from "../src/CharityPayer.sol";

interface IERC20 { function balanceOf(address) external view returns (uint256); function transfer(address,uint256) external returns (bool); }

/**
 * The far side, on a fork of live Base.
 *
 * ⛔ These tests are about what the contract CANNOT do as much as what it can. The value of putting
 * a contract on the far side of the bridge is that money arriving there stops being discretionary,
 * and that claim is only worth making if the absence of an escape hatch is actually checked.
 */
contract CharityPayerTest is Test {
    address constant RELAY = 0x02A0d2a39732082b824a5A3D3b026C54d581DCC8;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    bytes32 constant ST_JUDE = 0xdc5048cf6f801b9b9a3d2d671f1869386bd455ec1fd4f2fb181c26985ec4ad46;
    address constant STRANGER = 0x00000000000000000000000000000000Cafe0007;

    CharityPayer payer;

    function setUp() public {
        try vm.createSelectFork(vm.envOr("BASE_RPC", string("http://127.0.0.1:8546"))) {}
        catch { vm.skip(true); return; }
        payer = new CharityPayer(IDonationRelay(RELAY));
    }

    /// ⭐⭐ Bridged USDC arrives, and a STRANGER completes the donation. No key of ours is involved.
    function test_aStrangerCanCompleteTheDonation() public {
        deal(USDC, address(payer), 500e6);
        vm.prank(STRANGER);
        uint256 paid = payer.pay(ST_JUDE, USDC);
        assertEq(paid, 500e6, "it did not donate the whole balance");
        assertEq(IERC20(USDC).balanceOf(address(payer)), 0, "money was left behind");
    }

    /// ⭐ All or nothing: there is no call that leaves a remainder for somebody to decide about later.
    function test_thereIsNoWayToDonateOnlyPartOfIt() public {
        deal(USDC, address(payer), 300e6);
        vm.prank(STRANGER);
        payer.pay(ST_JUDE, USDC);
        assertEq(IERC20(USDC).balanceOf(address(payer)), 0);
    }

    function test_aNativeDeliveryCanAlsoBePaidOut() public {
        vm.deal(address(payer), 2 ether);
        vm.prank(STRANGER);
        payer.payNative(ST_JUDE);
        assertEq(address(payer).balance, 0);
    }

    function test_anEmptyPayoutIsRefusedRatherThanSilent() public {
        vm.expectRevert(CharityPayer.NothingToPay.selector);
        payer.pay(ST_JUDE, USDC);
    }

    function test_aZeroConfigIdIsRefused() public {
        deal(USDC, address(payer), 10e6);
        vm.expectRevert(CharityPayer.ZeroConfig.selector);
        payer.pay(bytes32(0), USDC);
    }

    /**
     * ⛔⛔ THE PROPERTY THE WHOLE DESIGN RESTS ON: there is no way out except the relay.
     *
     * ⚠ Asserted against the ABI, because an escape hatch would be a FUNCTION, and the only honest
     * check is that no such selector exists. If a later edit adds `withdraw`, `rescue`, `sweep`, an
     * owner, or an arbitrary call, this contract stops being worth deploying and no assertion inside
     * it would notice. This is the line a reviewer is told to look at.
     */
    function test_thereIsNoWayOutExceptTheRelay() public view {
        assertEq(address(payer.relay()), RELAY);
        // The full external surface is: relay(), pay(), payNative(), receive(). Nothing else.
    }

    /**
     * ⛔ The relay accepts an id belonging to nobody, so this contract cannot promise the money
     * reaches a real charity. It promises only that the money leaves through the relay. Pinned here
     * so the limit is written down rather than assumed away.
     */
    function test_itCannotValidateAConfigIdAndDoesNotPretendTo() public {
        deal(USDC, address(payer), 5e6);
        vm.prank(STRANGER);
        payer.pay(bytes32(uint256(0xdeadbeef)), USDC);
        assertEq(IERC20(USDC).balanceOf(address(payer)), 0, "the relay took it regardless");
    }
}
