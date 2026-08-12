import { config } from "./config.js";
import { createKeeperHubClient } from "./mcp/keeperhubClient.js";
import { notifyLocal } from "./notify/logger.js";
import { calculateRepayAmount } from "./workflows/workflowDefinition.js";
import { executeDirectRepay } from "./executeDirect.js";

async function runOnce(): Promise<void> {
  const mcp = createKeeperHubClient();
  
  try {
    await mcp.connect();
  } catch (error) {
    console.error("Failed to connect to KeeperHub MCP:", error);
    if (error instanceof Error && error.message.includes('ENOTFOUND')) {
      console.error("DNS resolution failed. This is a temporary network issue. Will retry in next cycle.");
    }
    return;
  }

  console.log(`\n[${new Date().toISOString()}] Guardian run starting...`);
  console.log(`Checking wallet: ${config.position.walletAddress}`);
  console.log(`Chain ID: ${config.position.chainId}`);
  console.log(`Health factor threshold: ${config.position.healthFactorThreshold}`);

  try {
    // Step 1: Get current health factor using execute_protocol_action
    console.log("Fetching current health factor...");
    const healthDataResult = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/get-user-account-data",
      params: {
        network: config.position.chainId,
        user: config.position.walletAddress,
      },
    });

    const healthData = JSON.parse(healthDataResult);
    console.log("Raw health data response:", JSON.stringify(healthData, null, 2));
    
    if (!healthData.result || !healthData.result.healthFactor) {
      throw new Error("healthFactor not found in response");
    }
    
    const rawHealthFactor = BigInt(healthData.result.healthFactor);
    const actualHealthFactor = Number(rawHealthFactor) / 1e18;

    console.log(`Raw health factor: ${rawHealthFactor.toString()}`);
    console.log(`Actual health factor: ${actualHealthFactor.toFixed(4)}`);
    console.log(`Threshold: ${config.position.healthFactorThreshold}`);

    // Step 2: Check if at risk
    if (actualHealthFactor >= config.position.healthFactorThreshold) {
      const message = `Position is healthy. Current health factor: ${actualHealthFactor.toFixed(4)} (threshold: ${config.position.healthFactorThreshold}). No action needed.`;
      console.log(message);
      await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${message}`);
      await mcp.disconnect();
      return;
    }

    // Step 3: Position is at risk - calculate repay amount
    const repayAmount = calculateRepayAmount(healthData, config.position.healthFactorThreshold);
    console.log(`Calculated repay amount: ${repayAmount} wei (${(Number(repayAmount) / 1e6).toFixed(6)} USDT)`);

    const warningMessage = `⚠️ POSITION AT RISK! Health factor ${actualHealthFactor.toFixed(4)} is below threshold ${config.position.healthFactorThreshold}. Executing USDT repay action with amount: ${repayAmount}...`;
    console.log(warningMessage);
    await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${warningMessage}`);

    // Execute the repay action directly from your wallet
    console.log("Executing repay action directly from your wallet...");
    const repayResult = await executeDirectRepay(
      repayAmount,
      config.position.walletAddress,
      "2" // Variable rate mode (borrowed in variable mode from setup script)
    );

    console.log("Repay execution result:", repayResult);
    
    // Check if the action was successful
    if (!repayResult.success) {
      const errorMessage = `❌ Repay action failed: ${repayResult.error || 'Unknown error'}`;
      console.error(errorMessage);
      await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\n${errorMessage}`);
      await mcp.disconnect();
      return;
    }
    
    // Create transaction link
    const transactionLink = repayResult.transactionHash 
      ? `https://sepolia.basescan.org/tx/${repayResult.transactionHash}`
      : "Transaction link not available";

    const successMessage = `✅ Repay executed successfully!\nTransaction: ${transactionLink}\nHealth factor was ${actualHealthFactor.toFixed(4)} (below threshold ${config.position.healthFactorThreshold})`;
    console.log(successMessage);
    await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${successMessage}`);

  } catch (error) {
    const errorMessage = `Guardian execution failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(errorMessage);
    await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\n${errorMessage}`);
  } finally {
    await mcp.disconnect();
  }
}

async function main() {
  const mode = process.argv.includes("--watch") ? "watch" : "once";

  if (mode === "once") {
    await runOnce();
    return;
  }

  const intervalMs = 15 * 60 * 1000; // matches the workflow's own schedule trigger cadence
  console.log(`Watch mode: running every ${intervalMs / 60000} minutes. Ctrl+C to stop.`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error("Guardian run failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
