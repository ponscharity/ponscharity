// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CharityDistributor, IPonsFeeEscrow} from "./CharityDistributor.sol";
import {IPoolManager} from "./V4Seller.sol";
/* ⚠ `forceApprove`, not `approve`. USDT style tokens revert on a non zero to non zero approval, and
   the pair asset here is whatever Pons has approved rather than a token this contract chose. */
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * Pons V2's launch factory, `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.
 *
 * ⭐⭐ `creatorFeeRecipient` IS A LAUNCH PARAMETER. That is the fact this whole contract turns on:
 * the charity's distributor can be named at launch, so there is no `transferCreatorFeeRecipient`
 * afterwards and therefore no window in which a launch exists with its fees pointed somewhere else.
 * One signature, or nothing.
 */
interface IPonsV2Factory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

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

    function launchToken(LaunchParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);

    /**
     * ⭐⭐ The overload that DECLARES SNIPE TAX EXEMPTIONS, and the only way to exempt anyone on a
     * launch with no atomic developer buy. It is a second entrypoint, not a variant: an empty array
     * is not the same calldata as the three argument call, so the shorter one is still sent when
     * there is nothing to declare.
     */
    function launchToken(
        LaunchParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);

    /**
     * ⚠ Rotatable. Only the address this returns may call `launchTokenFor`, so the atomic path is
     * read live and turns itself off rather than pinning an address that reverts
     * `NotLaunchForwarder` the day Pons replaces the periphery.
     */
    function launchForwarder() external view returns (address);

    function launchEnabled() external view returns (bool);
    function launchFee() external view returns (uint256);
    function maxCreatorTaxBps() external view returns (uint256);
    function approvedPairTokens(address pairToken) external view returns (bool);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function feeEscrow() external view returns (address);
}

/**
 * `PonsV2LaunchAndBuy`, Pons's periphery: launch and developer buy settled in ONE transaction.
 *
 * ⛔⛔ THE ONLY WAY TO BUY AT LAUNCH WITHOUT BEING SNIPED. The launch and the buy land together, so
 * there is no intermediate state for anyone to trade against. A buy sent as a follow up transaction
 * is a separate block for a bot to get in front of, and it pays the snipe tax as well.
 *
 * ⚠⚠ Its native value check is EXACT: `launchFee + quoteIn` for a native pair, `launchFee` alone
 * otherwise, and anything else reverts `NativeValueMismatch`. There is no slack and no tip.
 */
interface IPonsV2LaunchAndBuy {
    function launchAndBuy(
        IPonsV2Factory.LaunchParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve, uint256 tokensOut);
}

/**
 * The launchpad: one transaction that creates a token whose fees can only ever reach a charity.
 *
 * ## What one call does
 *
 * 1. Deploys a `CharityDistributor` with the charity address and the split written in as
 *    `immutable` constructor arguments.
 * 2. Launches the token on Pons V2 with `creatorFeeRecipient` set to that distributor.
 * 3. Records the pair in an on-chain registry.
 *
 * ⭐⭐ ATOMIC, AND THAT IS THE POINT. Done as three transactions there is a window in which a live
 * token is earning fees into the launcher's own wallet, and a launch that stops after step two is
 * an ordinary token wearing a charity's name — the precise thing this exists to make impossible. A
 * partial launch here does not exist: it reverts.
 *
 * ## ⭐⭐ WHY THE REGISTRY IS AN ARRAY AND NOT AN EVENT
 *
 * Robinhood Chain makes a block roughly every 100ms — 861,000 a day — and the public RPC caps
 * `eth_getLogs` at 2,000 blocks, about three minutes of history. **A launch feed built on events is
 * impossible to read from a browser** and needs an indexer with a persisted cursor, a database, a
 * daemon and a port. An array read with `eth_call` needs none of those and cannot fall behind.
 *
 * ➤ So the site is static. There is no backend to run, no cursor to lose, and no moment where the
 * listing and the chain disagree.
 */
