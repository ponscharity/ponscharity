// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CharityDistributorV2} from "../src/CharityDistributorV2.sol";
import {IPonsFeeEscrow} from "../src/CharityDistributor.sol";
import {IPoolManager} from "../src/V4Seller.sol";

contract Erc20 {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
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
        Erc20(t).transfer(msg.sender, a);
    }
}

/**
 * V2's one behavioural change: the split happens when the fee ARRIVES, so the creator's half leaves
 * in whatever asset it arrived in and only the charity's half waits to be sold.
 *
 * ⛔⛔ EVERY TEST HERE IS ABOUT ONE HAZARD — SPLITTING THE SAME MONEY TWICE. V1 could not have this
 * bug because it split once, after the sale. V2 splits before, so the sale must NOT split again, and
 * `_release` must never see the reserved half. Both directions are checked below, because getting
 * either wrong pays one party out of the other's money and nothing reverts to say so.
 */
contract CharityDistributorV2Test is Test {
    MockEscrow escrow;
    Erc20 stock;
    Erc20 usdg;

    address constant CHARITY = 0x00000000000000000000000000000000caFe0001;
    address constant ROUTER = 0x00000000000000000000000000000000caFe0002;

    CharityDistributorV2 d;

    function setUp() public {
        escrow = new MockEscrow();
        stock = new Erc20();
        usdg = new Erc20();
        // 60% charity / 40% creator, so the two halves are told apart by their size.
        d = new CharityDistributorV2(
            IPonsFeeEscrow(address(escrow)), CHARITY, ROUTER, 6_000,
            IPoolManager(address(0)), address(usdg), 200
        );
    }

    /* ------------------------------------------------------- a bridgeable asset -- */

    /// Native is payable to both sides, so nothing is reserved and V2 behaves exactly like V1.
    function test_nativeFeesArePaidToBothSidesImmediately() public {
        vm.deal(address(this), 10 ether);
        escrow.credit{value: 10 ether}(address(d));
        d.harvest();

        assertEq(CHARITY.balance, 6 ether, "charity");
        assertEq(ROUTER.balance, 4 ether, "creator router");
        assertEq(address(d).balance, 0, "nothing held back");
        assertEq(d.reservedForCharity(address(0)), 0, "nothing reserved");
    }

    /* --------------------------------------------------- an asset that cannot leave -- */

    /**
     * ⭐⭐ THE POINT OF V2. The router is paid in the STOCK, at once — it can spend one on the
     * launch's own curve. The charity's share is reserved, because no bridge will carry it.
     */
    function test_aStockPaysTheCreatorNowAndReservesTheCharitysHalf() public {
        stock.mint(address(escrow), 100e18);
        escrow.creditToken(address(d), address(stock), 100e18);
        d.harvestToken(address(stock));

        assertEq(stock.balanceOf(ROUTER), 40e18, "the creator's half left as the stock");
        assertEq(d.reservedForCharity(address(stock)), 60e18, "the charity's half is reserved");
        assertEq(stock.balanceOf(address(d)), 60e18, "and is still physically here");
        assertEq(d.totalToOps(address(stock)), 40e18);
        assertEq(d.totalToCharity(address(stock)), 0, "not credited to the charity until it is sold");
    }

    /**
     * ⛔⛔ THE BUG THIS SHAPE PREVENTS. `release` is public and permissionless. If the reserved half
     * were still visible to `_release`, anyone could call it repeatedly and hand the creator 40% of
     * the charity's money on every call until the reserve was gone.
     */
    function test_releasingAgainCannotPayTheCreatorOutOfTheReservedHalf() public {
        stock.mint(address(escrow), 100e18);
        escrow.creditToken(address(d), address(stock), 100e18);
        d.harvestToken(address(stock));

        d.release(address(stock));
        d.release(address(stock));
        d.release(address(stock));

        assertEq(stock.balanceOf(ROUTER), 40e18, "the creator was NOT paid again");
        assertEq(d.reservedForCharity(address(stock)), 60e18, "the reserve is untouched");
    }

    /// A second fee reserves on top of the first rather than replacing it.
    function test_asecondStockFeeAddsToTheReserve() public {
        stock.mint(address(escrow), 200e18);
        escrow.creditToken(address(d), address(stock), 100e18);
        d.harvestToken(address(stock));
        escrow.creditToken(address(d), address(stock), 100e18);
        d.harvestToken(address(stock));

        assertEq(stock.balanceOf(ROUTER), 80e18);
        assertEq(d.reservedForCharity(address(stock)), 120e18);
    }

    /**
     * ⛔⛔ AND THE OTHER DIRECTION. V1's `sellAllForUsdg` ended in `_release(usdg)`, which under V2
     * would take a second 40% cut for the creator out of the charity's own proceeds. Those entry
     * points are gone, and their absence is asserted rather than assumed — a wrapper someone adds
     * back later for convenience would reintroduce exactly that.
     */
    function test_theV1SellEntryPointsAreGone() public view {
        // `sellAllForUsdg(address,uint24,int24,uint256)` and `sellForUsdg(address,uint24,int24,uint256,uint256)`
        bytes4 sellAll = bytes4(keccak256("sellAllForUsdg(address,uint24,int24,uint256)"));
        bytes4 sellSome = bytes4(keccak256("sellForUsdg(address,uint24,int24,uint256,uint256)"));
        assertFalse(_hasSelector(address(d), sellAll), "sellAllForUsdg must not exist on V2");
        assertFalse(_hasSelector(address(d), sellSome), "sellForUsdg must not exist on V2");
        assertTrue(
            _hasSelector(address(d), bytes4(keccak256("sellReservedForUsdg(address,uint24,int24,uint256)"))),
            "sellReservedForUsdg is the replacement and must exist"
        );
    }

    function test_sellingWithNothingReservedIsRefused() public {
        vm.expectRevert(CharityDistributorV2.NothingReserved.selector);
        d.sellReservedForUsdg(address(stock), 3000, 60, 0);
    }

    /* ---------------------------------------------------------------- the split -- */

    /// ⭐ Dust lands on the charity's side, as in V1 — the ops side is the one that rounds down.
    function test_dustFavoursTheCharity() public {
        vm.deal(address(this), 1 wei);
        escrow.credit{value: 1 wei}(address(d));
        d.harvest();
        assertEq(CHARITY.balance, 1, "the odd wei went to the charity");
        assertEq(ROUTER.balance, 0);
    }

    /// ⛔ Searches the runtime bytecode for a 4-byte selector, the way this repo checks a deployed
    /// contract's interface rather than trusting a header file.
    function _hasSelector(address a, bytes4 sel) private view returns (bool) {
        bytes memory code = a.code;
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }
}
