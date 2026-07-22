// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ArclifyLendingPool
 * ---------------------------------------------------------------------
 * A single-market lending pool on Arc Testnet: deposit USDC as
 * collateral, borrow EURC against it.
 *
 * Design choices, and why:
 *
 * - Both legs use the ERC-20 interface, not native currency. Arc exposes
 *   USDC both as the native gas token AND as a standard ERC-20 at
 *   0x3600000000000000000000000000000000000000 (same underlying
 *   balance, confirmed via Circle's own Arc docs). Using the ERC-20
 *   interface for collateral means this whole contract only ever does
 *   approve()/transferFrom()/transfer() — no `payable`, no msg.value, no
 *   low-level native calls anywhere. That's a deliberate simplification:
 *   native-currency payout paths are where a large share of real-world
 *   reentrancy exploits live, so avoiding that pattern entirely removes
 *   a whole category of risk rather than just guarding against it.
 *
 * - Fixed, owner-settable exchange rate, not a live price oracle. Arc
 *   Testnet doesn't have a reliable USDC/EURC price feed yet. A fixed
 *   rate is honest about that limitation rather than pretending to have
 *   real-time pricing — swapping in an oracle later is a contained
 *   change (just the internal _usdcValueInEurc/_eurcValueInUsdc math),
 *   not a redesign.
 *
 * - Full liquidation only, no partial liquidation. A liquidator repays
 *   a borrower's entire outstanding debt and receives 100% of that
 *   borrower's collateral. Because liquidation only triggers once debt
 *   exceeds the liquidation threshold (e.g. 85% of collateral value),
 *   the collateral being seized is worth more than the debt being
 *   repaid — that gap IS the liquidator's incentive, with no separate
 *   bonus calculation needed. Simpler and harder to get wrong than
 *   partial-liquidation math.
 *
 * - Pool liquidity (the EURC available to borrow) is supplied via
 *   fundPool() with NO per-supplier share tracking or yield
 *   distribution in this version — anyone can add liquidity, but
 *   there's no withdrawal-by-supplier mechanism yet. This mirrors how
 *   Swap's signer wallet is documented in this same project: a known,
 *   explicit simplification for a testnet-stage feature, not an
 *   oversight. Real supplier accounting (shares, proportional interest)
 *   is a solid, contained next step once this base version is proven.
 *
 * - No external imports (no OpenZeppelin). Everything this needs
 *   (IERC20 interface, safe-transfer wrapper, reentrancy guard, owner
 *   check) is small enough to inline directly, which avoids any risk of
 *   Remix failing to resolve an external import mid-deploy.
 * ---------------------------------------------------------------------
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ArclifyLendingPool {
    // ------------------------------------------------------------------
    // Constants & config
    // ------------------------------------------------------------------

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant RATE_PRECISION = 1e6; // matches USDC/EURC's 6 decimals
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    IERC20 public immutable collateralToken; // USDC (ERC-20 interface), 6 decimals
    IERC20 public immutable borrowToken;     // EURC, 6 decimals

    address public owner;
    bool public paused;

    // How many EURC (6dp) one USDC (6dp) is worth, scaled by RATE_PRECISION.
    // e.g. 920000 means 1 USDC = 0.92 EURC. OWNER MUST SET THIS to a
    // reasonable current rate right after deployment — the constructor
    // default below is a placeholder, not a live quote.
    uint256 public exchangeRate = 920_000;

    uint256 public collateralFactorBps = 7_500;      // max borrow = 75% of collateral value
    uint256 public liquidationThresholdBps = 8_500;  // liquidatable once debt > 85% of collateral value
    uint256 public interestRateBps = 500;            // 5% simple APR, fixed (not utilization-based)

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    struct Position {
        uint256 collateralAmount;   // USDC, 6dp
        uint256 principal;          // EURC borrowed, 6dp, excluding accrued interest
        uint256 lastAccrualTime;    // unix timestamp interest was last folded into `principal`
    }

    mapping(address => Position) public positions;

    uint256 public totalCollateral; // USDC held as collateral across all users
    uint256 public totalPrincipalOwed; // sum of all positions' principal (informational)

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event LiquidityFunded(address indexed funder, uint256 amount);
    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed borrower, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);
    event ExchangeRateUpdated(uint256 newRate);
    event InterestRateUpdated(uint256 newRateBps);
    event CollateralFactorUpdated(uint256 newFactorBps);
    event LiquidationThresholdUpdated(uint256 newThresholdBps);
    event Paused(bool isPaused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    // Minimal reentrancy guard — avoids pulling in an external import
    // just for this one thing.
    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "Reentrancy");
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @param _collateralToken Arc's USDC ERC-20 interface address
     *        (0x3600000000000000000000000000000000000000 on Arc Testnet).
     * @param _borrowToken Arc's EURC address
     *        (0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a on Arc Testnet).
     */
    constructor(address _collateralToken, address _borrowToken) {
        require(_collateralToken != address(0) && _borrowToken != address(0), "Zero address");
        collateralToken = IERC20(_collateralToken);
        borrowToken = IERC20(_borrowToken);
        owner = msg.sender;
    }

    // ------------------------------------------------------------------
    // Safe ERC-20 helpers
    // ------------------------------------------------------------------

    // Tolerates tokens that don't return a bool (some real-world ERC-20s
    // don't, even though USDC/EURC here should). Reverts on any failure.
    function _safeTransfer(IERC20 token, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transferFrom.selector, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferFrom failed");
    }

    // ------------------------------------------------------------------
    // Internal accounting
    // ------------------------------------------------------------------

    // Simple (non-compounding) interest: debt grows linearly with time.
    // Folds any interest owed since the last accrual into `principal`,
    // then resets the clock. Called at the start of every state-changing
    // borrower action so `principal` is always current before it's used.
    function _accrueInterest(address user) private {
        Position storage pos = positions[user];
        if (pos.principal == 0) {
            pos.lastAccrualTime = block.timestamp;
            return;
        }
        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        if (elapsed == 0) return;

        uint256 interest = (pos.principal * interestRateBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
        if (interest > 0) {
            totalPrincipalOwed += interest;
            pos.principal += interest;
        }
        pos.lastAccrualTime = block.timestamp;
    }

    function usdcValueInEurc(uint256 usdcAmount) public view returns (uint256) {
        return (usdcAmount * exchangeRate) / RATE_PRECISION;
    }

    function eurcValueInUsdc(uint256 eurcAmount) public view returns (uint256) {
        return (eurcAmount * RATE_PRECISION) / exchangeRate;
    }

    // Shared by getCurrentDebt() and isLiquidatable() — both need "debt
    // including interest accrued since the last on-chain update," and
    // this computes it WITHOUT touching storage, so either can be called
    // as a free read (eth_call) rather than requiring an actual
    // transaction. _accrueInterest (above) is the storage-writing
    // counterpart, used inside the state-changing functions below.
    function _previewDebt(address user) private view returns (uint256) {
        Position storage pos = positions[user];
        if (pos.principal == 0) return 0;
        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        uint256 interest = (pos.principal * interestRateBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
        return pos.principal + interest;
    }

    // ------------------------------------------------------------------
    // Liquidity supply (see header note: no per-supplier accounting yet)
    // ------------------------------------------------------------------

    function fundPool(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        _safeTransferFrom(borrowToken, msg.sender, address(this), amount);
        emit LiquidityFunded(msg.sender, amount);
    }

    function availableLiquidity() public view returns (uint256) {
        return borrowToken.balanceOf(address(this));
    }

    // ------------------------------------------------------------------
    // Collateral
    // ------------------------------------------------------------------

    function depositCollateral(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Zero amount");
        _accrueInterest(msg.sender);
        positions[msg.sender].collateralAmount += amount;
        totalCollateral += amount;
        _safeTransferFrom(collateralToken, msg.sender, address(this), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        _accrueInterest(msg.sender);
        Position storage pos = positions[msg.sender];
        require(pos.collateralAmount >= amount, "Insufficient collateral");

        uint256 remainingCollateral = pos.collateralAmount - amount;
        uint256 remainingCollateralValue = usdcValueInEurc(remainingCollateral);
        uint256 maxBorrowableAfter = (remainingCollateralValue * collateralFactorBps) / BPS_DENOMINATOR;
        require(pos.principal <= maxBorrowableAfter, "Would exceed max LTV");

        pos.collateralAmount = remainingCollateral;
        totalCollateral -= amount;
        _safeTransfer(collateralToken, msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Borrow / repay
    // ------------------------------------------------------------------

    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Zero amount");
        require(amount <= availableLiquidity(), "Insufficient pool liquidity");
        _accrueInterest(msg.sender);

        Position storage pos = positions[msg.sender];
        uint256 collateralValue = usdcValueInEurc(pos.collateralAmount);
        uint256 maxBorrowable = (collateralValue * collateralFactorBps) / BPS_DENOMINATOR;
        require(pos.principal + amount <= maxBorrowable, "Exceeds max LTV");

        pos.principal += amount;
        totalPrincipalOwed += amount;
        _safeTransfer(borrowToken, msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        _accrueInterest(msg.sender);

        Position storage pos = positions[msg.sender];
        require(amount <= pos.principal, "Amount exceeds debt");

        pos.principal -= amount;
        totalPrincipalOwed -= amount;
        _safeTransferFrom(borrowToken, msg.sender, address(this), amount);
        emit Repaid(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Liquidation
    // ------------------------------------------------------------------

    // Pure read — safe to call from a frontend as a free eth_call, no
    // transaction or gas required, unlike a function that writes state.
    function isLiquidatable(address borrower) public view returns (bool) {
        uint256 debt = _previewDebt(borrower);
        if (debt == 0) return false;
        uint256 collateralValue = usdcValueInEurc(positions[borrower].collateralAmount);
        uint256 liquidationCap = (collateralValue * liquidationThresholdBps) / BPS_DENOMINATOR;
        return debt > liquidationCap;
    }

    // Liquidator repays the borrower's ENTIRE debt and receives ALL of
    // that borrower's collateral in exchange. See header note for why
    // this is full-liquidation-only rather than partial.
    function liquidate(address borrower) external nonReentrant {
        require(isLiquidatable(borrower), "Not liquidatable");
        _accrueInterest(borrower); // sync pos.principal to the up-to-date value before seizing it

        Position storage pos = positions[borrower];
        uint256 debt = pos.principal;
        uint256 collateralSeized = pos.collateralAmount;

        pos.principal = 0;
        pos.collateralAmount = 0;
        totalPrincipalOwed -= debt;
        totalCollateral -= collateralSeized;

        _safeTransferFrom(borrowToken, msg.sender, address(this), debt);
        _safeTransfer(collateralToken, msg.sender, collateralSeized);
        emit Liquidated(borrower, msg.sender, debt, collateralSeized);
    }

    // ------------------------------------------------------------------
    // Views (for the frontend)
    // ------------------------------------------------------------------

    function getCurrentDebt(address user) external view returns (uint256) {
        return _previewDebt(user);
    }

    function getMaxBorrowable(address user) external view returns (uint256) {
        uint256 collateralValue = usdcValueInEurc(positions[user].collateralAmount);
        return (collateralValue * collateralFactorBps) / BPS_DENOMINATOR;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setExchangeRate(uint256 newRate) external onlyOwner {
        require(newRate > 0, "Zero rate");
        exchangeRate = newRate;
        emit ExchangeRateUpdated(newRate);
    }

    function setInterestRateBps(uint256 newRateBps) external onlyOwner {
        require(newRateBps <= 5_000, "Rate too high"); // sanity cap at 50% APR
        interestRateBps = newRateBps;
        emit InterestRateUpdated(newRateBps);
    }

    function setCollateralFactorBps(uint256 newFactorBps) external onlyOwner {
        require(newFactorBps > 0 && newFactorBps < liquidationThresholdBps, "Must be < liquidation threshold");
        collateralFactorBps = newFactorBps;
        emit CollateralFactorUpdated(newFactorBps);
    }

    function setLiquidationThresholdBps(uint256 newThresholdBps) external onlyOwner {
        require(newThresholdBps > collateralFactorBps && newThresholdBps < BPS_DENOMINATOR, "Invalid threshold");
        liquidationThresholdBps = newThresholdBps;
        emit LiquidationThresholdUpdated(newThresholdBps);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