contract CharityLaunchpad {
    using SafeERC20 for IERC20;

    IPonsV2Factory public immutable factory;
    IPonsFeeEscrow public immutable escrow;
    IPoolManager public immutable poolManager;
    address public immutable usdg;
    uint16 public immutable maxSellSlippageBps;

    /**
     * The floor on a launch's charity share, fixed at deployment.
     *
     * ⛔⛔ A LAUNCHPAD THAT ACCEPTS ANY SPLIT IS NOT A CHARITY LAUNCHPAD. Without a floor, the first
     * token to launch here at 1% would still carry the site's branding, the charity's name and the
     * registry listing — which is donate.gg's whole failure in one launch: a nonprofit's identity
     * doing the marketing for something that was never going to pay it. The number is on chain and
     * checkable rather than a rule the front end promises to apply.
     */
    uint16 public immutable minCharityBps;

    struct Entry {
        address token;
        address curve;
        address distributor;
        /// Where the charity's share lands on this chain. See `charityId` for WHO it is for.
        address charity;
        /// Who launched it, and where their share of the fees goes.
        address creator;
        address pairToken;
        uint16 charityBps;
        uint64 launchedAt;
        /**
         * ⭐⭐ WHICH CHARITY, WRITTEN IN FOREVER.
         *
         * A donate.gg config id: the 32 byte identifier their public `DonationRelayUpgradeableV1`
         * routes a donation by. It is recorded here because the charity's own receiving account is
         * not an address on this chain, so the promise "this token pays St. Jude" cannot live in
         * the `charity` field alone.
         *
         * ⛔⛔ THIS IS THE PROMISE, AND IT IS IMMUTABLE. The vault the money passes through is
         * operated; WHO it is destined for is not. Anyone can read this id, look it up on
         * donate.gg, and hold the operator to it. That is the whole reason it is on chain rather
         * than in a database, and it is what a launch made through a custodial charity platform
         * has never had.
         *
         * ⚠ Zero means the charity was named by address instead, which is still supported: a
         * charity that publishes its own wallet does not need a processor in the middle.
         */
        bytes32 charityId;
    }

    Entry[] private _launches;

    /// ⚠ Kept beside the array so a front end can ask "is this token one of ours" without a scan.
    mapping(address => uint256) private _indexOfPlusOne;

    event CharityLaunch(
        address indexed token,
        address indexed distributor,
        address indexed charity,
        bytes32 charityId,
        address creator,
        uint16 charityBps
    );

    error LaunchesClosed();
    error CharityShareTooSmall(uint16 asked, uint16 floorRequired);
    error ZeroAddress();
    error PairTokenNotApproved(address pairToken);
    error EconomicsMoved(bytes32 pinned, bytes32 live);
    /** Pons has no periphery set, so no launch here can carry an atomic developer buy. */
    error DevBuyUnavailable();

    constructor(
        IPonsV2Factory factory_,
        IPoolManager poolManager_,
        address usdg_,
        uint16 maxSellSlippageBps_,
        uint16 minCharityBps_
    ) {
        if (address(factory_) == address(0) || usdg_ == address(0)) revert ZeroAddress();
        factory = factory_;
        escrow = IPonsFeeEscrow(factory_.feeEscrow());
        poolManager = poolManager_;
        usdg = usdg_;
        maxSellSlippageBps = maxSellSlippageBps_;
        minCharityBps = minCharityBps_;
    }

    /**
     * Launch a token whose creator fees are split between a charity and the creator, permanently.
     *
     * @param params Pons's own launch struct. ⚠ `creatorFeeRecipient` is IGNORED and overwritten
     *        with the distributor this call creates — passing one is not a way to redirect the fees.
     * @param charity Where the charity share goes on THIS chain. Immutable from this moment.
     * @param charityId Which charity it is destined for, as a donate.gg config id. ⛔ Recorded
     *        immutably and never validated on chain: the relay itself accepts an id that belongs to
     *        nobody, so a wrong one is a permanent, silent misdirection. The interface takes it only
     *        from a charity's own published page.
     * @param creatorPayout Where the creator's remainder goes. May be zero only at a 100% split.
     * @param charityBps The charity's share of every fee, for the life of the token.
     */
    struct DevBuy {
        uint256 quoteIn;
        uint256 minTokensOut;
    }

    /**
     * ⚠ Bundled because ten flat arguments overflow the stack on the legacy pipeline, and the fix
     * for that is a struct rather than turning `viaIR` on for the whole project: the sibling
     * contracts are already deployed and verified against this exact compiler configuration.
     */
    struct CharityTerms {
        address charity;
        bytes32 charityId;
        address creatorPayout;
        uint16 charityBps;
    }

    function _noExemptions() private pure returns (address[] memory none) {
        none = new address[](0);
    }

    /**
     * Sends the launch to Pons by the narrowest route that does what was asked.
     *
     * ⛔⛔ THREE ENTRYPOINTS, AND AN EMPTY ARRAY IS NOT THE SAME CALLDATA AS NO ARRAY. The plain
     * three argument `launchToken` is still sent when there is nothing to declare and nothing to
     * buy, because that is the call this launchpad has always made and the one Pons has always seen
     * from it. The four argument overload is a different entrypoint that runs the same body and then
     * loops the exemptions; the periphery is a different contract entirely.
     */
    function _launchOnPons(
        IPonsV2Factory.LaunchParams memory params,
        uint256 launchConfigId,
        address pairToken,
        DevBuy memory devBuy,
        address[] memory exemptions
    ) private returns (address token, address curve) {
        if (devBuy.quoteIn == 0) {
            if (exemptions.length == 0) {
                return factory.launchToken{value: msg.value}(params, launchConfigId, pairToken);
            }
            return factory.launchToken{value: msg.value}(params, launchConfigId, pairToken, exemptions);
        }

        /* ⚠ Read live, never pinned. `launchForwarder` is a setter on the factory and only the
           address it currently returns may call `launchTokenFor`. Pinning one turns the day Pons
           rotates the periphery into an opaque `NotLaunchForwarder` for every buyer. */
        address forwarder = factory.launchForwarder();
        if (forwarder == address(0)) revert DevBuyUnavailable();

        bool nativeQuote = pairToken == address(0);
        uint256 forwardValue = msg.value;

        if (!nativeQuote) {
            /*
              ⛔⛔ THE PERIPHERY PULLS THE QUOTE FROM ITS OWN CALLER, WHICH IS THIS CONTRACT.
              `safeTransferFrom(msg.sender, address(this), quoteIn)` runs inside the periphery, and
              its `msg.sender` is this launchpad, not the launcher. So the tokens have to be brought
              here first and approved onward. The launcher approves THIS contract; a launcher who
              approved the periphery instead would have their allowance sit unused.
            */
            IERC20(pairToken).safeTransferFrom(msg.sender, address(this), devBuy.quoteIn);
            IERC20(pairToken).forceApprove(forwarder, devBuy.quoteIn);
        }

        /* ⭐ `recipient` is the LAUNCHER. See the note on `launchWithBuy`: the fee recipient here is
           a contract that cannot release a token balance, so getting this wrong is permanent. */
        (token, curve,) = IPonsV2LaunchAndBuy(forwarder).launchAndBuy{value: forwardValue}(
            params, launchConfigId, pairToken, devBuy.quoteIn, devBuy.minTokensOut, msg.sender, exemptions
        );

        /* ⚠ Allowance driven to zero rather than left at whatever the periphery did not spend. A
           residue on a rotatable address is a standing approval nobody is tracking. */
        if (!nativeQuote) IERC20(pairToken).forceApprove(forwarder, 0);
    }

    function launch(
        IPonsV2Factory.LaunchParams memory params,
        uint256 launchConfigId,
        address pairToken,
        address charity,
        bytes32 charityId,
        address creatorPayout,
        uint16 charityBps
    ) external payable returns (address token, address curve, address distributor) {
        return _launch(
            params, launchConfigId, pairToken,
            CharityTerms({charity: charity, charityId: charityId, creatorPayout: creatorPayout, charityBps: charityBps}),
            DevBuy({quoteIn: 0, minTokensOut: 0}), _noExemptions()
        );
    }

    /**
     * The same launch, with a developer buy and declared snipe tax exemptions.
     *
     * ## ⛔⛔ THE BOUGHT TOKENS GO TO `msg.sender`, AND THAT IS THE WHOLE POINT
     *
     * Pons V1 chose the buyer for you: `initialBuyRecipient = feeWallet == 0 ? msg.sender :
     * feeWallet`, so a developer buy on a launch whose fee recipient was some other wallet paid for
     * tokens that landed in **that wallet**. It has fired on this stack before and cost real supply.
     *
     * ➤ Here the fee recipient is a `CharityDistributor`, a contract with no owner and no way to
     * move a token balance out. The V1 behaviour would send a launcher's purchase into a contract
     * that can never release it. V2 takes `recipient` explicitly, and this passes `msg.sender`:
     * never the distributor, never this launchpad.
     *
     * @param terms The charity, its config id, the creator remainder and the split.
     * @param devBuy `quoteIn` in the pair asset's own units, zero to opt out, and the slippage floor.
     *        ⚠ A zero `minTokensOut` is a free sandwich; the interface computes one.
     * @param snipeTaxExemptions Wallets that may buy in the launch second without paying the tax.
     */
    function launchWithBuy(
        IPonsV2Factory.LaunchParams memory params,
        uint256 launchConfigId,
        address pairToken,
        CharityTerms calldata terms,
        DevBuy calldata devBuy,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve, address distributor) {
        return _launch(params, launchConfigId, pairToken, terms, devBuy, snipeTaxExemptions);
    }

    function _launch(
        IPonsV2Factory.LaunchParams memory params,
        uint256 launchConfigId,
        address pairToken,
        CharityTerms memory terms,
        DevBuy memory devBuy,
        address[] memory exemptions
    ) internal returns (address token, address curve, address distributor) {
        if (!factory.launchEnabled()) revert LaunchesClosed();
        if (terms.charityBps < minCharityBps) revert CharityShareTooSmall(terms.charityBps, minCharityBps);
        if (terms.charity == address(0)) revert ZeroAddress();
        if (pairToken != address(0) && !factory.approvedPairTokens(pairToken)) {
            revert PairTokenNotApproved(pairToken);
        }

        /*
          ⛔⛔ THE ECONOMICS PIN IS RE-CHECKED HERE, NOT JUST PASSED THROUGH.

          Pons already reverts if `expectedEconomics` has moved, so this looks redundant — and it is
          not. Its own revert surfaces as an opaque factory error after the distributor has already
          been deployed inside this transaction, which unwinds correctly but tells the user nothing.
          Checking first turns "the launch failed" into "the terms moved between your preview and
          your signature, read them again", which is the difference between a retry and a support
          message.
          ⚠ A zero pin means the caller opted out, which Pons permits; not second-guessed here.
        */
        if (params.expectedEconomics != bytes32(0)) {
            bytes32 live = factory.previewLaunchEconomics(launchConfigId, pairToken);
            if (live != params.expectedEconomics) revert EconomicsMoved(params.expectedEconomics, live);
        }

        distributor = address(
            new CharityDistributor(
                escrow,
                terms.charity,
                terms.creatorPayout,
                terms.charityBps,
                poolManager,
                usdg,
                maxSellSlippageBps
            )
        );

        /* ⭐ Overwritten, never trusted from the caller. The distributor is the only address that
           can be the fee recipient of a launch made here, and it did not exist until a moment ago. */
        params.creatorFeeRecipient = distributor;

        (token, curve) = _launchOnPons(params, launchConfigId, pairToken, devBuy, exemptions);

        _indexOfPlusOne[token] = _launches.length + 1;
        _launches.push(
            Entry({
                token: token,
                curve: curve,
                distributor: distributor,
                charity: terms.charity,
                creator: msg.sender,
                pairToken: pairToken,
                charityBps: terms.charityBps,
                launchedAt: uint64(block.timestamp),
                charityId: terms.charityId
            })
        );

        emit CharityLaunch(token, distributor, terms.charity, terms.charityId, msg.sender, terms.charityBps);
    }

    /* ---------------------------------------------------------------- registry -- */

    function count() external view returns (uint256) {
        return _launches.length;
    }

    /**
     * A page of the registry, newest first.
     *
     * ⭐ Newest-first because that is the only order a launch feed is ever read in, and reversing a
     * page in the browser means the page boundaries are wrong. ⚠ Clamped rather than reverting on a
     * range past the end: a feed that throws when someone scrolls one page too far is a feed that
     * breaks the moment two launches happen while a visitor is reading.
     */
    function page(uint256 offset, uint256 limit) external view returns (Entry[] memory out) {
        uint256 n = _launches.length;
        if (offset >= n || limit == 0) return new Entry[](0);
        uint256 take = n - offset;
        if (take > limit) take = limit;
        out = new Entry[](take);
        for (uint256 i = 0; i < take; i++) {
            out[i] = _launches[n - 1 - offset - i];
        }
    }

    /// ⚠ Reverts for a token this launchpad did not create, rather than returning an empty struct
    /// that a caller would render as a charity launch with a zero charity.
    function entryOf(address token) external view returns (Entry memory) {
        uint256 idx = _indexOfPlusOne[token];
        if (idx == 0) revert ZeroAddress();
        return _launches[idx - 1];
    }

    function isCharityLaunch(address token) external view returns (bool) {
        return _indexOfPlusOne[token] != 0;
    }
}
