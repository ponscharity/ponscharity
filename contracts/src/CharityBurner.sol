// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IBurnable {
    /**
     * ⭐ $CHARITY is OpenZeppelin `ERC20Burnable`: `burn` is public, unrestricted, and reduces
     * `totalSupply`. Verified on chain against the live token — a stranger burning 1 wei fails with
     * `ERC20InsufficientBalance` (`0xe450d38c`), i.e. it got past authorisation and stopped on
     * balance, so there is no owner gate to work around.
     */
    function burn(uint256 amount) external;
}

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
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
}

/**
 * Buys $CHARITY on its Uniswap V4 pool and burns it. Nothing else.
 *
 * ## ⛔⛔ WHY THIS IS A SEPARATE CONTRACT AND NOT A CHANGE TO THE DISTRIBUTOR
 *
 * `CharityDistributor` holds `charityVault` and `opsVault` as **immutables with no setter**, and the
 * Pons factory will only accept a `transferCreatorFeeRecipient` from the current recipient — which
 * *is* that distributor, and its bytecode contains no such call. Both halves of the existing split
 * are therefore welded on permanently. Nothing deployed here can change where fees land.
 *
 * ➤ So this sits **downstream**. `opsVault` is an EOA; the keeper forwards the burn share of each
 * arrival into this contract, and from that point on the money is beyond anyone's reach.
 *
 * ## ⛔⛔ THE POINT OF THE DESIGN IS WHAT IS *MISSING*
 *
 * There is no owner, no admin, no pause, no withdraw, no rescue, and no upgrade path. That is not an
 * oversight to be fixed later — it is the entire guarantee. Every ETH that reaches this address can
 * do exactly one thing, and a holder can verify that by reading this file rather than by trusting
 * whoever runs the keeper. Adding a withdraw "just in case" would silently convert this from a burn
 * contract into a wallet with extra steps.
 *
 * ⚠ The corollary, stated plainly: ETH sent here by mistake is gone. It will be spent on $CHARITY.
 */
