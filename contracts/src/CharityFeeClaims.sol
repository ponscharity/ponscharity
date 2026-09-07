// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PONSI — paying a launch's fees to whoever proves they own the X account it was launched for.
 *
 * ## Why a contract rather than the server just sending
 *
 * PONSI could pay people from a hot wallet. It does not, because of the blast radius: a wallet that
 * can send can send **everything**, so one leaked key costs every creator their balance at once.
 * Here the server holds a key that can only ever **sign a voucher**. It cannot move money, cannot
 * withdraw, and cannot change where a voucher pays. The creator submits their own claim and pays
 * their own gas, so a payout is something they do rather than something they wait for.
 *
 * ## ⭐⭐ WHAT THIS ADDS OVER THE OBVIOUS DESIGN: money is RING FENCED PER RECIPIENT
 *
 * The straightforward version of this contract holds one pot per asset and lets any valid voucher
 * draw from it. That works right up until something goes wrong, and then it fails in the worst
 * possible way: a voucher signed for too much on token A is paid out of money that belonged to
 * token B, and B's creator discovers it when their own claim bounces. One arithmetic mistake in an
 * off chain entitlement, or one compromised signer, drains everybody.
 *
 * ➤ So attribution lives HERE rather than in a database. Money enters against a named launch AND a
 * named beneficiary, and a voucher can only ever draw what that pair was credited. One creator
 * being paid from another's fees is not prevented by a rule, it is **unrepresentable**.
 *
 * ⭐⭐ The beneficiary matters as much as the launch, because a launch's fees can be SPLIT between
 * several people. If the ledger stopped at the launch, a split would be a promise kept by whatever
 * signed the vouchers, and a mistake would pay one recipient out of their co-recipient's share.
 * Keyed per pair, a 70/30 split is enforced by the same arithmetic that enforces everything else.
 *
 * ⚠ A beneficiary is an opaque `bytes32` and this contract never interprets it. Pons Charity uses
 * `keccak256("x:12345")` or `keccak256("github:678")`, which means adding another way of proving who
 * you are needs no change here at all.
 *
 * ⭐ It also makes the owner harmless to creators. `withdraw` can only take what is NOT owed:
 * `outstanding` tracks every credited-but-unclaimed unit, and the owner is refused anything below
 * that line. PONSI cannot take a creator's fees even if PONSI wants to.
 *
 * ## ⚠⚠ WHAT THIS CONTRACT STILL DOES NOT KNOW
 *
 * It does not know what any launch earned, or who owns an X account. PONSI computes both and signs
 * accordingly. What is guaranteed here is narrower and still worth having: a voucher is good
 * exactly once, only for the wallet named in it, only until it expires, and **only up to what its
 * own launch has been credited**. So `claimedFor` is publicly checkable against what that launch's
 * fee route ever delivered.
 *
 * ## ⛔⛔ THIS CONTRACT CAN NEVER BE REPLACED ONCE ANYBODY HAS CLAIMED
 *
 * `claimed` resets to zero at a new address while the off chain record of what was earned persists,
 * so a replacement lets every creator claim their whole history a second time. If it must ever
 * change, the old one has to be paused first and the new one seeded with the old `claimed` figures.
 */

/// The two shapes an ERC20 transfer comes in. Some long lived tokens return nothing at all.
interface IERC20Loose {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract CharityFeeClaims {
    /* ------------------------------------------------------------- roles -- */

    /// Can change the signer, pause, and take stray money. ⛔ Cannot touch what is owed.
    address public owner;

    /**
     * The key the server signs vouchers with.
     *
     * ⚠ Deliberately separate from `owner`. This one lives on a server and is therefore the one
     * that will be stolen; the worst it can do is authorise payouts of money already credited,
     * and revoking it is one transaction from a key that never leaves cold storage.
     */
    address public signer;

    bool public paused;

    /* ------------------------------------------------------------ ledger -- */

    /// launch → beneficiary → asset → total ever credited to that pair.
    mapping(address => mapping(bytes32 => mapping(address => uint256))) public credited;

    /// launch → beneficiary → asset → total ever paid out to that pair.
    mapping(address => mapping(bytes32 => mapping(address => uint256))) public claimed;

    /// launch → asset → total ever credited, across every beneficiary. For public checking.
    mapping(address => mapping(address => uint256)) public creditedForLaunch;

