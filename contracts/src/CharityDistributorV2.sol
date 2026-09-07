// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Pons V2's fee escrow.
 *
 * ⚠⚠ TWO LEDGERS, AND A LAUNCH ONLY EVER LANDS IN ONE. `_balances[recipient]` holds native ETH;
 * ⭐⭐ V2 — THE SPLIT NOW HAPPENS WHEN THE FEE ARRIVES, NOT AFTER THE SALE.
 *
 * V1 refused to pay ANYTHING that was not native ETH or USDG, because the only destination was the
 * charity vault and no bridge carries a tokenized stock off this chain. So a stock-paired launch
 * had to be sold to USDG before a single wei could move, and both halves of the fee went through
 * that sale.
 *
 * That is right for the charity's half and wrong for the creator's. {CreatorRouter} can spend a
 * stock exactly where it is — the launch's own bonding curve takes the very asset the launch is
 * priced in — so making it wait for a sale to USDG means selling AAPL and then buying AAPL back to
 * reach the curve: three swaps where one will do, paying an LP fee and price impact twice over.
 *
 * ➤ So `_release` now pays the ops side in WHATEVER ASSET ARRIVED, immediately, and reserves the
 * charity's share to be sold. The payout allowlist that made V1 safe is unchanged in substance —
 * it just applies to the leg it was written for. Nothing unbridgeable can still reach the charity
 * vault; see {_release}.
 *
 * ⛔ V1 is NOT superseded on chain. Every one of the 182 launches made before this points at a V1
 * distributor, immutably. This is what NEW launches get.
 *
 * `_tokenBalances[recipient][token]` holds everything else. A launch paired against USDG credits
 * ONLY the token ledger and its native `balanceOf` reads zero forever. This contract therefore
 * harvests both sides and never infers one from the other.
 *
 * ⚠ Both claims pay `msg.sender` and take no recipient. There is no claiming on behalf of anyone —
 * which is the whole reason this is a contract rather than a script pointed at a wallet: to be paid,
 * it must BE the fee recipient, so it must be able to call `claim` itself.
 *
 * ⚠ Pons REVERTS rather than returning zero when there is nothing to claim, so every call here is
 * wrapped. Unguarded, a harvest would revert for the entire window between trades.
 */
/*
  ⛔ THE INTERFACES ARE IMPORTED FROM V1, NOT REDECLARED HERE.

  A copy would compile and would be a DIFFERENT TYPE with the same name, so every call site that
  holds one has to know which file it came from, and a test that builds an escrow for V1 cannot hand
  it to V2. Worse, the two could drift: a signature corrected in one file and not the other is a
  mismatch the compiler cannot see, against contracts that are not verified on Blockscout and whose
  signatures were recovered by probing bytecode in the first place.
*/
import {IPonsFeeEscrow, IPonsCurveSweep, IPonsHookSweep} from "./CharityDistributor.sol";
import {V4Seller, IPoolManager} from "./V4Seller.sol";

