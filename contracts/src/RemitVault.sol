// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * Where charity shares pool on Robinhood Chain, and the only door out of it.
 *
 * ## ⛔⛔ WHAT THIS CANNOT DO, SAID FIRST
 *
 * Relay's deposit calldata is `0x49290c1c || user || requestId`. **The recipient is not in it.** It
 * lives in Relay's off-chain request, so this contract cannot check where a bridge lands, and no
 * contract on this chain can. That hop is trusted. Any design claiming otherwise is wrong, and a
 * vault that merely *looked* like it constrained the destination would be worse than an ordinary
 * wallet, because it would buy false confidence.
 *
 * ## ⭐⭐ WHAT IT DOES DO, WHICH IS WORTH HAVING
 *
 * 1. **There is no withdraw.** Money here can leave to exactly one address: Relay's depositor,
 *    verified stable across every asset and size quoted. A compromised keeper cannot transfer funds
 *    to itself; it can only push them into a public bridge.
 * 2. **It emits the request id.** The id is parsed out of the calldata and logged, so every remit is
 *    resolvable through Relay's public API to the address it actually paid. Misdirection stops being
 *    something you would have to go looking for and becomes a permanent public record, automatically.
 * 3. **It caps a single remit.** One bad call cannot move more than `maxPerRemit`, so the damage a
 *    compromised key can do in one transaction is bounded and visible.
 * 4. **The guardian can rotate the keeper and do nothing else.** There is no path from guardian to
 *    money, so the key that recovers from a compromise is not itself worth stealing.
 *
 * ➤ Combined with `CharityPayer` on the far side, whose funds can only leave through the donation
 * relay, the trusted surface is one bridge transfer, publicly logged at both ends.
 */
