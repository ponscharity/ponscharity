// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDonationRelay {
    function donateNative(bytes32 configId, uint256 tipBps, address creditedTo, bytes calldata message) external payable;
    function donateToken(bytes32 configId, address token, uint256 amountIn, uint256 tipBps, address creditedTo, bytes calldata message) external;
}

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * The far side of the bridge: a contract on Base whose money can only ever reach a charity.
 *
 * ## ⭐⭐ WHY THIS EXISTS, AND WHAT IT ACTUALLY FIXES
 *
 * Relay's deposit calldata is `0x49290c1c || user || keccak(request)`. **The recipient is not in
 * it** — it lives in Relay's off-chain request — so no contract on Robinhood Chain can verify where
 * a bridge lands. That one hop is unavoidably trusted, and every honest description of this system
 * has to say so.
 *
 * ➤ What is NOT unavoidable is trusting everything after it. Bridge into this contract and the
 * money stops being discretionary: the only outbound call it can make is `donateToken` or
 * `donateNative` on donate.gg's relay. There is no owner, no withdraw, no rescue, no upgrade and no
 * arbitrary call. A key that could misdirect the bridge cannot touch what has already arrived.
 *
 * ➤ So the trusted surface shrinks from "an operator holds the charity's money and sends it on" to
 * "an operator points one bridge transfer, in public, at an address anyone can check". And because
 * `pay` is permissionless, the operator is not even needed for the last step: the charity, a
 * watchdog, or a stranger can complete it.
 *
 * ## ⛔⛔ THE RELAY DOES NOT VALIDATE THE CONFIG ID
 *
 * Proven on a Base fork: `donateToken` succeeds with an id belonging to nobody and the money is
 * gone, with a successful transaction to show for it. This contract therefore cannot check that a
 * config id is real, and it does not pretend to. What it guarantees is narrower and still worth
 * having: whatever arrives here leaves through the donation relay and nowhere else.
 *
 * ⚠ It follows that `pay` is safe to leave open but not safe to call carelessly. The caller supplies
 * the id, so a caller who invents one destroys the funds. The id belongs on chain in the launch,
 * and the runner reads it from there.
 */
contract CharityPayer {
    /// `DonationRelayUpgradeableV1`. Immutable: a settable relay is a redirect by another name.
    IDonationRelay public immutable relay;

    event Paid(bytes32 indexed configId, address indexed token, uint256 amount);

    error NothingToPay();
    error ZeroConfig();

    constructor(IDonationRelay relay_) {
        relay = relay_;
    }

    /* ⚠ Required so a native bridge delivery can land. Relay pays a native recipient by sending. */
    receive() external payable {}

    /**
     * Donate everything this contract holds of `token` to `configId`.
     *
     * ⭐⭐ PERMISSIONLESS AND ALL-OR-NOTHING. Both matter:
     *
     * - **Permissionless**, so completing a remit needs no key of ours. If the operator disappears,
     *   the charity or anybody else can finish it, and the money is never stranded behind one
     *   person's availability.
     * - **All of it**, because a partial amount is a discretion, and discretion over somebody
     *   else's donation is the thing this contract exists to remove. There is no version of this
     *   call that leaves a remainder behind for later.
     *
     * ⚠ `tipBps` is hardcoded to zero. The relay supports a tip to the integrator, and taking one
     * out of a charity's money without the charity or the donor choosing it is not a fee, it is a
     * deduction. Hardcoded rather than defaulted so it cannot be changed by a caller.
     */
    function pay(bytes32 configId, address token) external returns (uint256 amount) {
        if (configId == bytes32(0)) revert ZeroConfig();

        amount = IERC20Min(token).balanceOf(address(this));
        if (amount == 0) revert NothingToPay();

        /*
          ⚠⚠ Approval reset to zero first. USDT on Ethereum reverts on a non-zero to non-zero
          approve, and this contract is meant to be deployable on any chain the relay reaches. The
          allowance is also spent to exactly zero by the donation, so a leftover approval cannot
          accumulate.
        */
        if (IERC20Min(token).allowance(address(this), address(relay)) != 0) {
            IERC20Min(token).approve(address(relay), 0);
        }
        IERC20Min(token).approve(address(relay), amount);

        /* ⚠ `creditedTo` is this contract, not the caller. The credit is a public attribution of who
           gave, and attributing a charity's own money to whichever stranger pushed the button would
           put a person's name on a donation they did not make. */
        relay.donateToken(configId, token, amount, 0, address(this), "");

        emit Paid(configId, token, amount);
    }

    /** The same for a native delivery. */
    function payNative(bytes32 configId) external returns (uint256 amount) {
        if (configId == bytes32(0)) revert ZeroConfig();
        amount = address(this).balance;
        if (amount == 0) revert NothingToPay();
        relay.donateNative{value: amount}(configId, 0, address(this), "");
        emit Paid(configId, address(0), amount);
    }
}
