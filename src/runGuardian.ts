import { config } from "./config.js";
import { createKeeperHubClient, KeeperHubMCP } from "./mcp/keeperhubClient.js";
import { notifyLocal } from "./notify/logger.js";
import { calculateRepayAmount, calculateSupplyAmount } from "./workflows/workflowDefinition.js";
import { decideRepayVsSupply, DecisionContext } from "./agent/decisionAgent.js";
import { createWalletClient, createPublicClient, http, checksumAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getDebtAssetBalance, getCollateralAssetBalance } from "./onchain/balances.js";

const CRITICAL_HEALTH_FACTOR = 1.1; // below this + can't act -> escalate as critical
const COOLDOWN_SECONDS = 300; // 5 minutes cooldown between executions
const MAX_EXECUTIONS_PER_SESSION = 3; // Maximum number of executions per session to prevent runaway

// Simple cooldown mechanism
function getLastExecutionTime(): number {
  const cooldownFile = join(process.cwd(), ".last-execution");
  if (existsSync(cooldownFile)) {
    return parseInt(readFileSync(cooldownFile, "utf-8"));
  }
  return 0;
}

function setLastExecutionTime(): void {
  const cooldownFile = join(process.cwd(), ".last-execution");
  writeFileSync(cooldownFile, Date.now().toString());
}

function isInCooldown(): boolean {
  const lastExecution = getLastExecutionTime();
  const cooldownMs = COOLDOWN_SECONDS * 1000;
  return Date.now() - lastExecution < cooldownMs;
}

// Session execution counter
let sessionExecutionCount = 0;
let previousHealthFactor = 0;
function incrementExecutionCount(): number {
  return ++sessionExecutionCount;
}
function shouldStopExecution(): boolean {
  return sessionExecutionCount >= MAX_EXECUTIONS_PER_SESSION;
}
function setPreviousHealthFactor(hf: number): void {
  previousHealthFactor = hf;
}
function hasHealthFactorImproved(current: number): boolean {
  return current > previousHealthFactor;
}
function resetSessionCount(): void {
  sessionExecutionCount = 0;
}