contract CharityDistributorV2 is V4Seller {
    /* ------------------------------------------------------------------ config -- */

    /// The Pons V2 fee escrow this contract claims from.
    IPonsFeeEscrow public immutable escrow;

    /**
     * Where the charity's share is pushed. Bridged onward to the charity's own address by the remit
     * service; see `remit/` and the trust note above.
     *
     * ⚠ Operationally this address should hold a balance only for the seconds between a release and
     * its bridge. A steady-state balance above one batch is the alarm condition, because exposure to
     * the one trusted key is bounded by whatever is sitting here at the moment it is compromised.
     */
    address public immutable charityVault;

    /// Where the remainder is pushed — gas for the cranker and the remit service, and nothing else.
    address public immutable opsVault;

    /**
     * The charity's share, in basis points of everything this contract receives.
     *
     * ⭐ Applied to EVERYTHING, not only to escrow claims. A direct donation sent to this address
     * splits on the same terms, because `_release` works off the balance rather than off what a
     * harvest returned — see the note there.
     */
    uint16 public immutable charityBps;

    /* ------------------------------------------------------------------ ledger -- */

    /**
     * The charity's share of an asset that CANNOT be paid out yet, awaiting a sale to USDG.
     *
     * ⛔⛔ THE SPLIT HAPPENS ONCE, AND THIS IS WHAT MAKES THAT TRUE. Without it, `_release` would
     * split the whole balance, then `sellAllForUsdg` would release the proceeds and split them a
     * SECOND time — handing the creator a cut of money already accounted to the charity. Reserving
     * it takes it out of the pool `_release` is allowed to look at.
     */
    mapping(address => uint256) public reservedForCharity;

    /// Lifetime totals, per asset. The public ledger the site renders. Native is keyed by address(0).
    mapping(address => uint256) public totalToCharity;
    mapping(address => uint256) public totalToOps;

    event Harvested(address indexed asset, uint256 amount);
    event Released(address indexed asset, uint256 toCharity, uint256 toOps);
    /// ⚠ Distinct from `Released`: this money is HELD for the charity, not paid to it.
    event Reserved(address indexed asset, uint256 amount);

    error ZeroAddress();
    error BadSplit();
    error TransferFailed();
    /// ⛔ Raised when something other than native ETH or USDG is asked to leave. See `_release`.
    error NotPayable();
    error NothingReserved();

    /**
     * @param charityBps_ The charity's share. ⚠ Bounded at 10000 and NOT at some lower "sensible"
     *        number: 100% to charity is the honest default for this contract, and a deployment that
     *        keeps nothing should not have to fight the constructor.
     */
    constructor(
        IPonsFeeEscrow escrow_,
        address charityVault_,
        address opsVault_,
        uint16 charityBps_,
        IPoolManager poolManager_,
        address usdg_,
        uint16 maxSellSlippageBps_
    ) V4Seller(poolManager_, usdg_, maxSellSlippageBps_) {
        if (address(escrow_) == address(0) || charityVault_ == address(0)) revert ZeroAddress();
        // ⚠ `opsVault` may only be zero when it can never be paid, or the remainder burns silently.
        if (opsVault_ == address(0) && charityBps_ != 10_000) revert ZeroAddress();
        if (charityBps_ > 10_000) revert BadSplit();
        escrow = escrow_;
        charityVault = charityVault_;
        opsVault = opsVault_;
        charityBps = charityBps_;
    }

    /// ⚠ Required. The escrow pays native fees by SENDING ether. Without this every native claim reverts.
    receive() external payable {}

    /* ----------------------------------------------------------------- harvest -- */

    /**
     * Pull native fees out of the escrow and push them on. Permissionless on purpose: the contract
     * enforces the outcome, so there is no reason to care who pays the gas, and a permissioned
     * harvest is a harvest that stops the day one key goes quiet.
     */
    function harvest() public returns (uint256 gained) {
        uint256 before = address(this).balance;
        try escrow.claim() {} catch {}
        gained = address(this).balance - before;
        if (gained != 0) emit Harvested(address(0), gained);
        _release(address(0));
    }

    /**
     * The same for a launch paired against an ERC-20.
     *
     * ⛔⛔ `asset` MUST be an asset that can leave Robinhood Chain. Relay routes native ETH and USDG
     * off RHC and refuses all 21 tokenized stocks with "Unsupported currency" — verified 28 Aug 2026.
     * Harvesting AAPL fees into `charityVault` moves them somewhere no bridge will take them, which
     * is not a delay, it is a permanent loss to the charity. The launch itself must be paired against
     * ETH or USDG; see SPEC.md. Nothing on chain can enforce this, so it is enforced at launch time.
     */
    function harvestToken(address asset) public returns (uint256 gained) {
        if (asset == address(0)) revert ZeroAddress();
        uint256 before = _balance(asset);
        try escrow.claimToken(asset) {} catch {}
        gained = _balance(asset) - before;
        if (gained != 0) emit Harvested(asset, gained);

        /* ⭐⭐ RELEASED FOR EVERY ASSET, WHICH IS THE V2 CHANGE. V1 released only USDG, because the
           charity vault was the only destination and a stock sent there is stranded for good. Now
           there are two destinations with different constraints, so `_release` splits here for both
           and applies the bridgeability rule to the charity's leg alone: the creator's half leaves
           immediately as the stock, and the charity's half is reserved for `sellReservedForUsdg`.
           ⛔ Still enforced in `_release` rather than here, so it stays a property of the contract
           and not a rule an operator has to remember. */
        _release(asset);
    }

    /// One call for the cranker: every asset a launch might pay in, in one transaction.
    function harvestMany(address[] calldata assets) external {
        harvest();
        for (uint256 i = 0; i < assets.length; i++) harvestToken(assets[i]);
    }

    /* ------------------------------------------------------------------- sweep -- */

    /**
     * Move a launch's fees off its curve and into the escrow, so `harvest` has something to claim.
     *
     * ⭐⭐ PERMISSIONLESS, WHICH IS THE ENTIRE POINT. Pons only accepts this call from the launch's
     * fee recipient, and that is this contract; opening it to anyone means the full chain of
     * sweep, harvest and payout can be run by a stranger, a cron, or the charity itself, with no key
     * of ours involved and nothing to go quiet.
     *
     * ⚠ `minBuybackTokensOut` is Pons's slippage floor for the buyback leg. Launches made here
     * disable the buyback, so no swap happens and the value is inert; it is still exposed rather
     * than hardcoded to zero, because a caller who does need it should be able to set it.
     *
     * ⛔ Only these two calls are forwarded, and to a target the caller names. That is safe because
     * `sweepFees` moves money TO this contract and can do nothing else. An arbitrary-call version of
     * this function would be a way to drain it.
     */
    function sweepCurve(address curve, uint256 minBuybackTokensOut) external {
        IPonsCurveSweep(curve).sweepFees(minBuybackTokensOut);
    }

    /** The same for a launch that has graduated onto the Uniswap V4 pool. */
    function sweepPool(address hook, bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
        external
    {
        IPonsHookSweep(hook).sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut);
    }

    /* ----------------------------------------------------------------- release -- */

    /**
     * Split whatever is held and push it out.
     *
     * ⭐⭐ WORKS OFF THE BALANCE, NEVER OFF WHAT THE HARVEST RETURNED. Two reasons, and the second is
     * the one that bites. First, a direct donation to this address should split on the same terms as
     * a fee. Second, `escrow.claim()` is wrapped in a `try`, so a claim that succeeded while a later
     * step reverted would leave money here that no return value ever mentioned — exactly the shape
     * where funds sit unassigned forever and every read reports zero.
     *
     * ⚠ Public and permissionless so a stuck balance is recoverable to the charity by anyone at all,
     * including the charity, without this contract needing a rescue function that could do anything
     * else.
     */
    function release(address asset) public {
        _release(asset);
    }

    function _release(address asset) internal {
        /* ⛔⛔ THE ALLOWLIST STILL EXISTS — IT NOW GUARDS THE LEG IT WAS WRITTEN FOR.
           Relay moves native ETH and USDG off Robinhood Chain and refuses every tokenized stock,
           commodity and ETF. An asset that leaves for the charity vault and then cannot leave the
           chain is stranded for good: the charity's money, visibly held, permanently unspendable.
           ⚠ V1 enforced that by refusing to move ANYTHING else, which also blocked the creator's
           half — money that never needs to leave the chain at all. */
        /* ⛔ `_balance` is ERC-20 ONLY — it staticcalls `balanceOf` and reverts when there is no code
           to answer, which for the zero address means every native release dies as `TransferFailed`.
           V1 branched here and this rewrite dropped the branch; the native tests caught it. */
        uint256 held = asset == address(0) ? address(this).balance : _balance(asset);
        uint256 reserved = reservedForCharity[asset];
        uint256 amount = held > reserved ? held - reserved : 0;
        if (amount == 0) return;

        /* ⭐ The OPS side is the one that rounds down, so every wei of division dust lands on the
           charity side. Backwards from the obvious `charity = amount * bps / 10000`, deliberately:
           dust should never accumulate on the side holding the keys. */
        uint256 toOps = (amount * (10_000 - charityBps)) / 10_000;
        uint256 toCharity = amount - toOps;

        /* ── the creator's half: paid NOW, in whatever this is ──────────────────────────────────
           ⭐ {CreatorRouter} is a contract with no withdraw and no owner whose destinations are
           fixed in its own creation code, so handing it a stock stands to lose nothing — it can
           spend one on the launch's curve, which is the whole reason V2 exists. */
        if (toOps != 0) {
            totalToOps[asset] += toOps;
            _send(asset, opsVault, toOps);
        }

        if (toCharity == 0) {
            emit Released(asset, 0, toOps);
            return;
        }

        /* ── the charity's half: paid now only if a bridge will carry it ───────────────────────── */
        if (asset == address(0) || asset == usdg) {
            totalToCharity[asset] += toCharity;
            emit Released(asset, toCharity, toOps);
            _send(asset, charityVault, toCharity);
        } else {
            /* ⚠ Reserved, NOT sent and NOT dropped. It stays here, attributed, until `sellAllForUsdg`
               converts it into something that can reach a charity. `Released` is deliberately not
               emitted: nothing was released, and a ledger that says otherwise is how a total gets
               quoted for money that never moved. */
            reservedForCharity[asset] += toCharity;
            emit Reserved(asset, toCharity);
        }
    }

    /**
     * Sell the charity's reserved share of a stock into USDG and pay ALL of it to the charity.
     *
     * ⛔⛔ IT DOES NOT GO THROUGH `_release`, AND MUST NOT. This money was already split — the
     * creator was paid their share of it in the original asset the moment it arrived. Passing the
     * proceeds through the splitter would take a second cut for the creator out of the charity's
     * own half, every time.
     *
     * @param minOut from an off-chain simulation of THIS call. The contract's own spot floor is a
     *        backstop against a hostile caller, not a substitute for a quote.
     */
    function sellReservedForUsdg(address stock, uint24 fee, int24 tickSpacing, uint256 minOut)
        external
        returns (uint256 usdgOut)
    {
        uint256 amount = reservedForCharity[stock];
        if (amount == 0) revert NothingReserved();
        /* ⛔ Cleared BEFORE the swap. `_sellForUsdg` hands control to the pool manager, and a
           reservation still standing at that moment is one a reentrant caller could sell twice. */
        reservedForCharity[stock] = 0;

        usdgOut = _sellForUsdg(stock, fee, tickSpacing, amount, minOut);

        totalToCharity[usdg] += usdgOut;
        emit Released(usdg, usdgOut, 0);
        _send(usdg, charityVault, usdgOut);
    }

    /* --------------------------------------------------------------- transfers -- */

    function _balance(address asset) internal view returns (uint256) {
        (bool ok, bytes memory out) =
            asset.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf(address)
        if (!ok || out.length < 32) revert TransferFailed();
        return abi.decode(out, (uint256));
    }

    /**
     * ⛔ Tolerates a token that returns nothing. USDG is the asset this contract will actually hold
     * most of the time and a bare `IERC20.transfer` reverts on any token whose ABI predates the
     * bool return — a decoding failure, not a transfer failure, and indistinguishable in the logs.
     */
    function _send(address asset, address to, uint256 amount) internal {
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
            return;
        }
        (bool ok2, bytes memory out) =
            asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        if (!ok2 || (out.length != 0 && !abi.decode(out, (bool)))) revert TransferFailed();
    }

    /* --------------------------------------------------------------- selling -- */

    /*
      ⛔⛔ V1's `sellForUsdg` AND `sellAllForUsdg` ARE DELIBERATELY ABSENT.

      Both ended in `_release(usdg)`, which was right when the split had not happened yet. Under V2
      it has: the creator was paid their share the moment the fee arrived, in the asset it arrived
      in. Passing the proceeds of the charity's own reserved half back through the splitter would
      hand the creator a SECOND cut of it, out of the charity's money, on every sale.

      ➤ {sellReservedForUsdg} above is the replacement, and it sells exactly the reserved amount and
      pays all of it to the charity. Keeping the old names as thin wrappers was considered and
      rejected: the keeper calls `sellAllForUsdg` by name, and a V2 distributor that answers to it
      with different semantics is worse than one that does not answer to it at all — the call
      reverts loudly instead of quietly misallocating.
    */

    function _payToken(address token, address to, uint256 amount) internal override {
        _send(token, to, amount);
    }

    /* ------------------------------------------------------------------- reads -- */

    /// What the escrow is holding for this contract but has not paid out yet. For the site's "pending".
    function pending(address asset) external view returns (uint256) {
        return asset == address(0)
            ? escrow.balanceOf(address(this))
            : escrow.balanceOfToken(address(this), asset);
    }
}
