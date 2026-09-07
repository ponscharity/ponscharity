// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";

/**
 * CREATOR ROUTER — what happens to the half of a launch's fees the charity does not take.
 *
 * ## Where this sits
 *
 * `CharityDistributor` splits every fee: at least `minCharityBps` to the charity, the remainder to
 * whatever address the launch named as `creatorPayout`. Until now that had to be a wallet, so the
 * only thing a creator could do with their share was receive it.
 *
 * This contract is that address. It takes the remainder and splits it again, across any combination
 * of three things, fixed at launch and never changeable afterwards:
 *
 *   - **Wallet** — paid straight out, exactly as before.
 *   - **XAccount** — ring-fenced in {CharityFeeClaims} against an X account, claimable by whoever
 *     proves they own it. The launch can therefore pay somebody who has never touched the chain.
 *   - **Burn** — buys the launch's own token back and destroys it.
 *
 * ## ⛔⛔ THE SPLITS ARE CONSTRUCTOR ARGUMENTS, AND THAT IS THE POINT
 *
 * They are part of this contract's creation code, so they are part of its CREATE2 address, so they
 * are part of the address the token itself names as its fee recipient. A launch that promised to
 * burn half its fees cannot later become one that does not, because changing the promise would
 * change the address and the token points at the old one. There is no setter and no owner, and
 * adding either later is not possible — the address is decided before the launch exists.
 *
 * ## ⭐⭐ FEES ARRIVE IN THE PAIR ASSET, AND THE BURN LEG SPENDS THEM WHERE THEY ARE
 *
 * A Pons launch is priced in something and pays its creator fees in that same something: a launch
 * paired against AAPL earns AAPL. The bonding curve that would sell you its token also takes AAPL.
 *
 * So the burn leg buys with **exactly what it was paid in**, on the launch's own curve or pool. The
 * obvious alternative — sell the AAPL to USDG the way the charity's half must be, then buy AAPL
 * back to reach the curve — is three swaps where one will do, and pays an LP fee and price impact
 * twice for the privilege of ending up where it started.
 *
 * ⚠ This is why {CharityDistributor} pays this contract BEFORE selling anything. The charity's half
 * has to become USDG because no bridge will carry a tokenized stock off this chain; this half does
 * not, because it never leaves.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// ⭐ Present and UNPRIVILEGED on a Pons V2 memecoin: any holder may destroy their own tokens, and
/// it reduces `totalSupply`, which is what makes a burn visible in the market cap rather than just
/// moving tokens to an address nobody watches.
interface IBurnable {
    function burn(uint256 amount) external;
}

interface IPonsCurve {
    /// ⚠ `payable`, and for a native launch `quoteIn` MUST EQUAL `msg.value` exactly — V2 reverts on
    /// one wei of difference rather than treating the excess as a buy, which V1 did.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
    function graduated() external view returns (bool);
}

/// Pons's own record of a launch. The only thing trusted to say what a token's curve and pair are.
struct LaunchedToken {
    address token;
    address curve;
    address deployer;
    address creatorFeeRecipient;
    address pairToken;
    uint256 graduationThreshold;
    uint24 poolFee;
    int24 tickSpacing;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    uint8 phase;
    uint256 sweptQuote;
    uint256 sweptTokens;
    uint256 sweptAt;
    bool exists;
}

interface IPonsFactory {
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function memeHook() external view returns (address);
}

/// Our own launchpad's registry. Only it can write an entry, which is what makes binding safe.
interface ICharityLaunchpad {
    function isCharityLaunch(address token) external view returns (bool);
    function distributorOf(address token) external view returns (address);
}

interface ICharityDistributor {
    function opsVault() external view returns (address);
}

interface ICharityFeeClaims {
    function fund(address launch, bytes32 beneficiary, address asset, uint256 amount) external payable;
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

contract CreatorRouter {
    /* -------------------------------------------------------------------- shape -- */

    enum Mode {
        Wallet,
        XAccount,
        Burn
    }

    /**
     * ⭐⭐ ONE SHARE OF THE CREATOR'S REMAINDER, AND WHERE IT GOES.
     *
     * `bps` is of the remainder, not of the whole fee, and every share must add to exactly 10,000.
     * A launch giving 60% to the charity and splitting the rest 50/50 between a wallet and a burn
     * therefore ends up at 60 / 20 / 20 of the total.
     *
     * `wallet` is required for {Mode.Wallet} and must be zero otherwise. `beneficiary` is required
     * for {Mode.XAccount} and must be zero otherwise. ⚠ Both are checked rather than ignored: a
     * beneficiary quietly dropped from a Wallet share is a promise the chain never recorded.
     *
     * ⚠ A beneficiary is an opaque `bytes32` here and in {CharityFeeClaims}. We use
     * `keccak256("x:<numeric id>")` — the NUMERIC id, never the handle, because a handle can be
     * relinquished and taken over by somebody else while the id cannot.
     */
    struct Split {
        Mode mode;
        uint16 bps;
        address wallet;
        bytes32 beneficiary;
        /**
         * ⭐⭐ WHICH SERVICE AND WHICH ACCOUNT, so a page can NAME the payee instead of showing a hash.
         *
         * `beneficiary` is `keccak256("x:<id>")` and a hash cannot be reversed, so without this the
         * only honest thing a token page could say was "a linked account" — which tells a reader
         * nothing about who a launch is actually paying.
         *
         * ⛔⛔ THE NUMERIC ID, NEVER THE HANDLE. Both services let a username be released and taken
         * by somebody else, so a handle written here would eventually name — and link to — the
         * wrong person's profile, permanently, with no way to correct it. The id is never reissued;
         * the handle is looked up fresh every time it is displayed.
         *
         * ⛔ 1 = X, 2 = GitHub. Zero for every other mode, and checked, so the field cannot quietly
         * mean something on a share where it has no meaning.
         */
        uint8 provider;
        uint256 accountId;
    }

    /* ------------------------------------------------------------------- config -- */

    /**
     * ⛔⛔ THESE FIVE ARE BOUND AFTER THE LAUNCH, NOT AT CONSTRUCTION, AND THEY HAVE TO BE.
     *
     * The chain of dependencies runs one way: this router must be the distributor's `opsVault`,
     * which is immutable and therefore fixed when the DISTRIBUTOR is built; the distributor must be
     * the launch's `creatorFeeRecipient`, which is fixed when the LAUNCH is made. So this contract's
     * address has to exist before the token it serves does, and the token cannot be a constructor
     * argument. Same ordering PonsiBurner faces, same answer.
     *
     * ⭐ The splits are still constructor arguments, so the address still commits to the promise.
     * Only the launch's own identity is late, and it is read from Pons's record rather than passed.
     */
    address public token;
    IPonsCurve public curve;
    address public pairToken;

    /// Where an {Mode.XAccount} share is ring-fenced. Zero when no share uses it.
    ICharityFeeClaims public immutable claims;

    /// Uniswap V4's singleton, where the launch trades once it has left its curve.
    IPoolManager public immutable poolManager;

    /// The graduated pool, as Pons created it. Read from the launch record by {initialize}.
    address public hooks;
    uint24 public poolFee;
    int24 public poolTickSpacing;

    /// Pons's live launch factory. The only thing trusted to say which curve a token has.
    IPonsFactory public immutable ponsFactory;

    /// Our launchpad. Its registry is what pins this router to ONE launch; see {initialize}.
    ICharityLaunchpad public immutable launchpad;

    /**
     * ⛔ Storage rather than `immutable` only because Solidity cannot hold an array in one. It is
     * written once in the constructor and there is no code anywhere that writes it again.
     */
    Split[] private _splits;

    /* ------------------------------------------------------------------- ledger -- */

    /**
     * What the burn leg has been given and not yet spent, per asset.
     *
     * ⛔⛔ TRACKED RATHER THAN INFERRED FROM THE BALANCE. `distribute` pays the wallet and claims
     * legs immediately but cannot buy on the creator's behalf — a buy needs a slippage floor quoted
     * off chain, so it is a second transaction. Between the two, this contract's balance is the
     * burn leg's money plus anything that has arrived since, and a `buyAndBurn` working off the raw
     * balance would spend fees that the wallet and claims legs are owed.
     */
    mapping(address => uint256) public burnReserve;

    /// Lifetime, per asset and per leg. The public ledger the site renders.
    mapping(address => uint256) public totalToWallet;
    mapping(address => uint256) public totalToClaims;
    mapping(address => uint256) public totalToBurn;

    uint256 public totalTokensBurned;

    event Initialized(address indexed token, address indexed curve, address pairToken);
    event Distributed(address indexed asset, uint256 toWallet, uint256 toClaims, uint256 toBurn);
    event BoughtAndBurned(address indexed asset, uint256 spent, uint256 tokensBurned, uint256 supplyAfter);

    /// ⛔ 1 = X, 2 = GitHub. The same numbering the launch form and the claim server use.
    uint8 internal constant PROVIDER_X = 1;
    uint8 internal constant PROVIDER_GITHUB = 2;

    error BadSplit();
    /// ⛔ The declared account does not hash to the beneficiary being paid.
    error BeneficiaryMismatch(bytes32 declared, bytes32 computed);
    error AlreadyInitialized();
    error NotInitialized();
    error NotLaunched();
    error NotOurLaunch(address token);
    error ZeroAddress();
    error NothingToDistribute();
    error NothingToBurn();
    error TransferFailed();
    error NotPoolManager();
    error TooLittleOut(uint256 got, uint256 minOut);
    error StillOnCurve();
    error AlreadyGraduated();
    error NoPool();

    /* -------------------------------------------------------------- constructor -- */

    constructor(
        address ponsFactory_,
        address launchpad_,
        address claims_,
        address poolManager_,
        Split[] memory splits_
    ) {
        if (ponsFactory_ == address(0) || launchpad_ == address(0)) revert ZeroAddress();

        uint256 total;
        bool needsClaims;
        for (uint256 i = 0; i < splits_.length; i++) {
            Split memory s = splits_[i];
            /* ⚠ A zero-bps share is refused rather than skipped. It reads as a promise on the token's
               page — "this launch burns" — while moving nothing, which is the one thing an immutable
               commitment must never be able to say. */
            if (s.bps == 0) revert BadSplit();
            if (s.mode == Mode.Wallet) {
                if (s.wallet == address(0) || s.beneficiary != bytes32(0)) revert BadSplit();
            } else if (s.mode == Mode.XAccount) {
                if (s.beneficiary == bytes32(0) || s.wallet != address(0)) revert BadSplit();
                if (s.provider != PROVIDER_X && s.provider != PROVIDER_GITHUB) revert BadSplit();
                if (s.accountId == 0) revert BadSplit();

                /*
                  ⛔⛔ THE METADATA MUST DESCRIBE THE BENEFICIARY, AND THAT IS PROVEN HERE.

                  Left unchecked, `provider` and `accountId` would be two numbers a launcher could
                  set to anything — so a token page naming the payee off them could name an account
                  that is not paid a penny, while the money went to a hash nobody could read. The
                  attack needs no cleverness: type one account, declare another.

                  ⚠ Checking it in the FRONT END was the alternative and is weaker: it makes a lie
                  detectable rather than unrepresentable, and only for readers using our page.

                  ➤ So the hash is recomputed from the declared pair and must equal the beneficiary.
                  It costs one string build, once, at construction.
                */
                bytes memory key = abi.encodePacked(
                    s.provider == PROVIDER_X ? "x:" : "github:", Strings.toString(s.accountId)
                );
                if (keccak256(key) != s.beneficiary) revert BeneficiaryMismatch(s.beneficiary, keccak256(key));

                needsClaims = true;
            } else {
                if (s.wallet != address(0) || s.beneficiary != bytes32(0)) revert BadSplit();
            }
            if (s.mode != Mode.XAccount && (s.provider != 0 || s.accountId != 0)) revert BadSplit();
            total += s.bps;
            _splits.push(s);
        }
        /* ⛔ EXACTLY 10,000, never "at most". A short split leaves a remainder with no owner, which
           accumulates here for ever with no function able to move it. */
        if (total != 10_000) revert BadSplit();
        if (needsClaims && claims_ == address(0)) revert ZeroAddress();

        ponsFactory = IPonsFactory(ponsFactory_);
        launchpad = ICharityLaunchpad(launchpad_);
        claims = ICharityFeeClaims(claims_);
        poolManager = IPoolManager(poolManager_);
    }

    /**
     * Bind this router to the launch it was made for, once the launch exists.
     *
     * ## ⛔⛔ WHY THE CHECK IS THREE READS AND NOT ONE
     *
     * `initialize` is one-shot, permissionless and this contract has no owner, so whoever binds it
     * first binds it for ever. The obvious check — "some launch's distributor pays me" — is not
     * enough, and the attack is the same one PonsiBurner documents: a router's address is public the
     * moment it is deployed, so anybody could deploy their OWN distributor naming this router as its
     * `opsVault`, launch a throwaway token pointing at that distributor, and call `initialize` first.
     * This router would be bound to the attacker's token and curve for ever, the real launch's call
     * would revert `AlreadyInitialized`, and every fee it later received would be spent buying a
     * token it has nothing to do with.
     *
     * ➤ So the token must ALSO be one **our own launchpad registered**. An attacker can deploy a
     * distributor and can make a Pons launch, but they cannot write an entry into our registry —
     * only `CharityLaunchpad` itself does that, in the same transaction as the launch it describes.
     *
     * The three reads, and what each rules out:
     *   1. `launchpad.isCharityLaunch(token_)` — this is one of ours, not a throwaway.
     *   2. `launchpad.distributorOf(token_) == record.creatorFeeRecipient` — our registry and Pons's
     *      record agree about who collects this launch's fees.
     *   3. `distributor.opsVault() == address(this)` — and that collector pays THIS router.
     */
    function initialize(address token_) external {
        if (token != address(0)) revert AlreadyInitialized();

        LaunchedToken memory record = ponsFactory.getLaunchedToken(token_);
        if (!record.exists) revert NotLaunched();
        if (!launchpad.isCharityLaunch(token_)) revert NotOurLaunch(token_);

        address distributor = launchpad.distributorOf(token_);
        if (distributor == address(0) || distributor != record.creatorFeeRecipient) {
            revert NotOurLaunch(token_);
        }
        if (ICharityDistributor(distributor).opsVault() != address(this)) revert NotOurLaunch(token_);

        token = token_;
        curve = IPonsCurve(record.curve);
        pairToken = record.pairToken;
        poolFee = record.poolFee;
        poolTickSpacing = record.tickSpacing;
        hooks = ponsFactory.memeHook();

        emit Initialized(token_, record.curve, record.pairToken);
    }

    function initialized() public view returns (bool) {
        return token != address(0);
    }

    /// ⚠ Required: a native-paired launch's fees arrive as a plain transfer from the distributor.
    receive() external payable {}

    function splits() external view returns (Split[] memory) {
        return _splits;
    }

    function splitCount() external view returns (uint256) {
        return _splits.length;
    }

    /* ------------------------------------------------------------- distribution -- */

    /**
     * Split everything that has arrived since the last call, and pay the legs that can be paid now.
     *
     * ⭐ PERMISSIONLESS. It moves money only to destinations fixed in this contract's own creation
     * code, so there is nothing for a caller to gain by calling it and nothing for them to steer.
     * That means the creator, the charity, a cranker or a stranger can all keep it moving, and it
     * cannot go quiet because one keeper died.
     *
     * @param asset what to split. Zero for native ETH. Normally the launch's pair asset, but any
     *        asset sent here is split on the same terms rather than being stranded.
     */
    function distribute(address asset) external returns (uint256 distributed) {
        /* ⛔ `claims.fund` records money against `token`, so an unbound router would ring-fence a
           real fee against the zero address — attributed to a launch that does not exist, and
           unclaimable by anyone for ever. */
        if (token == address(0)) revert NotInitialized();
        /* ⛔ The burn reserve is EXCLUDED, not subtracted afterwards. It is money this contract is
           already holding on behalf of a leg that has been paid; splitting it again would pay the
           wallet a second cut of it every time anybody called this. */
        uint256 held = _balance(asset);
        uint256 reserved = burnReserve[asset];
        distributed = held > reserved ? held - reserved : 0;
        if (distributed == 0) revert NothingToDistribute();

        uint256 toWallet;
        uint256 toClaims;
        uint256 toBurn;
        uint256 paid;

        for (uint256 i = 0; i < _splits.length; i++) {
            Split memory s = _splits[i];
            /* ⚠ The LAST share takes the remainder rather than its own rounded amount, so integer
               division cannot leave dust behind on every call. Over thousands of small fees that
               dust is the difference between a contract that empties and one that silently fills. */
            uint256 share = i == _splits.length - 1
                ? distributed - paid
                : (distributed * s.bps) / 10_000;
            paid += share;
            if (share == 0) continue;

            if (s.mode == Mode.Wallet) {
                toWallet += share;
                _send(asset, s.wallet, share);
            } else if (s.mode == Mode.XAccount) {
                toClaims += share;
                _fundClaims(asset, s.beneficiary, share);
            } else {
                toBurn += share;
            }
        }

        if (toBurn > 0) burnReserve[asset] += toBurn;

        totalToWallet[asset] += toWallet;
        totalToClaims[asset] += toClaims;
        totalToBurn[asset] += toBurn;

        emit Distributed(asset, toWallet, toClaims, toBurn);
    }

    /* --------------------------------------------------------------- buy and burn -- */

    /**
     * Spend the burn reserve buying this launch's token, and destroy every one bought.
     *
     * ⭐ PERMISSIONLESS, and there is no path here that moves value to the caller: the only things
     * this function can do with the money are buy the token and burn it.
     *
     * @param minTokensOut the slippage floor, quoted off chain immediately before the call.
     *        ⚠⚠ ZERO IS NOT "NO LIMIT", IT IS "ANY FILL IS ACCEPTABLE" — a standing, permissionless
     *        buy with no floor is an invitation to sandwich it. The caller is expected to simulate
     *        this exact call and pass the result less a tolerance.
     *
     * ⛔ Reverts once graduated. `curve.buy` stops working the moment a launch leaves its curve, and
     * it does not fail gracefully — see {buyAndBurnOnPool}, which is the same leg after graduation.
     */
    function buyAndBurn(uint256 minTokensOut) external returns (uint256 bought, uint256 burned) {
        if (token == address(0)) revert NotInitialized();
        if (curve.graduated()) revert AlreadyGraduated();

        uint256 quote = burnReserve[pairToken];
        if (quote == 0) revert NothingToBurn();
        /* ⛔⛔ ZEROED BEFORE THE CALL, NOT AFTER. `curve.buy` hands control to Pons's contract; a
           reserve still standing at that moment is a reserve a reentrant caller could spend twice. */
        burnReserve[pairToken] = 0;

        uint256 heldBefore = IERC20(token).balanceOf(address(this));

        if (pairToken == address(0)) {
            curve.buy{value: quote}(quote, minTokensOut, address(this));
        } else {
            /* ⚠ Set to zero first. Some ERC-20s refuse a non-zero-to-non-zero approve, and a router
               that had cranked once would then never crank again, with nobody able to fix it. */
            IERC20(pairToken).approve(address(curve), 0);
            IERC20(pairToken).approve(address(curve), quote);
            curve.buy(quote, minTokensOut, address(this));
        }

        bought = IERC20(token).balanceOf(address(this)) - heldBefore;
        if (bought < minTokensOut) revert TooLittleOut(bought, minTokensOut);

        burned = _burnHeld();
        emit BoughtAndBurned(pairToken, quote, burned, IERC20(token).totalSupply());
    }

    /**
     * The same leg, after the launch has graduated onto its Uniswap V4 pool.
     *
     * ⛔⛔ A SEPARATE FUNCTION RATHER THAN A BRANCH, because the two are not the same risk. The curve
     * is a fixed-formula contract with no counterparty; the pool is a live order book where the
     * quote that produced `minTokensOut` can be gone by the time this lands. Naming them apart keeps
     * a caller from passing a curve quote to a pool buy.
     */
    function buyAndBurnOnPool(uint256 minTokensOut) external returns (uint256 bought, uint256 burned) {
        if (token == address(0)) revert NotInitialized();
        if (!curve.graduated()) revert StillOnCurve();
        if (address(poolManager) == address(0)) revert NoPool();

        uint256 quote = burnReserve[pairToken];
        if (quote == 0) revert NothingToBurn();
        burnReserve[pairToken] = 0;

        uint256 heldBefore = IERC20(token).balanceOf(address(this));
        poolManager.unlock(abi.encode(quote));
        bought = IERC20(token).balanceOf(address(this)) - heldBefore;
        if (bought < minTokensOut) revert TooLittleOut(bought, minTokensOut);

        burned = _burnHeld();
        emit BoughtAndBurned(pairToken, quote, burned, IERC20(token).totalSupply());
    }

    /*
      ⚠ V4's price limits. A swap must name one, and for a plain market buy the only sensible choice
      is the extreme in the direction of travel — "no limit". The +1 / -1 are required: the bounds
      themselves are rejected. ⛔ This is NOT the slippage control; `minTokensOut` is. A price limit
      alone lets a swap partially fill and return early, which reads as success while spending less
      than intended.
    */
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    /// ⚠ v4 calls this back only on the address that called `unlock`. The check is here anyway,
    /// because a guard that depends on reading someone else's source is not a guard.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amountIn = abi.decode(data, (uint256));

        (IPoolManager.PoolKey memory key, bool pairIsZero) = _poolKey();

        /* ⚠ NEGATIVE amountSpecified is EXACT INPUT. Positive is exact output, which would ask the
           pool for a fixed number of tokens and spend whatever that costs — unbounded, out of a
           reserve that is not ours to overspend. */
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
           right — that exact misreading shipped a live bug on the stonks indexer, where every buy
           was labelled a sell and nothing on screen looked wrong. Same convention as V4Seller. */
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
        totalTokensBurned += amount;
    }

    function _fundClaims(address asset, bytes32 beneficiary, uint256 amount) private {
        if (asset == address(0)) {
            claims.fund{value: amount}(token, beneficiary, asset, amount);
        } else {
            IERC20(asset).approve(address(claims), 0);
            IERC20(asset).approve(address(claims), amount);
            claims.fund(token, beneficiary, asset, amount);
        }
    }

    function _balance(address asset) private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    /**
     * ⛔ Tolerates a token that returns nothing. A bare `IERC20.transfer` reverts on any token whose
     * ABI predates the bool return — a decoding failure, not a transfer failure, and
     * indistinguishable in the logs.
     */
    function _send(address asset, address to, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
            return;
        }
        (bool ok2, bytes memory out) =
            asset.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok2 || (out.length != 0 && !abi.decode(out, (bool)))) revert TransferFailed();
    }
}