contract CharityBurner {
    /* -------------------------------------------------------------------- shape -- */

    /// The token that gets bought and burned.
    address public immutable token;

    /**
     * What the pool is priced in. `address(0)` is native ETH, which is what $CHARITY is paired
     * against — kept as a field rather than hardcoded so this same contract serves a launch paired
     * against USDG or a stock without a second audit of the swap leg.
     */
    address public immutable pairToken;

    address public immutable hooks;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;
    IPoolManager public immutable poolManager;

    /// Lifetime totals, so a site can show the burn without indexing logs.
    uint256 public totalPairSpent;
    uint256 public totalBurned;

    /* ⛔ The swap hands control to Pons's hook mid-call. Without this, a hook that called back into
       `buyAndBurn` would re-read a balance that had not been spent yet and swap it twice. */
    uint256 private locked = 1;

    event BoughtAndBurned(uint256 pairSpent, uint256 burned, uint256 newTotalSupply);
    event BurnedDirect(uint256 burned, uint256 newTotalSupply);

    error ZeroAddress();
    error NothingToBurn();
    error NoFloor();
    error TooLittleOut(uint256 got, uint256 minOut);
    error NotPoolManager();
    error Reentrant();
    error TransferFailed();

    modifier lock() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(
        address token_,
        address pairToken_,
        address poolManager_,
        address hooks_,
        uint24 poolFee_,
        int24 poolTickSpacing_
    ) {
        /* ⚠ `pairToken_` is deliberately NOT checked — zero is native ETH, a legitimate value, and
           the one this launch actually uses. */
        if (token_ == address(0) || poolManager_ == address(0) || hooks_ == address(0)) {
            revert ZeroAddress();
        }
        token = token_;
        pairToken = pairToken_;
        poolManager = IPoolManager(poolManager_);
        hooks = hooks_;
        poolFee = poolFee_;
        poolTickSpacing = poolTickSpacing_;
    }

    /// Funding. Anyone may pay in; the keeper's forward from the ops wallet is an ordinary send.
    receive() external payable {}

    /* ------------------------------------------------------------------- burning -- */

    /**
     * Burn $CHARITY this contract already holds, without touching the pool.
     *
     * ⭐ THIS IS NOT A CONVENIENCE FUNCTION. Pons pays creator fees in **both** sides of the pair,
     * so a sweep of this launch delivers ETH *and* $CHARITY. The token side needs no swap at all —
     * routing it through a buy would pay pool fees and slippage to end up holding what we were
     * already holding. Permissionless because it cannot do harm: the only outcome is less supply.
     */
    function burnHeld() external returns (uint256 burned) {
        burned = _burnHeld();
        if (burned == 0) revert NothingToBurn();
        emit BurnedDirect(burned, IERC20(token).totalSupply());
    }

    /**
     * Spend everything held in the pair asset on $CHARITY, then burn what comes back.
     *
     * @param minTokensOut the slippage floor, simulated immediately before the call.
     *
     * ⛔⛔ A ZERO FLOOR IS REJECTED. Zero does not mean "no limit", it means "any fill is
     * acceptable" — and this is a permissionless function with a standing balance, which is the
     * textbook shape of a sandwich target. `CreatorRouter` documents this risk and then allows zero
     * anyway; here it is a revert, because the caller that would pass zero is precisely the one that
     * has not simulated.
     */
    function buyAndBurn(uint256 minTokensOut) external lock returns (uint256 bought, uint256 burned) {
        if (minTokensOut == 0) revert NoFloor();

        uint256 amountIn = _pairBalance();
        if (amountIn == 0) revert NothingToBurn();

        uint256 heldBefore = IERC20(token).balanceOf(address(this));
        poolManager.unlock(abi.encode(amountIn));
        bought = IERC20(token).balanceOf(address(this)) - heldBefore;
        if (bought < minTokensOut) revert TooLittleOut(bought, minTokensOut);

        totalPairSpent += amountIn;

        /* ⚠ Burns the FULL held balance, not just `bought`. Fee-side $CHARITY that arrived before
           this call would otherwise sit here until someone remembered `burnHeld`. */
        burned = _burnHeld();
        emit BoughtAndBurned(amountIn, burned, IERC20(token).totalSupply());
    }

    /* --------------------------------------------------------------- swap plumbing -- */

    /*
      ⚠ V4 requires every swap to name a price limit, and for a plain market buy the only sensible
      choice is the extreme in the direction of travel. The +1 / -1 are required: the bounds
      themselves are rejected. ⛔ This is NOT the slippage control — `minTokensOut` is. A price limit
      alone lets a swap partially fill and return early, which reads as success while spending less
      than intended.
    */
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    /// ⚠ V4 calls this back only on the address that called `unlock`. The check is here anyway,
    /// because a guard that depends on reading someone else's source is not a guard.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amountIn = abi.decode(data, (uint256));

        (IPoolManager.PoolKey memory key, bool pairIsZero) = _poolKey();

        /* ⚠ NEGATIVE amountSpecified is EXACT INPUT. Positive is exact output, which would ask the
           pool for a fixed number of tokens and spend whatever that costs. */
        int256 delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: pairIsZero,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: pairIsZero ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            ""
        );

        /* ⛔⛔ BalanceDelta packs amount0 in the high 128 bits and amount1 in the low 128, both
           signed and both from THIS contract's perspective: negative is owed BY us to the pool,
           positive is owed TO us. ⚠ Read as v3's pool-perspective this is backwards, and it looks
           right — the same misreading shipped a live bug on the stonks indexer. */
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(int256(uint256(delta) & type(uint128).max));
        (int128 pairDelta, int128 tokenDelta) = pairIsZero ? (amount0, amount1) : (amount1, amount0);

        // Pay what we owe, in the pair asset.
        if (pairToken == address(0)) {
            poolManager.sync(address(0));
            poolManager.settle{value: uint256(uint128(-pairDelta))}();
        } else {
            poolManager.sync(pairToken);
            _send(pairToken, address(poolManager), uint256(uint128(-pairDelta)));
            poolManager.settle();
        }

        // Collect the tokens the swap earned.
        poolManager.take(token, address(this), uint256(uint128(tokenDelta)));
        return "";
    }

    function _poolKey() private view returns (IPoolManager.PoolKey memory key, bool pairIsZero) {
        pairIsZero = uint160(pairToken) < uint160(token);
        key = IPoolManager.PoolKey({
            currency0: pairIsZero ? pairToken : token,
            currency1: pairIsZero ? token : pairToken,
            fee: poolFee,
            tickSpacing: poolTickSpacing,
            hooks: hooks
        });
    }

    /* ----------------------------------------------------------------- internals -- */

    function _burnHeld() private returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) return 0;
        IBurnable(token).burn(amount);
        totalBurned += amount;
    }

    function _pairBalance() private view returns (uint256) {
        return pairToken == address(0)
            ? address(this).balance
            : IERC20(pairToken).balanceOf(address(this));
    }

    /// What a buy right now would spend. For the keeper's pre-flight and for the site.
    function pending() external view returns (uint256 pairHeld, uint256 tokensHeld) {
        return (_pairBalance(), IERC20(token).balanceOf(address(this)));
    }

    /**
     * ⛔ Tolerates a token that returns nothing. A bare `IERC20.transfer` reverts on any token whose
     * ABI predates the bool return — a decoding failure, not a transfer failure, and
     * indistinguishable in the logs.
     */
    function _send(address asset, address to, uint256 amount) private {
        (bool ok, bytes memory out) =
            asset.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (out.length != 0 && !abi.decode(out, (bool)))) revert TransferFailed();
    }
}
