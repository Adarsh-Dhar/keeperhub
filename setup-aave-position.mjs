#!/usr/bin/env node
/**
 * setup-aave-position.mjs
 *
 * Opens a real Aave V3 test position on Base Sepolia, end to end:
 *   1. Mint test USDC from Aave's testnet Faucet
 *   2. Approve the Aave Pool to pull that USDC
 *   3. Supply USDC as collateral
 *   4. Borrow DAI against it
 *   5. Read back getUserAccountData and print the resulting health factor
 *
 * Requires: Node 18+, `npm install viem`
 *
 * Env vars (put these in a .env and `node --env-file=.env setup-aave-position.mjs`,
 * or export them in your shell first):
 *   PRIVATE_KEY          - test wallet private key, 0x-prefixed (NEVER use a real-funds wallet)
 *   RPC_URL              - optional, defaults to a public Base Sepolia RPC
 *   MINT_USDC_AMOUNT     - optional, human units, defaults to "100"
 *   SUPPLY_USDC_AMOUNT   - optional, human units, defaults to "15"
 *   BORROW_DAI_AMOUNT    - optional, human units, defaults to "5"
 *
 * Every write step waits for its transaction receipt before moving on, and the
 * whole thing stops immediately (with the tx hash printed) if any step reverts.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  getContract,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Missing PRIVATE_KEY env var. Set it to your TEST wallet's private key.");
  process.exit(1);
}

// Aave V3 Base Sepolia core contracts (aave-address-book, AaveV3BaseSepolia library)
const POOL = "0x0E5Da3a3DAd88C62EA79750bF4996e35Ae0A5De6";
const FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D";

// Reserve assets on the Base Sepolia market
const USDC = { address: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f", decimals: 6, symbol: "USDC" };
const DAI = { address: "0x61619E9316D414091Aa4f3D94b913C5c5e0b8aa2", decimals: 18, symbol: "DAI" };

const MINT_USDC_AMOUNT = process.env.MINT_USDC_AMOUNT || "100";
const SUPPLY_USDC_AMOUNT = process.env.SUPPLY_USDC_AMOUNT || "15";
const BORROW_DAI_AMOUNT = process.env.BORROW_DAI_AMOUNT || "5";

// ---------------------------------------------------------------------------
// Minimal ABIs — only the functions this script calls
// ---------------------------------------------------------------------------

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

// Faucet interface per Aave's IFaucet (mint(token, amount) -> amount minted).
// If this reverts on your run, the fallback is minting via the "Faucet" tab
// on app.aave.com (testnet mode) for this one step only — everything else in
// this script still works normally afterward.
const faucetAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
];

const poolAbi = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
];

const VARIABLE_RATE_MODE = 2n; // Aave V3 stable-rate borrowing is deprecated market-wide

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });

const usdcContract = getContract({ address: USDC.address, abi: erc20Abi, client: walletClient });
const daiContract = getContract({ address: DAI.address, abi: erc20Abi, client: { public: publicClient, wallet: walletClient } });
const faucetContract = getContract({ address: FAUCET, abi: faucetAbi, client: walletClient });
const poolContract = getContract({ address: POOL, abi: poolAbi, client: { public: publicClient, wallet: walletClient } });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendAndWait(label, txPromise) {
  console.log(`\n-> ${label}`);
  const hash = await txPromise;
  console.log(`   tx sent: ${hash}`);
  console.log(`   waiting for confirmation...`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`   REVERTED. See https://sepolia.basescan.org/tx/${hash}`);
    process.exit(1);
  }
  console.log(`   confirmed in block ${receipt.blockNumber}`);
  console.log(`   https://sepolia.basescan.org/tx/${hash}`);
  return receipt;
}

function fmtHealthFactor(raw) {
  // healthFactor is scaled by 1e18. Aave returns type(uint256).max when there's no debt.
  const MAX_UINT256 = 2n ** 256n - 1n;
  if (raw === MAX_UINT256) return "∞ (no debt yet)";
  return formatUnits(raw, 18);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Wallet: ${account.address}`);
  console.log(`RPC:    ${RPC_URL}`);

  const ethBalance = await publicClient.getBalance({ address: account.address });
  console.log(`ETH balance: ${formatUnits(ethBalance, 18)} ETH`);
  if (ethBalance === 0n) {
    console.error("\nNo Base Sepolia ETH for gas. Fund this wallet first (see faucet links in the setup guide).");
    process.exit(1);
  }

  // 1. Mint test USDC
  const mintAmount = parseUnits(MINT_USDC_AMOUNT, USDC.decimals);
  await sendAndWait(
    `Minting ${MINT_USDC_AMOUNT} USDC from the faucet`,
    faucetContract.write.mint([USDC.address, mintAmount])
  );

  const usdcBalance = await publicClient.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`\nUSDC balance now: ${formatUnits(usdcBalance, USDC.decimals)} USDC`);

  // 2. Approve the Pool
  const supplyAmount = parseUnits(SUPPLY_USDC_AMOUNT, USDC.decimals);
  await sendAndWait(
    `Approving Pool to spend ${SUPPLY_USDC_AMOUNT} USDC`,
    usdcContract.write.approve([POOL, supplyAmount])
  );

  // 3. Supply USDC as collateral
  await sendAndWait(
    `Supplying ${SUPPLY_USDC_AMOUNT} USDC as collateral`,
    poolContract.write.supply([USDC.address, supplyAmount, account.address, 0])
  );

  // 4. Borrow DAI against it
  const borrowAmount = parseUnits(BORROW_DAI_AMOUNT, DAI.decimals);
  await sendAndWait(
    `Borrowing ${BORROW_DAI_AMOUNT} DAI (variable rate)`,
    poolContract.write.borrow([DAI.address, borrowAmount, VARIABLE_RATE_MODE, 0, account.address])
  );

  // 5. Read back the resulting position
  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  ] = await poolContract.read.getUserAccountData([account.address]);

  console.log("\n=== Position summary ===");
  console.log(`Total collateral (base units, 8 decimals): ${formatUnits(totalCollateralBase, 8)}`);
  console.log(`Total debt (base units, 8 decimals):       ${formatUnits(totalDebtBase, 8)}`);
  console.log(`Available to borrow (base units):          ${formatUnits(availableBorrowsBase, 8)}`);
  console.log(`Liquidation threshold:                     ${Number(currentLiquidationThreshold) / 100}%`);
  console.log(`LTV:                                       ${Number(ltv) / 100}%`);
  console.log(`Health factor:                              ${fmtHealthFactor(healthFactor)}`);
  console.log(
    `\nCompare this health factor against what the guardian agent reports in Section 12 of the setup guide.`
  );
}

main().catch((err) => {
  console.error("\nScript failed:", err.shortMessage || err.message || err);
  process.exit(1);
});