const ERC20_ABI = [
  {
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const AAVE_POOL_ABI = [
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    name: "repay",
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    name: "supply",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const AAVE_POOL_ADDRESS = checksumAddress(config.contracts.aavePool as `0x${string}`);

async function approveTokenIfNeeded(tokenAddress: string, amount: bigint): Promise<boolean> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("PRIVATE_KEY not set in environment, cannot auto-approve");
    return false;
  }

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(config.rpc.url),
    });

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(config.rpc.url),
    });

    // Use checksummed addresses
    const actualTokenAddress = checksumAddress(tokenAddress as `0x${string}`);
    const checksummedPool = checksumAddress(AAVE_POOL_ADDRESS);

    // Check current allowance - retry once before giving up
    let currentAllowance = BigInt(0);
    let allowanceReadOk = false;
    for (let attempt = 0; attempt < 2 && !allowanceReadOk; attempt++) {
      try {
        currentAllowance = await publicClient.readContract({
          address: actualTokenAddress,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [account.address, checksummedPool],
        }) as bigint;
        allowanceReadOk = true;
      } catch (error) {
        if (attempt === 0) {
          console.log("⚠️ Allowance read failed, retrying once...");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    if (!allowanceReadOk) {
      console.error("✗ Cannot verify token allowance after retry — refusing to proceed without confirming approval.");
      return false;
    }

    if (currentAllowance >= amount) {
      console.log(`✓ Sufficient allowance already exists: ${currentAllowance.toString()}`);
      return true;
    }

    console.log(`Approving Aave pool to spend ${amount.toString()} of ${actualTokenAddress}...`);
    const approveHash = await walletClient.writeContract({
      address: actualTokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [checksummedPool, amount],
    });

    console.log(`✓ Approval transaction sent: ${approveHash}`);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log("✓ Approval confirmed");

    return true;
  } catch (error) {
    console.error("✗ Auto-approval failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function executeDirectRepay(
  asset: string,
  amount: string,
  onBehalfOf: string
): Promise<WriteActionResult> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    return { success: false, error: "PRIVATE_KEY not set in environment" };
  }

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(config.rpc.url),
    });

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(config.rpc.url),
    });

    // Use checksummed addresses
    const actualAsset = checksumAddress(asset as `0x${string}`);
    const checksummedOnBehalfOf = checksumAddress(onBehalfOf as `0x${string}`);

    console.log(`Executing direct repay of ${amount} ${actualAsset} to Aave pool...`);

    // First approve the pool to spend the debt asset
    const approvalSuccess = await approveTokenIfNeeded(actualAsset, BigInt(amount));
    if (!approvalSuccess) {
      return { success: false, error: "Failed to approve token spending" };
    }

    const repayHash = await walletClient.writeContract({
      address: AAVE_POOL_ADDRESS,
      abi: AAVE_POOL_ABI,
      functionName: "repay",
      args: [actualAsset, BigInt(amount), 2n, checksummedOnBehalfOf],
    });

    console.log(`✓ Repay transaction sent: ${repayHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: repayHash });
    console.log("✓ Repay confirmed");

    const transactionLink = `https://sepolia.basescan.org/tx/${repayHash}`;
    return { success: true, transactionLink };
  } catch (error) {
    console.error("✗ Direct repay failed:", error instanceof Error ? error.message : String(error));
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeDirectSupply(
  asset: string,
  amount: string,
  onBehalfOf: string
): Promise<WriteActionResult> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    return { success: false, error: "PRIVATE_KEY not set in environment" };
  }

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(config.rpc.url),
    });

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(config.rpc.url),
    });

    // Use checksummed addresses
    const actualAsset = checksumAddress(asset as `0x${string}`);
    const checksummedOnBehalfOf = checksumAddress(onBehalfOf as `0x${string}`);

    console.log(`Executing direct supply of ${amount} ${actualAsset} to Aave pool...`);

    // First approve the pool to spend the collateral asset
    const approvalSuccess = await approveTokenIfNeeded(actualAsset, BigInt(amount));
    if (!approvalSuccess) {
      return { success: false, error: "Failed to approve token spending" };
    }

    const supplyHash = await walletClient.writeContract({
      address: AAVE_POOL_ADDRESS,
      abi: AAVE_POOL_ABI,
      functionName: "supply",
      args: [actualAsset, BigInt(amount), checksummedOnBehalfOf, 0],
    });

    console.log(`✓ Supply transaction sent: ${supplyHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: supplyHash });
    console.log("✓ Supply confirmed");

    const transactionLink = `https://sepolia.basescan.org/tx/${supplyHash}`;
    return { success: true, transactionLink };
  } catch (error) {
    console.error("✗ Direct supply failed:", error instanceof Error ? error.message : String(error));
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Fallback execution using direct contract calls with private key.
 * This bypasses KeeperHub's wallet limitation and uses the user's own wallet
 * where the Aave position actually exists.
 */
async function executeProtocolWriteDirect(
  actionType: string,
  asset: string,
  amount: string,
  onBehalfOf: string
): Promise<WriteActionResult> {
  console.log(`Using direct execution for ${actionType} (bypassing KeeperHub wallet limitation)`);

  if (actionType === "aave-v3/repay") {
    return await executeDirectRepay(asset, amount, onBehalfOf);
  } else if (actionType === "aave-v3/supply") {
    return await executeDirectSupply(asset, amount, onBehalfOf);
  }

  return { success: false, error: `Direct execution not implemented for ${actionType}` };
}

interface WriteActionResult {
  success: boolean;
  transactionLink?: string;
  error?: string;
}

/**
 * Runs the simulate -> execute -> poll sequence for any Aave V3 write
 * action through KeeperHub's MCP tools. Shared by both the repay and
 * supply paths so that safety behavior (simulate first, poll for real
 * completion) is identical for either action.
 */
async function executeProtocolWrite(
  mcp: KeeperHubMCP,
  actionType: string,
  params: Record<string, unknown>
): Promise<WriteActionResult> {
  console.log(`Simulating ${actionType} via KeeperHub...`);
  const simResultRaw = await mcp.callTool("execute_protocol_action", {
    actionType,
    params,
    simulate: true,
  });
  const simResult = JSON.parse(simResultRaw);
  console.log("Simulation result:", JSON.stringify(simResult, null, 2));

  // If simulation fails, return the actual error message instead of guessing
  if (simResult.success === false || simResult.wouldRevert) {
    return { success: false, error: `Simulation failed: ${simResultRaw}` };
  }

  // Simulation succeeded — proceed to real (non-simulate) KeeperHub execution
  console.log(`Simulation passed. Executing real ${actionType} via KeeperHub...`);
  const execResultRaw = await mcp.callTool("execute_protocol_action", {
    actionType,
    params,
    idempotency_key: `guardian-${actionType.split("/")[1]}-${Date.now()}`,
  });
  const execResult = JSON.parse(execResultRaw);
  console.log("Execution submitted:", JSON.stringify(execResult, null, 2));

  if (!execResult.executionId) {
    return { success: false, error: `Execution did not return an executionId: ${execResultRaw}` };
  }

  console.log("Polling for execution status...");
  let statusResult: any;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const statusRaw = await mcp.callTool("get_direct_execution_status", {
      executionId: execResult.executionId,
    });
    statusResult = JSON.parse(statusRaw);
    console.log(`Status check ${attempt + 1}:`, statusResult.status);
    if (statusResult.status === "completed" || statusResult.status === "failed") break;
  }

  if (!statusResult || statusResult.status !== "completed") {
    return { success: false, error: `Execution did not complete in time. Last status: ${JSON.stringify(statusResult)}` };
  }

  const transactionLink =
    statusResult.transactionLink ||
    (statusResult.transactionHash ? `https://sepolia.basescan.org/tx/${statusResult.transactionHash}` : undefined);

  return { success: true, transactionLink };
}

