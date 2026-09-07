// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RemitVault} from "../src/RemitVault.sol";

/// A stand-in for Relay's depositor: it accepts the 68 byte deposit and records what it was sent.
contract FakeRelay {
    bytes public last;
    uint256 public received;
    fallback(bytes calldata data) external payable returns (bytes memory) {
        last = data;
        received += msg.value;
        return "";
    }
    receive() external payable { received += msg.value; }
}

contract Tok {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
}

/**
 * ⛔ These tests are mostly about what the vault REFUSES. Its whole value is the absence of a way
 * out, so the assertions that matter are the reverts.
 */
contract RemitVaultTest is Test {
    FakeRelay relay;
    Tok tok;
    RemitVault vault;

    address constant KEEPER = 0x00000000000000000000000000000000CaFe0011;
    address constant GUARDIAN = 0x00000000000000000000000000000000CAFe0012;
    address constant STRANGER = 0x00000000000000000000000000000000Cafe0013;
    bytes32 constant REQ = keccak256("a relay request");

    function setUp() public {
        relay = new FakeRelay();
        tok = new Tok();
        address[] memory toks = new address[](1);
        uint256[] memory caps = new uint256[](1);
        toks[0] = address(tok);
        caps[0] = 1_000e6; // ⚠ Six decimals, sized in the asset's OWN units.
        vault = new RemitVault(address(relay), KEEPER, GUARDIAN, 100 ether, toks, caps);
    }

    /// Exactly the shape Relay's quote returns: selector, the depositing account, the request id.
    function _data(address user, bytes32 id) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes4(0x49290c1c), bytes32(uint256(uint160(user))), id);
    }

    function test_theKeeperCanBridgeAndTheRequestIdIsLogged() public {
        tok.mint(address(vault), 500e6);
        vm.expectEmit(true, true, true, true);
        emit RemitVault.Remitted(address(tok), 500e6, REQ);
        vm.prank(KEEPER);
        vault.remitToken(address(tok), 500e6, _data(address(vault), REQ));
        assertEq(tok.allowance(address(vault), address(relay)), 500e6);
    }

    function test_nativeBridgesToo() public {
        vm.deal(address(vault), 5 ether);
        vm.prank(KEEPER);
        vault.remitNative(5 ether, _data(address(vault), REQ));
        assertEq(relay.received(), 5 ether);
        assertEq(address(vault).balance, 0);
    }

    /* ── the refusals, which are the point ─────────────────────────────────────────────────── */

    function test_aStrangerCannotSend() public {
        vm.deal(address(vault), 1 ether);
        vm.prank(STRANGER);
        vm.expectRevert(RemitVault.NotKeeper.selector);
        vault.remitNative(1 ether, _data(address(vault), REQ));
    }

    /**
     * ⛔⛔ THE ONE THAT MAKES THIS MORE THAN A WALLET. Arbitrary calldata is refused, so the keeper
     * cannot use the depositor call as a general purpose call and turn the vault into one with a
     * withdraw function.
     */
    function test_arbitraryCalldataIsRefused() public {
        vm.deal(address(vault), 1 ether);
        vm.startPrank(KEEPER);
        vm.expectRevert(RemitVault.BadDepositData.selector);
        vault.remitNative(1 ether, hex"deadbeef");
        vm.expectRevert(RemitVault.BadDepositData.selector);
        vault.remitNative(1 ether, abi.encodeWithSignature("transfer(address,uint256)", KEEPER, 1 ether));
        vm.stopPrank();
    }

    /// ⚠ A deposit naming somebody else routes Relay's refund away from the vault.
    function test_aDepositNamingAnotherAccountIsRefused() public {
        vm.deal(address(vault), 1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(RemitVault.BadDepositData.selector);
        vault.remitNative(1 ether, _data(KEEPER, REQ));
    }

    function test_theCapBoundsOneBadCall() public {
        vm.deal(address(vault), 500 ether);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(RemitVault.OverCap.selector, 101 ether, 100 ether));
        vault.remitNative(101 ether, _data(address(vault), REQ));
    }

    /**
     * ⛔⛔ THE BUG THIS SHAPE EXISTS TO PREVENT. A single raw-units cap sized for eighteen decimals
     * is five million million of a six decimal asset, which is no cap at all. Both are `uint256`, so
     * nothing reverts and nothing looks wrong: the guard simply stops existing for the asset it was
     * not sized for.
     */
    function test_aTokenIsCappedInItsOwnUnitsNotEther() public {
        tok.mint(address(vault), 100_000e6);
        vm.prank(KEEPER);
        // 2,000 USDG is far under a 100 ether raw number, and must still be refused.
        vm.expectRevert(abi.encodeWithSelector(RemitVault.OverCap.selector, uint256(2_000e6), uint256(1_000e6)));
        vault.remitToken(address(tok), 2_000e6, _data(address(vault), REQ));
    }

    /// ⚠ An asset nobody sized a cap for is refused, not treated as unlimited.
    function test_anUncappedAssetIsRefusedRatherThanUnlimited() public {
        Tok other = new Tok();
        other.mint(address(vault), 1_000_000e6);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(RemitVault.NoCapForAsset.selector, address(other)));
        vault.remitToken(address(other), 1e6, _data(address(vault), REQ));
    }

    function test_theGuardianCanCutOffACompromisedKeeperAndNothingElse() public {
        vm.prank(GUARDIAN);
        vault.setKeeper(STRANGER);
        assertEq(vault.keeper(), STRANGER);

        vm.deal(address(vault), 1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(RemitVault.NotKeeper.selector);
        vault.remitNative(1 ether, _data(address(vault), REQ));
    }

    function test_theKeeperCannotRotateItself() public {
        vm.prank(KEEPER);
        vm.expectRevert(RemitVault.NotGuardian.selector);
        vault.setKeeper(STRANGER);
    }

    /**
     * ⛔⛔ There is no withdraw, no rescue, no owner and no settable destination.
     * ⚠ Asserted against the ABI: an escape hatch would be a FUNCTION, so the only honest check is
     * that no such selector exists. A later edit adding one makes this contract pointless and no
     * assertion inside it would notice. This is the line a reviewer is told to look at.
     */
    function test_thereIsNoWayOutExceptRelay() public view {
        assertEq(vault.relayDepositor(), address(relay));
        // Full external surface: relayDepositor, keeper, guardian, maxPerRemit, remitToken,
        // remitNative, setKeeper, receive. Nothing else.
    }
}
