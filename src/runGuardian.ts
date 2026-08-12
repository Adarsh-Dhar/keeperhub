import { config } from "./config.js";
import { createKeeperHubClient, KeeperHubMCP } from "./mcp/keeperhubClient.js";
import { notifyLocal } from "./notify/logger.js";
import { calculateRepayAmount, calculateSupplyAmount } from "./workflows/workflowDefinition.js";
import { getDebtAssetBalance, getCollateralAssetBalance } from "./onchain/balances.js";
import { decideRepayVsSupply, DecisionContext } from "./agent/decisionAgent.js";

const CRITICAL_HEALTH_FACTOR = 1.1; // below this + can't act -> escalate as critical

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
  actionType: "aave-v3/repay" | "aave-v3/supply",
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

  if (simResult.wouldRevert || simResult.success === false) {
    return { success: false, error: `Simulation failed, aborting before real execution: ${simResultRaw}` };
  }

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
    const healthDataResult = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/get-user-account-data",
      params: {
        network: config.position.chainId,
        user: config.position.walletAddress,
      },
    });

    const healthData = JSON.parse(healthDataResult);

    if (!healthData.result || !healthData.result.healthFactor) {
      throw new Error("healthFactor not found in response");
    }
    const d = healthData.result;

    const actualHealthFactor = Number(BigInt(d.healthFactor)) / 1e18;

    console.log("=== Position data ===");
    console.log(`Total collateral (base): ${d.totalCollateralBase}`);
    console.log(`Total debt (base): ${d.totalDebtBase}`);
    console.log(`Liquidation threshold: ${Number(d.currentLiquidationThreshold) / 100}%`);
    console.log(`Health factor: ${actualHealthFactor.toFixed(4)} (threshold: ${config.position.healthFactorThreshold})`);

    // --- Step 2: healthy? done, no further reads, no agent call ---
    if (actualHealthFactor >= config.position.healthFactorThreshold) {
      const message = `Position is healthy. Current health factor: ${actualHealthFactor.toFixed(4)} (threshold: ${config.position.healthFactorThreshold}). No action needed.`;
      console.log(message);
      await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${message}`);
      await mcp.disconnect();
      return;
    }

    // --- Step 3: at risk — gather the rest of the data table ---
    const [debtAssetBalanceRaw, collateralAssetBalanceRaw] = await Promise.all([
      getDebtAssetBalance(config.position.walletAddress),
      getCollateralAssetBalance(config.position.walletAddress),
    ]);

    const requiredRepayAmount = calculateRepayAmount(healthData, config.position.healthFactorThreshold);
    const requiredSupplyAmount = calculateSupplyAmount(healthData, config.position.healthFactorThreshold);

    // Both balances and both required amounts are in 6-decimal token units.
    const debtAssetBalance = debtAssetBalanceRaw.toString();
    const collateralAssetBalance = collateralAssetBalanceRaw.toString();

    console.log("\n=== Affordability data ===");
    console.log(`Wallet USDT (debt asset) balance: ${debtAssetBalance}`);
    console.log(`Wallet USDC (collateral asset) balance: ${collateralAssetBalance}`);
    console.log(`Required repay amount: ${requiredRepayAmount} USDT`);
    console.log(`Required supply amount: ${requiredSupplyAmount} USDC`);

    const repayAffordable = debtAssetBalanceRaw >= BigInt(requiredRepayAmount);
    const supplyAffordable = collateralAssetBalanceRaw >= BigInt(requiredSupplyAmount);

    console.log(`Repay affordable: ${repayAffordable}`);
    console.log(`Supply affordable: ${supplyAffordable}`);

    // --- Step 4: route to a decision ---
    let action: "repay" | "supply" | "escalate";
    let decisionReasoning = "";

    if (repayAffordable && supplyAffordable) {
      // The one genuinely ambiguous branch — ask the agent.
      console.log("\n--- Agent decision: both repay and supply are affordable ---");
      const ctx: DecisionContext = {
        healthFactor: actualHealthFactor,
        threshold: config.position.healthFactorThreshold,
        totalCollateralBase: d.totalCollateralBase,
        totalDebtBase: d.totalDebtBase,
        liquidationThresholdPct: Number(d.currentLiquidationThreshold) / 100,
        debtAssetBalance,
        collateralAssetBalance,
        requiredRepayAmount,
        requiredSupplyAmount,
      };
      const decision = await decideRepayVsSupply(ctx);
      action = decision.action;
      decisionReasoning = decision.reasoning;
      console.log(`ACTION: ${decision.action}`);
      console.log(`REASONING: ${decision.reasoning}`);
      console.log("--- end agent decision ---\n");
    } else if (repayAffordable) {
      action = "repay";
      decisionReasoning = "Only repay is affordable (insufficient USDC for supply) — single viable option.";
      console.log(decisionReasoning);
    } else if (supplyAffordable) {
      action = "supply";
      decisionReasoning = "Only supply is affordable (insufficient USDT for repay) — single viable option.";
      console.log(decisionReasoning);
    } else {
      action = "escalate";
      decisionReasoning = "Neither repay nor supply is affordable with current wallet balances.";
      console.log(decisionReasoning);
    }

    // --- Step 5: act ---
    if (action === "escalate") {
      const critical = actualHealthFactor <= CRITICAL_HEALTH_FACTOR;
      const icon = critical ? "🚨 CRITICAL" : "⚠️";
      const message =
        `${icon} POSITION AT RISK, GUARDIAN CANNOT ACT AUTOMATICALLY\n` +
        `Health factor: ${actualHealthFactor.toFixed(4)} (threshold: ${config.position.healthFactorThreshold})\n` +
        `Needed ${requiredRepayAmount} USDT to repay (wallet has ${debtAssetBalance}) or ` +
        `${requiredSupplyAmount} USDC to supply (wallet has ${collateralAssetBalance}) — neither is fully funded.\n` +
        `Please fund the guardian wallet or intervene manually${critical ? " as soon as possible" : ""}.`;
      console.error(message);
      await notifyLocal(`**Position Guardian run — action required** (${new Date().toISOString()})\n${message}`);
      await mcp.disconnect();
      return;
    }

    const amount = action === "repay" ? requiredRepayAmount : requiredSupplyAmount;
    const actionType = action === "repay" ? "aave-v3/repay" : "aave-v3/supply";
    const asset = action === "repay" ? config.assets.debtAsset : config.assets.collateralAsset;

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
          };

    const warningMessage =
      `⚠️ POSITION AT RISK! Health factor ${actualHealthFactor.toFixed(4)} is below threshold ${config.position.healthFactorThreshold}. ` +
      `Executing ${action} of ${amount} ${action === "repay" ? "USDT" : "USDC"}...\n` +
      (decisionReasoning ? `Reasoning: ${decisionReasoning}` : "");
    console.log(warningMessage);
    await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${warningMessage}`);

    const result = await executeProtocolWrite(mcp, actionType, params);

    if (!result.success) {
      const errorMessage = `❌ ${action} failed: ${result.error || "Unknown error"}`;
      console.error(errorMessage);
      await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\n${errorMessage}`);
      await mcp.disconnect();
      return;
    }

    const successMessage =
      `✅ ${action === "repay" ? "Repay" : "Supply"} executed successfully via KeeperHub!\n` +
      `Transaction: ${result.transactionLink || "link not available"}\n` +
      `Health factor was ${actualHealthFactor.toFixed(4)} (below threshold ${config.position.healthFactorThreshold})`;
    console.log(successMessage);
    await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${successMessage}`);

  } catch (error) {
    const errorMessage = `Guardian execution failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(errorMessage);
    await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\n${errorMessage}`);
    await mcp.disconnect();
  }
}

async function runWatch(): Promise<void> {
  console.log("Starting guardian in watch mode (every 15 minutes)...");
  while (true) {
    await runOnce();
    console.log("Waiting 15 minutes before next check...");
    await new Promise((resolve) => setTimeout(resolve, 15 * 60 * 1000));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");

  if (once) {
    await runOnce();
  } else {
    await runWatch();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