async function runOnce(): Promise<void> {
  const mcp = createKeeperHubClient();

  try {
    await mcp.connect();
    // Log available tools for debugging
    const availableTools = await mcp.listGeminiTools();
    console.log("Available KeeperHub tools:", availableTools.map(t => t.name).join(", "));
  } catch (error) {
    console.error("Failed to connect to KeeperHub MCP:", error);
    if (error instanceof Error && error.message.includes("ENOTFOUND")) {
      console.error("DNS resolution failed. This is a temporary network issue. Will retry in next cycle.");
    }
    return;
  }

  console.log(`\n[${new Date().toISOString()}] Guardian run starting...`);
  console.log(`Checking wallet: ${config.position.walletAddress}`);
  console.log(`Chain ID: ${config.position.chainId}`);
  console.log(`Health factor threshold: ${config.position.healthFactorThreshold}`);

  try {
    // --- Step 1: read the position (deterministic) ---
    console.log("\nFetching current health factor...");
    const checksummedWallet = checksumAddress(config.position.walletAddress as `0x${string}`);
    const healthDataResult = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/get-user-account-data",
      params: {
        network: config.position.chainId,
        user: checksummedWallet,
      },
    });

    const healthData = JSON.parse(healthDataResult);

    if (!healthData.result || !healthData.result.healthFactor) {
      throw new Error("healthFactor not found in response");
    }
    const d = healthData.result;

    // Handle the case where healthFactor is max uint256 (no debt = infinite health)
    const healthFactorRaw = d.healthFactor;
    const maxUint256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    let actualHealthFactor: number;
    
    if (healthFactorRaw === maxUint256) {
      actualHealthFactor = Infinity; // No debt means infinite health
    } else {
      actualHealthFactor = Number(BigInt(healthFactorRaw)) / 1e18;
    }

    console.log("=== Position data ===");
    console.log(`Total collateral (base): ${d.totalCollateralBase}`);
    console.log(`Total debt (base): ${d.totalDebtBase}`);
    console.log(`Liquidation threshold: ${Number(d.currentLiquidationThreshold) / 100}%`);
    console.log(`Health factor: ${actualHealthFactor.toFixed(4)} (threshold: ${config.position.healthFactorThreshold})`);
    
    // Track health factor changes - set previous after first check
    if (sessionExecutionCount === 0) {
      setPreviousHealthFactor(actualHealthFactor);
    } else if (!hasHealthFactorImproved(actualHealthFactor)) {
      console.log(`⚠️ Health factor has not improved after ${sessionExecutionCount} executions (previous: ${previousHealthFactor.toFixed(4)}, current: ${actualHealthFactor.toFixed(4)}). Stopping execution.`);
      await notifyLocal(`⚠️ Guardian stopped: Health factor not improving after ${sessionExecutionCount} executions. Current: ${actualHealthFactor.toFixed(4)}, Previous: ${previousHealthFactor.toFixed(4)}`);
      await mcp.disconnect();
      return;
    }

    // --- Step 2: healthy? done, no further reads, no agent call ---
    if (actualHealthFactor >= config.position.healthFactorThreshold) {
      const message = `Position is healthy. Current health factor: ${actualHealthFactor.toFixed(4)} (threshold: ${config.position.healthFactorThreshold}). No action needed.`;
      console.log(message);
      await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${message}`);
      await mcp.disconnect();
      return;
    }

    // --- Step 3: at risk — gather the rest of the data table ---
    const requiredRepayAmount = calculateRepayAmount(healthData, config.position.healthFactorThreshold);
    const requiredSupplyAmount = calculateSupplyAmount(healthData, config.position.healthFactorThreshold);

    console.log("\n=== Action requirements ===");
    console.log(`Required repay amount: ${requiredRepayAmount} USDT`);
    console.log(`Required supply amount: ${requiredSupplyAmount} USDC`);

    // --- Step 4: route to a decision ---
    console.log("\nChecking wallet balances for repay vs supply...");
    const [debtAssetBalanceRaw, collateralAssetBalanceRaw] = await Promise.all([
      getDebtAssetBalance(config.position.walletAddress),
      getCollateralAssetBalance(config.position.walletAddress),
    ]);
    console.log(`Debt asset (USDT) balance: ${debtAssetBalanceRaw.toString()}`);
    console.log(`Collateral asset (USDC) balance: ${collateralAssetBalanceRaw.toString()}`);

    const TOKEN_DECIMALS = 1e6; // USDT/USDC, 6 decimals
    const canRepay = debtAssetBalanceRaw >= BigInt(requiredRepayAmount);
    const canSupply = collateralAssetBalanceRaw >= BigInt(requiredSupplyAmount);

    let action: "repay" | "supply";
    let decisionReasoning: string;

    if (!canRepay && !canSupply) {
      // Neither action is actually affordable — executing anyway would just
      // burn a simulation/revert cycle. Escalate instead of guessing.
      const message =
        `🛑 Neither repay nor supply is affordable right now. ` +
        `Debt asset balance: ${(Number(debtAssetBalanceRaw) / TOKEN_DECIMALS).toFixed(2)} USDT (need ${(Number(requiredRepayAmount) / TOKEN_DECIMALS).toFixed(2)}). ` +
        `Collateral asset balance: ${(Number(collateralAssetBalanceRaw) / TOKEN_DECIMALS).toFixed(2)} USDC (need ${(Number(requiredSupplyAmount) / TOKEN_DECIMALS).toFixed(2)}). ` +
        `Escalating — no automated action can be taken.`;
      console.error(message);
      await notifyLocal(message);
      await mcp.disconnect();
      return;
    } else if (canRepay && !canSupply) {
      action = "repay";
      decisionReasoning = "Only repay is affordable given current wallet balances.";
    } else if (!canRepay && canSupply) {
      action = "supply";
      decisionReasoning = "Only supply is affordable given current wallet balances.";
    } else {
      // Both are affordable — this is the real judgment call, so ask the
      // agent to weigh the tradeoff instead of defaulting silently.
      const decisionContext: DecisionContext = {
        healthFactor: actualHealthFactor,
        threshold: config.position.healthFactorThreshold,
        totalCollateralBase: d.totalCollateralBase,
        totalDebtBase: d.totalDebtBase,
        liquidationThresholdPct: Number(d.currentLiquidationThreshold) / 100,
        debtAssetBalance: (Number(debtAssetBalanceRaw) / TOKEN_DECIMALS).toFixed(2),
        collateralAssetBalance: (Number(collateralAssetBalanceRaw) / TOKEN_DECIMALS).toFixed(2),
        requiredRepayAmount: (Number(requiredRepayAmount) / TOKEN_DECIMALS).toFixed(2),
        requiredSupplyAmount: (Number(requiredSupplyAmount) / TOKEN_DECIMALS).toFixed(2),
      };
      const decision = await decideRepayVsSupply(decisionContext);
      action = decision.action;
      decisionReasoning = decision.reasoning;
    }
    console.log(`Decision: ${action}. ${decisionReasoning}`);

    // --- Step 5: act ---
    // Check cooldown before executing
    if (isInCooldown()) {
      const remainingSeconds = Math.ceil((COOLDOWN_SECONDS * 1000 - (Date.now() - getLastExecutionTime())) / 1000);
      const message = `⏸️ Guardian is in cooldown. Last execution was ${remainingSeconds} seconds ago. Waiting ${remainingSeconds} more seconds before next action.`;
      console.log(message);
      await notifyLocal(message);
      await mcp.disconnect();
      return;
    }

    // Check if we've hit max executions for this session
    if (shouldStopExecution()) {
      const message = `🛑 Guardian has reached maximum execution limit (${MAX_EXECUTIONS_PER_SESSION}) for this session. Stopping to prevent runaway execution. Position health factor: ${actualHealthFactor.toFixed(4)}`;
      console.log(message);
      await notifyLocal(message);
      await mcp.disconnect();
      return;
    }

    const amount = action === "repay" ? requiredRepayAmount : requiredSupplyAmount;
    const assetName = action === "repay" ? "USDT" : "USDC";

    const warningMessage =
      `⚠️ POSITION AT RISK! Health factor ${actualHealthFactor.toFixed(4)} is below threshold ${config.position.healthFactorThreshold}. ` +
      `Executing ${action} of ${amount} ${assetName}...\n` +
      `Reasoning: ${decisionReasoning}`;
    console.log(warningMessage);
    await notifyLocal(warningMessage);

    // For KeeperHub protocol actions, use the actual token addresses the wallet holds
    const asset = action === "repay" ? config.assets.walletDebtAsset : config.assets.walletCollateralAsset;

    const params: Record<string, unknown> =
      action === "repay"
        ? {
            network: config.position.chainId,
            asset,
            amount,
            interestRateMode: "2", // variable rate — matches the position's borrow mode
            onBehalfOf: config.position.walletAddress,
          }
        : {
            network: config.position.chainId,
            asset,
            amount,
            onBehalfOf: config.position.walletAddress,
            referralCode: "0", // no referral
          };

    const finalActionType = action === "repay" ? "aave-v3/repay" : "aave-v3/supply";

    // Use direct execution to avoid KeeperHub wallet limitation
    const result = await executeProtocolWriteDirect(finalActionType, asset, amount, config.position.walletAddress);

    if (result.success) {
      incrementExecutionCount(); // Track session executions
      setLastExecutionTime(); // Update cooldown after successful execution
      const assetName = action === "repay" ? "USDT" : "USDC";
      const successMessage =
        `✅ Successfully executed ${action} of ${amount} ${assetName}!\n` +
        `Transaction: ${result.transactionLink}`;
      console.log(successMessage);
      await notifyLocal(successMessage);
    } else {
      const errorMessage =
        `❌ ${action} failed: ${result.error}`;
      console.error(errorMessage);
      await notifyLocal(errorMessage);
    }

    await mcp.disconnect();
  } catch (error) {
    console.error("Guardian execution failed:", error);
    await mcp.disconnect();
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    resetSessionCount(); // Reset session count for new run
    await runOnce();
  } else {
    console.log("Watch mode not implemented yet. Use --once flag.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});