    /// launch → asset → total ever paid out, across every beneficiary. For public checking.
    mapping(address => mapping(address => uint256)) public claimedForLaunch;

    /**
     * asset → everything credited and not yet claimed, across every launch.
     *
     * ⭐ The line the owner cannot reach below. Kept as a running total rather than computed,
     * because summing a mapping is not possible and a figure the contract cannot check is a figure
     * the owner could argue with.
     */
    mapping(address => uint256) public outstanding;

    mapping(bytes32 => bool) public redeemed;

    /* ------------------------------------------------------------ EIP712 -- */

    /*
      ⛔⛔ CHANGING EITHER STRING BREAKS EVERY VOUCHER, SILENTLY.
      The domain separator is built from these and baked into an immutable at deployment. Renaming
      the contract on another project here changed this hash, the deployed contract kept expecting
      the old one, and every voucher signed would have been rejected with nothing looking wrong.
    */
    string public constant NAME = "CharityFeeClaims";
    string public constant VERSION = "1";

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// ⚠ Field order and names are part of the hash. They must match the server's typed data exactly.
    bytes32 private constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(address launch,bytes32 beneficiary,address asset,address recipient,uint256 amount,bytes32 salt,uint256 deadline)"
    );

    bytes32 private immutable _domainSeparator;

    /* ------------------------------------------------------------ events -- */

    event Funded(address indexed launch, bytes32 indexed beneficiary, address indexed asset, uint256 amount);
    event Claimed(
        address indexed launch,
        bytes32 indexed beneficiary,
        address indexed recipient,
        address asset,
        uint256 amount,
        bytes32 salt
    );
    event SignerChanged(address indexed previous, address indexed next);
    event OwnerChanged(address indexed previous, address indexed next);
    event PausedSet(bool paused);
    event StraySwept(address indexed asset, address indexed to, uint256 amount);

    /* ------------------------------------------------------------ errors -- */