contract RemitVault {
    /**
     * Relay's deposit address on Robinhood Chain.
     *
     * ⚠⚠ IMMUTABLE, AND THAT IS A REAL RISK ACCEPTED DELIBERATELY. If Relay ever moves it, this
     * vault can no longer send anything and whatever is in it is stuck. The alternative is a
     * settable address, which is a withdraw function wearing a different name: set it to your own
     * address and the vault pays you. Stuck is recoverable by deploying a new vault and pointing
     * new launches at it. A redirect is not recoverable at all.
     */
    address public immutable relayDepositor;

    /// The only account that may send. Rotatable by the guardian, and by nobody else.
    address public keeper;

    /// May rotate the keeper. ⛔ Has no path to the money, by construction.
    address public immutable guardian;

    /**
     * The most one call may move, in NATIVE wei.
     *
     * ⚠ Immutable, so it cannot be raised in the moment somebody wants it raised.
     */
    uint256 public immutable maxNativePerRemit;

    /**
     * ⛔⛔ A CAP PER ASSET, BECAUSE ONE NUMBER CANNOT BOUND TWO DECIMAL SCALES.
     *
     * A single raw-units cap sized for ETH is five million million USDG, which is to say no cap at
     * all for a six decimal asset. Both are `uint256` so nothing reverts and nothing looks wrong:
     * the guard simply stops existing for whichever asset it was not sized for. This repo has
     * shipped that exact bug before, in a different contract, for the same reason.
     *
     * ⭐ Set once in the constructor with NO setter. An asset with no cap is refused outright rather
     * than defaulting to unlimited: failing closed means a new pair asset needs a new vault, which
     * is a deployment inconvenience rather than an unbounded transfer.
     */
    mapping(address => uint256) public maxTokenPerRemit;

    /**
     * ⭐ The public receipt, emitted on chain rather than written to a log file we control.
     * `requestId` resolves through Relay's own API to the address that was actually paid.
     */
    event Remitted(address indexed token, uint256 amount, bytes32 indexed requestId);
    event KeeperChanged(address indexed from, address indexed to);

    error NotKeeper();
    error NotGuardian();
    error OverCap(uint256 amount, uint256 cap);
    /// ⚠ Raised for an asset that was never given a cap. Refusing beats guessing one.
    error NoCapForAsset(address token);
    error CapMismatch();
    error NothingToSend();
    error BadDepositData();
    error ZeroAddress();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(
        address relayDepositor_,
        address keeper_,
        address guardian_,
        uint256 maxNativePerRemit_,
        address[] memory tokens,
        uint256[] memory caps
    ) {
        if (relayDepositor_ == address(0) || keeper_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (tokens.length != caps.length) revert CapMismatch();
        relayDepositor = relayDepositor_;
        keeper = keeper_;
        guardian = guardian_;
        maxNativePerRemit = maxNativePerRemit_;
        for (uint256 i = 0; i < tokens.length; i++) {
            /* ⚠ A zero cap would be indistinguishable from an unset one, and would silently make the
               asset unremittable rather than saying so at deploy time. */
            if (tokens[i] == address(0) || caps[i] == 0) revert CapMismatch();
            maxTokenPerRemit[tokens[i]] = caps[i];
        }
    }

    /// ⚠ Required: the distributor pays the native share by sending.
    receive() external payable {}

    /**
     * ⛔⛔ THE CALLDATA IS CHECKED, NOT FORWARDED BLIND.
     *
     * Relay's deposit is exactly 68 bytes: a `0x49290c1c` selector, the depositing account, and the
     * request id. Anything else is refused. Without this the keeper could hand the vault arbitrary
     * calldata for the depositor address and use it as a general-purpose call, which is the
     * withdraw function this contract does not have.
     *
     * ⚠ The `user` field is required to be this contract. Relay refunds a failed request to the
     * account named there, so a deposit naming somebody else routes the refund away from the vault.
     */
    function _requestId(bytes calldata depositData) internal view returns (bytes32 id) {
        if (depositData.length != 68) revert BadDepositData();
        if (bytes4(depositData[0:4]) != bytes4(0x49290c1c)) revert BadDepositData();
        address user = address(uint160(uint256(bytes32(depositData[4:36]))));
        if (user != address(this)) revert BadDepositData();
        id = bytes32(depositData[36:68]);
    }

    /** Bridge an ERC-20 balance out through Relay. */
    function remitToken(address token, uint256 amount, bytes calldata depositData) external onlyKeeper {
        if (amount == 0) revert NothingToSend();
        uint256 cap = maxTokenPerRemit[token];
        if (cap == 0) revert NoCapForAsset(token);
        if (amount > cap) revert OverCap(amount, cap);
        bytes32 id = _requestId(depositData);

        /* ⚠ Reset to zero first: some tokens refuse a non-zero to non-zero approve. */
        if (IERC20Min(token).allowance(address(this), relayDepositor) != 0) {
            IERC20Min(token).approve(relayDepositor, 0);
        }
        IERC20Min(token).approve(relayDepositor, amount);

        (bool ok,) = relayDepositor.call(depositData);
        if (!ok) revert BadDepositData();

        emit Remitted(token, amount, id);
    }

    /** Bridge native ETH out through Relay. */
    function remitNative(uint256 amount, bytes calldata depositData) external onlyKeeper {
        if (amount == 0) revert NothingToSend();
        if (amount > maxNativePerRemit) revert OverCap(amount, maxNativePerRemit);
        bytes32 id = _requestId(depositData);

        (bool ok,) = relayDepositor.call{value: amount}(depositData);
        if (!ok) revert BadDepositData();

        emit Remitted(address(0), amount, id);
    }

    /**
     * ⚠ The guardian's only power. It cannot move money, cannot change the cap, and cannot change
     * where the vault is allowed to send: it exists so a compromised keeper can be cut off without
     * needing a key that is itself worth stealing.
     */
    function setKeeper(address next) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (next == address(0)) revert ZeroAddress();
        emit KeeperChanged(keeper, next);
        keeper = next;
    }
}
