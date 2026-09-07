// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/**
 * Uniswap V4's singleton, as deployed on Robinhood Chain at
 * `0x8366a39CC670B4001A1121B8F6A443A643e40951`.
 *
 * ⚠ `Currency` and `BalanceDelta` are user-defined value types in v4-core. They are `address` and
 * `int256` underneath and are written as those here, so this file needs no v4 dependency at all —
 * which matters, because there is no v4-periphery deployment on this chain worth depending on.
 */
interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        /// ⚠ NEGATIVE is exact-input in v4. Positive is exact-output. Getting this backwards asks
        /// the pool to BUY the stock with USDG it does not have, which reverts on settlement.
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/**
 * Selling a tokenized stock for USDG, on chain, with no router.
 *
 * ## ⛔⛔ WHY THIS EXISTS AT ALL
 *
 * Creator fees are paid in the launch's PAIR ASSET, and 21 of the 23 approved pair assets are
 * tokenized equities. Relay refuses every one of them off Robinhood Chain — HTTP 400 "Unsupported
 * currency" — so fees earned in AAPL cannot reach a charity's wallet by bridging. Verified against
 * live Relay, 28 Aug 2026.
 *
 * ➤ So they are SOLD first. `STOCK/USDG` pools exist on the V4 singleton at the standard fee tiers
 * with **no hook**, verified on chain the same day, and USDG is the cheapest asset to remit
 * (0.04–0.08%, against native ETH's 0.49% floor). Sell to USDG, then bridge USDG. One path.
 *
 * ## ⭐⭐ WHY IT TALKS TO THE SINGLETON DIRECTLY INSTEAD OF USING A ROUTER
 *
 * This chain has **no canonical router**. Two UniversalRouters are deployed and neither is
 * obviously the live one — the uncertainty that left `CompanyTreasury.buybackVia` needing its route
 * supplied by hand from an env var, which is precisely the thing that cannot be automated.
 *
 * ➤ V4's `unlock`/`unlockCallback` is a public interface. Implementing it here is about eighty
 * lines and removes the dependency completely: no router to whitelist, no router to pick, nothing
 * to break the day a periphery contract is replaced. `unlock` calls back **only the address that
 * called it**, so the callback cannot be entered by anyone else.
 *
 * ## ⛔ HOOKLESS POOLS ONLY
 *
 * `hooks` is hardcoded to the zero address and is not a parameter. A hooked pool can run arbitrary
 * code inside the swap, and this contract is holding donations. Every STOCK/USDG pool found on
 * chain is hookless, so nothing is given up.
 */