    error NotOwner();
    error IsPaused();
    error VoucherExpired();
    error VoucherAlreadyRedeemed();
    error BadSignature();
    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();
    error ValueMismatch(uint256 sent, uint256 expected);
    /// ⭐ The ring fence. This recipient's share of this launch is smaller than the voucher.
    error ExceedsShare(uint256 wanted, uint256 available);
    error ZeroBeneficiary();
    /// ⭐ The owner reaching below the line of what is owed to creators.
    error WouldTakeCreatorFunds(uint256 wanted, uint256 stray);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address signer_) {
        if (owner_ == address(0) || signer_ == address(0)) revert ZeroAddress();
        owner = owner_;
        signer = signer_;
        _domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), block.chainid, address(this))
        );
    }

    /* -------------------------------------------------------------- fund -- */

    /**
     * Puts money in against a named launch.
     *
     * ⭐ Permissionless. Anyone may credit a launch, because doing so is only ever generous, and
     * because the thing that routes a launch's fees here should not need anybody's permission.
     *
     * ⚠⚠ There is no `receive`. Money that arrives without naming a launch cannot be attributed to
     * one, and a contract that accepts unattributable money grows a pot nobody can prove ownership
     * of. Ether must come in through here, with the launch it belongs to.
     */
    function fund(address launch, bytes32 beneficiary, address asset, uint256 amount) external payable {
        if (launch == address(0)) revert ZeroAddress();
        if (beneficiary == bytes32(0)) revert ZeroBeneficiary();
        if (amount == 0) revert ZeroAmount();

        if (asset == address(0)) {
            if (msg.value != amount) revert ValueMismatch(msg.value, amount);
        } else {
            if (msg.value != 0) revert ValueMismatch(msg.value, 0);
            // ⚠ Measured, not assumed: a fee-on-transfer asset delivers less than it was asked for,
            // and crediting the requested figure would promise money that never arrived.
            uint256 before = IERC20Loose(asset).balanceOf(address(this));
            _pullFrom(asset, msg.sender, amount);
            amount = IERC20Loose(asset).balanceOf(address(this)) - before;
            if (amount == 0) revert ZeroAmount();
        }

        credited[launch][beneficiary][asset] += amount;
        creditedForLaunch[launch][asset] += amount;
        outstanding[asset] += amount;
        emit Funded(launch, beneficiary, asset, amount);
    }

    /* ------------------------------------------------------------- claim -- */

    /// What one beneficiary can still take from one launch, in one asset.
    function claimable(address launch, bytes32 beneficiary, address asset) public view returns (uint256) {
        return credited[launch][beneficiary][asset] - claimed[launch][beneficiary][asset];
    }

    /// ⚠ Everything a launch has ever been credited, across all of its recipients. A public total,
    /// not a balance anybody can draw on: no voucher is ever checked against this.
    function launchTotals(address launch, address asset)
        external
        view
        returns (uint256 creditedTotal, uint256 claimedTotal)
    {
        return (creditedForLaunch[launch][asset], claimedForLaunch[launch][asset]);
    }

    /// Everything in this contract that is not owed to a creator.
    function stray(address asset) public view returns (uint256) {
        uint256 balance = asset == address(0) ? address(this).balance : IERC20Loose(asset).balanceOf(address(this));
        uint256 owed = outstanding[asset];
        return balance > owed ? balance - owed : 0;
    }

    function voucherId(
        address launch,
        bytes32 beneficiary,
        address asset,
        address recipient,
        uint256 amount,
        bytes32 salt,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(VOUCHER_TYPEHASH, launch, beneficiary, asset, recipient, amount, salt, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator;
    }

    /**
     * Redeems a voucher.
     *
     * ⭐ The ring fence is checked here and not anywhere else: whatever the server believed, this
     * voucher cannot take more than its own launch has been credited. That is what stops one
     * creator being paid out of another's fees.
     */
    function claim(
        address launch,
        bytes32 beneficiary,
        address asset,
        address recipient,
        uint256 amount,
        bytes32 salt,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (paused) revert IsPaused();
        if (block.timestamp > deadline) revert VoucherExpired();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        /*
          ⭐⭐ The ring fence, and it is per BENEFICIARY rather than per launch. Whatever the server
          believed, this voucher cannot take more than this recipient's own share of this launch.
          A co-recipient's money is as unreachable as a stranger's.
        */
        uint256 available = claimable(launch, beneficiary, asset);
        if (amount > available) revert ExceedsShare(amount, available);

        bytes32 id = voucherId(launch, beneficiary, asset, recipient, amount, salt, deadline);
        if (redeemed[id]) revert VoucherAlreadyRedeemed();
        if (_recover(id, signature) != signer) revert BadSignature();

        redeemed[id] = true;
        claimed[launch][beneficiary][asset] += amount;
        claimedForLaunch[launch][asset] += amount;
        outstanding[asset] -= amount;

        emit Claimed(launch, beneficiary, recipient, asset, amount, salt);
        _send(asset, recipient, amount);
    }

    /* ------------------------------------------------------------- admin -- */

    function setSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit SignerChanged(signer, next);
        signer = next;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /**
     * ⛔⛔ Takes ONLY what nobody is owed.
     *
     * The obvious version of this function lets the owner withdraw anything, which makes every
     * creator's balance a promise rather than a fact. Here the owner is refused below the
     * `outstanding` line, so the money a creator has been credited is beyond PONSI exactly as it is
     * beyond everybody else. What is left over is genuinely stray: somebody's mistaken transfer, or
     * dust from a fee-on-transfer asset.
     */
    function sweepStray(address asset, address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = stray(asset);
        if (amount > free) revert WouldTakeCreatorFunds(amount, free);
        emit StraySwept(asset, to, amount);
        _send(asset, to, amount);
    }

    /* ---------------------------------------------------------- internal -- */

    function _send(address asset, address to, uint256 amount) private {
        if (asset == address(0)) {
            (bool sent,) = payable(to).call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            _call(asset, abi.encodeCall(IERC20Loose.transfer, (to, amount)));
        }
    }

    function _pullFrom(address asset, address from, uint256 amount) private {
        _call(asset, abi.encodeCall(IERC20Loose.transferFrom, (from, address(this), amount)));
    }

    /// ⚠ Accepts a token that returns nothing as well as one that returns a bool.
    function _call(address asset, bytes memory data) private {
        (bool ok, bytes memory ret) = asset.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // ⚠ Low-s only. Both halves of the curve produce a valid signature for the same key, so
        // accepting the high half would give every voucher a second, different id.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert BadSignature();
        return recovered;
    }
}
