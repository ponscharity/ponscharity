// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Pons V2's fee escrow.
 *
 * ⚠⚠ TWO LEDGERS, AND A LAUNCH ONLY EVER LANDS IN ONE. `_balances[recipient]` holds native ETH;
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
interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
}

/**
 * Pons's bonding curve and meme hook, for the one call this contract has to be able to make on them.
 *
 * ⛔⛔ `sweepFees` REVERTS `NotFeeSweepOperator()` FOR EVERYONE BUT PONS'S OPERATOR AND THE LAUNCH'S
 * FEE RECIPIENT, and the fee recipient is this contract. Without the passthrough below there is no
 * way for anyone on this side to move a launch's fees from the curve into the escrow: `harvest` is
 * permissionless but the step BEFORE it is not, so the whole payout would sit waiting on Pons to
 * sweep on its own schedule. Found by trading on a fork and watching the sweep revert.
 */
interface IPonsCurveSweep {
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface IPonsHookSweep {
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}

/**
 * Where a charity launch's creator fees go, decided once and then not decidable again.
 *
 * ## What this contract is for
 *
 * It is the `creatorFeeRecipient` of one or more Pons V2 launches. It pulls their fees out of the
 * shared escrow and pushes them, at a split fixed at construction, to two addresses that were also
 * fixed at construction. That is the entire contract. It has no owner, no setters, no upgrade path,
 * no arbitrary-call function and no withdraw.
 *
 * ## ⛔⛔ WHY THERE IS NO OWNER, AND WHY THAT IS THE PRODUCT
 *
 * The failure mode this exists to avoid is not technical. donate.gg routed ~$135M of trading volume
 * under nonprofit brands and credited charities ~0.7% of it, into wallets the charities did not
 * control and mostly did not know about, behind an undisclosed 10% fee. Nothing there was a hack.
 * Every step was a discretionary decision taken by whoever held the keys.
 *
 * ➤ So the split and both destinations are `immutable`. Once deployed, no key in existence can
 * point this contract's charity share anywhere else. A donor can read that off the verified source
 * in ten seconds, which is a claim worth more than any promise on a website.
 *
 * ⚠⚠ It follows that a mistake in the constructor is PERMANENT — the same discipline Pons itself
 * forces with `creatorTaxBps`, which has no setter either. Deploy against a fork first.
 *
 * ## ⛔⛔ THE TRUST BOUNDARY IS THE BRIDGE, AND IT IS NOT HERE
 *
 * This contract can guarantee where the money goes ON Robinhood Chain. It cannot guarantee anything
 * about the hop after that, because Relay's deposit calldata is
 * `0x49290c1c || user || keccak(request)` — 68 bytes that do NOT contain the recipient. The
 * destination lives in Relay's off-chain request, keyed by that hash, so no on-chain check can
 * verify it. Any design claiming an end-to-end trustless remit on this route is lying.
 *
 * ➤ What is true instead: the charity share can only ever reach `charityVault`, every Relay request
 * is publicly attributable through Relay's own requests API, and the remit service publishes both
 * legs. Misdirection is detectable and permanent on the record, not preventable. Say that plainly
 * on the site rather than implying custody nobody has.
 */
import {V4Seller, IPoolManager} from "./V4Seller.sol";

contract CharityDistributor is V4Seller {
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

    /// Lifetime totals, per asset. The public ledger the site renders. Native is keyed by address(0).
    mapping(address => uint256) public totalToCharity;
    mapping(address => uint256) public totalToOps;

    event Harvested(address indexed asset, uint256 amount);
    event Released(address indexed asset, uint256 toCharity, uint256 toOps);

    error ZeroAddress();
    error BadSplit();
    error TransferFailed();
    /// ⛔ Raised when something other than native ETH or USDG is asked to leave. See `_release`.
    error NotPayable();

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

        /* ⭐⭐ A HARVESTED STOCK IS HELD, NOT PUSHED — and this is the whole fix for the stranding
           bug. Pushing AAPL to `charityVault` would move it somewhere no bridge will take it, which
           is not a delay but a permanent loss. Only USDG (and native) are payable; everything else
           waits for `sellForUsdg`. Enforced in `_release`, so it is a property of the contract
           rather than a rule the operator has to remember. */
        if (asset == usdg) _release(asset);
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
        /* ⛔⛔ THE PAYOUT ALLOWLIST, AND THE REASON IT IS A `revert` RATHER THAN A CONVENTION.
           Relay moves native ETH and USDG off Robinhood Chain and refuses all 21 tokenized stocks.
           An asset that leaves this contract to a vault and then cannot leave the chain is stranded
           for good — the charity's money, visibly held, permanently unspendable. Making the payout
           path physically incapable of holding anything else means that outcome cannot be reached
           by mistake, by a mis-set env var, or by a future caller who did not read this file.
           ⚠ It follows that a stock with no liquid pool — MSTR/USDG is initialised only at
           `fee=100` and holds ZERO liquidity — sits here until some pool for it has depth. That is
           the correct behaviour: waiting is recoverable, stranding is not. */
        if (asset != address(0) && asset != usdg) revert NotPayable();

        uint256 amount = asset == address(0) ? address(this).balance : _balance(asset);
        if (amount == 0) return;

        /* ⭐ The OPS side is the one that rounds down, so every wei of division dust lands on the
           charity side. Backwards from the obvious `charity = amount * bps / 10000`, deliberately:
           dust should never accumulate on the side holding the keys. */
        uint256 toOps = (amount * (10_000 - charityBps)) / 10_000;
        uint256 toCharity = amount - toOps;

        totalToCharity[asset] += toCharity;
        totalToOps[asset] += toOps;
        emit Released(asset, toCharity, toOps);

        /* ⚠ Charity FIRST. If a push fails the whole call reverts and nothing is recorded, so the
           ordering only matters for gas — but it also means a reader of the trace sees the charity
           leg settle before anything else can have touched the balance. */
        if (toCharity != 0) _send(asset, charityVault, toCharity);
        if (toOps != 0) _send(asset, opsVault, toOps);
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

    /**
     * Sell a harvested tokenized stock into USDG and push the proceeds straight through the split.
     *
     * ⭐ One call, so the stock is never left sitting as USDG waiting for a second transaction that
     * might not come. The proceeds are released in the same transaction they are created.
     *
     * @param minOut from an off-chain simulation of THIS call — `eth_call` it first and pass the
     *        result less a tolerance, exactly as the cranker does for its burn leg. The contract's
     *        own spot floor is a backstop against a hostile caller, not a substitute for this.
     */
    function sellForUsdg(address stock, uint24 fee, int24 tickSpacing, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 usdgOut)
    {
        usdgOut = _sellForUsdg(stock, fee, tickSpacing, amountIn, minOut);
        _release(usdg);
    }

    /// Everything the contract holds of one stock, in one call. What the remit service actually uses.
    function sellAllForUsdg(address stock, uint24 fee, int24 tickSpacing, uint256 minOut)
        external
        returns (uint256 usdgOut)
    {
        usdgOut = _sellForUsdg(stock, fee, tickSpacing, _balance(stock), minOut);
        _release(usdg);
    }

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