abstract contract V4Seller {
    IPoolManager public immutable poolManager;

    /// The one asset stocks are sold into. Immutable: a settable target is a redirect by another name.
    address public immutable usdg;

    /**
     * The worst execution a caller may accept, against the pool's own spot price.
     *
     * ## 🔴🔴 WHY A PERMISSIONLESS SELL CANNOT TAKE `minOut` ON TRUST
     *
     * The cranker already learned this the hard way in `floorFor`: a bot sending `minTokensOut = 0`
     * on a schedule is a standing invitation, because anyone can read the pending balance,
     * front-run the swap and let it execute at whatever price they left behind. A *permissionless*
     * sell is worse — an attacker does not have to wait for the bot's timer, they call it
     * themselves, inside their own sandwich, for free.
     *
     * ➤ So `minOut` is a caller's ceiling on their own risk, never the only floor. The contract
     * computes its own floor from the pool's spot price and refuses anything looser. A caller may
     * always ask for MORE than the floor; they can never ask for less.
     *
     * ⚠⚠ WHAT THIS DOES NOT FIX, STATED HONESTLY. Spot is read inside the same transaction, so an
     * attacker who moves the price first has the floor computed against their own manipulated
     * price. This bounds the damage rather than preventing it: their take is capped at this
     * tolerance of one batch, and the batches are small relative to these pools. It is not a claim
     * of sandwich resistance. The real defence is the same as the cranker's — the off-chain caller
     * SIMULATES the sell and passes a `minOut` far tighter than this floor, and this value only
     * decides how badly a hostile caller can do instead.
     */
    uint16 public immutable maxSellSlippageBps;

    /// v4 bounds. The swap is not price-limited; the guard is `minOut`.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// ⚠ `_pools` is slot 6 on the deployed PoolManager. Pool state: slot0, fg0, fg1, liquidity.
    uint256 internal constant POOLS_SLOT = 6;

    event Sold(address indexed stock, uint256 amountIn, uint256 usdgOut, uint24 fee);

    error NotPoolManager();
    error PoolNotInitialised();
    error NoLiquidity();
    error SlippageTooLoose(uint256 asked, uint256 floorRequired);
    error SoldTooCheap(uint256 got, uint256 minOut);
    error NotSellable();

    constructor(IPoolManager poolManager_, address usdg_, uint16 maxSellSlippageBps_) {
        poolManager = poolManager_;
        usdg = usdg_;
        maxSellSlippageBps = maxSellSlippageBps_;
    }

    /* -------------------------------------------------------------------- read -- */

    function _poolKey(address stock, uint24 fee, int24 tickSpacing)
        internal
        view
        returns (IPoolManager.PoolKey memory key, bool stockIsZero)
    {
        stockIsZero = uint160(stock) < uint160(usdg);
        key = IPoolManager.PoolKey({
            currency0: stockIsZero ? stock : usdg,
            currency1: stockIsZero ? usdg : stock,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: address(0)
        });
    }

    function _poolId(IPoolManager.PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks));
    }

    /**
     * Spot price and liquidity, straight out of the singleton's storage.
     *
     * ⛔⛔ AN INITIALISED POOL IS NOT A LIQUID POOL, and the difference is invisible from `slot0`.
     * Measured on a fork of live RHC, 28 Aug 2026: MSTR/USDG is initialised at `fee=100` and holds
     * **zero liquidity**; GME/USDG is initialised at `fee=3000` with zero liquidity and only trades
     * at `fee=10000`. A swap against an empty book does not fail cleanly — it prices off nothing.
     * Checked here so the failure is `NoLiquidity` rather than a silently terrible fill.
     */
    function poolState(address stock, uint24 fee, int24 tickSpacing)
        public
        view
        returns (uint160 sqrtPriceX96, uint128 liquidity)
    {
        (IPoolManager.PoolKey memory key,) = _poolKey(stock, fee, tickSpacing);
        bytes32 base = keccak256(abi.encode(_poolId(key), POOLS_SLOT));
        sqrtPriceX96 = uint160(uint256(poolManager.extsload(base)));
        liquidity = uint128(uint256(poolManager.extsload(bytes32(uint256(base) + 3))));
    }

    /**
     * What spot says `amountIn` of the stock is worth in USDG, ignoring price impact and the LP fee.
     *
     * ⚠ Deliberately an OPTIMISTIC number. It is the basis for a floor that the real fill must not
     * fall too far below; making it pessimistic would widen the tolerance it is supposed to tighten.
     *
     * ⚠⚠ `Math.mulDiv` in both directions, never `sq * sq`. `sqrtPriceX96` is up to 2^160, so its
     * square overflows uint256 outright — the classic way this maths silently reverts, or worse,
     * quietly truncates on an unchecked build.
     */
    function quoteSpot(address stock, uint24 fee, int24 tickSpacing, uint256 amountIn)
        public
        view
        returns (uint256 usdgOut)
    {
        (uint160 sq, uint128 liq) = poolState(stock, fee, tickSpacing);
        if (sq == 0) revert PoolNotInitialised();
        if (liq == 0) revert NoLiquidity();
        (, bool stockIsZero) = _poolKey(stock, fee, tickSpacing);

        // price = amount1/amount0 = (sq / 2^96)^2
        if (stockIsZero) {
            // selling currency0, receiving currency1: out = in * price
            usdgOut = Math.mulDiv(Math.mulDiv(amountIn, sq, Q96), sq, Q96);
        } else {
            // selling currency1, receiving currency0: out = in / price
            usdgOut = Math.mulDiv(Math.mulDiv(amountIn, Q96, sq), Q96, sq);
        }
    }

    /* -------------------------------------------------------------------- sell -- */

    struct SellData {
        address stock;
        uint24 fee;
        int24 tickSpacing;
        uint256 amountIn;
        bool stockIsZero;
    }

    /**
     * Sell `amountIn` of `stock` into USDG.
     *
     * Permissionless, like every other moving part here — the contract enforces the outcome, so
     * there is no reason to care who pays the gas.
     *
     * @param minOut The caller's own floor, from an off-chain simulation. Must be at least
     *        `maxSellSlippageBps` below spot; see the note on that field for what that does and does
     *        not buy.
     */
    function _sellForUsdg(address stock, uint24 fee, int24 tickSpacing, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 usdgOut)
    {
        if (stock == usdg || stock == address(0)) revert NotSellable();

        uint256 floorOut = Math.mulDiv(
            quoteSpot(stock, fee, tickSpacing, amountIn), 10_000 - maxSellSlippageBps, 10_000
        );
        if (minOut < floorOut) revert SlippageTooLoose(minOut, floorOut);

        (, bool stockIsZero) = _poolKey(stock, fee, tickSpacing);
        bytes memory out = poolManager.unlock(
            abi.encode(SellData({stock: stock, fee: fee, tickSpacing: tickSpacing, amountIn: amountIn, stockIsZero: stockIsZero}))
        );
        usdgOut = abi.decode(out, (uint256));

        if (usdgOut < minOut) revert SoldTooCheap(usdgOut, minOut);
        emit Sold(stock, amountIn, usdgOut, fee);
    }

    /**
     * ⚠ v4 calls this back only on the address that called `unlock`, so no other caller can enter
     * it even before this check — which is here anyway, because a guard that depends on reading
     * someone else's source is not a guard.
     */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SellData memory s = abi.decode(data, (SellData));
        (IPoolManager.PoolKey memory key,) = _poolKey(s.stock, s.fee, s.tickSpacing);

        int256 delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: s.stockIsZero,
                amountSpecified: -int256(s.amountIn), // ⚠ negative = exact input
                sqrtPriceLimitX96: s.stockIsZero ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );

        /* BalanceDelta packs amount0 in the high 128 bits and amount1 in the low 128, both signed
           and both from THIS contract's perspective: negative is owed to the pool, positive is
           owed to us. ⚠ The same sign convention that shipped a live bug on the stonks indexer by
           being read as v3's pool-perspective — check it first on any v4 work. */
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(int256(uint256(delta) & type(uint128).max));
        (int128 stockDelta, int128 usdgDelta) = s.stockIsZero ? (amount0, amount1) : (amount1, amount0);

        // Pay what we owe.
        poolManager.sync(s.stock);
        _payToken(s.stock, address(poolManager), uint256(uint128(-stockDelta)));
        poolManager.settle();

        // Collect what we are owed.
        uint256 owed = uint256(uint128(usdgDelta));
        poolManager.take(usdg, address(this), owed);
        return abi.encode(owed);
    }

    /// Implemented by the inheriting contract, which owns the transfer conventions.
    function _payToken(address token, address to, uint256 amount) internal virtual;
}
