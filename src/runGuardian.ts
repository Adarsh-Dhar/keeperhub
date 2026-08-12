import { config } from "./config.js";
import { createKeeperHubClient } from "./mcp/keeperhubClient.js";
import { notifyLocal } from "./notify/logger.js";
import { calculateRepayAmount } from "./workflows/workflowDefinition.js";
import { runAgent } from "./agent/geminiAgent.js";

const SYSTEM_PROMPT = `You are the Position Guardian, an agent that reviews an
Aave V3 lending position on Base Sepolia for liquidation risk.

Wallet: ${config.position.walletAddress}
Chain ID: ${config.position.chainId}
Health factor threshold: ${config.position.healthFactorThreshold}

Call the aave-v3/get-user-account-data protocol action to read the current
position. Then report your assessment as your final answer, in this exact
format:

RISK: <at-risk|healthy>
HEALTH_FACTOR: <number>
REASONING: <2-3 sentences explaining why, referencing the actual collateral,
debt, and liquidation threshold numbers you read>

You are not authorized to execute any repay or write action yourself — a
separate deterministic system handles execution. Your job is only to read
the position and explain the risk assessment clearly.`;

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

  // --- Gemini reasoning pass ---
  console.log("\n--- Gemini assessment ---");
  const tools = await mcp.listGeminiTools();
  const agentResult = await runAgent(
    SYSTEM_PROMPT,
    "Assess the current position and report your risk assessment.",
    mcp,
    tools
  );
  for (const step of agentResult.transcript) {
    const icon = { thought: "🤔 THOUGHT", tool_call: "🔧 CALL", tool_result: "📄 RESULT", final: "✅ ASSESSMENT" }[step.type];
    console.log(`${icon}   ${step.text}`);
  }
  console.log("--- end Gemini assessment ---\n");

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
      await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n**Agent assessment:** ${agentResult.finalText}\n\n${message}`);
      await mcp.disconnect();
      return;
    }

    // Step 3: Position is at risk - calculate repay amount dynamically
    const repayAmount = calculateRepayAmount(healthData, config.position.healthFactorThreshold);
    console.log(`Calculated repay amount: ${repayAmount} wei (${(Number(repayAmount) / 1e6).toFixed(6)} USDT)`);

    const warningMessage = `⚠️ POSITION AT RISK! Health factor ${actualHealthFactor.toFixed(4)} is below threshold ${config.position.healthFactorThreshold}. Executing USDT repay action with amount: ${repayAmount}...`;
    console.log(warningMessage);
    await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n**Agent assessment:** ${agentResult.finalText}\n\n${warningMessage}`);

    const repayParams = {
      network: config.position.chainId,
      asset: "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a", // Base Sepolia Aave V3 USDT underlying
      amount: repayAmount,
      interestRateMode: "2", // variable rate — matches the position's borrow mode
      onBehalfOf: config.position.walletAddress,
    };

    // Step 3a: simulate first — this is the safety check the direct-viem
    // path didn't have. If this throws or reports it would revert, we stop
    // before spending any real gas or touching the position.
    console.log("Simulating repay via KeeperHub...");
    const simResultRaw = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/repay",
      params: repayParams,
      simulate: true,
    });
    const simResult = JSON.parse(simResultRaw);
    console.log("Simulation result:", JSON.stringify(simResult, null, 2));

    if (simResult.wouldRevert || simResult.success === false) {
      const errorMessage = `❌ Repay simulation failed, aborting before real execution: ${simResultRaw}`;
      console.error(errorMessage);
      await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\n${errorMessage}`);
      await mcp.disconnect();
      return;
    }

    // Step 3b: real execution through KeeperHub.
    console.log("Simulation passed. Executing real repay via KeeperHub...");
    const execResultRaw = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/repay",
      params: repayParams,
      idempotency_key: `guardian-repay-${Date.now()}`,
    });
    const execResult = JSON.parse(execResultRaw);
    console.log("Execution submitted:", JSON.stringify(execResult, null, 2));

    if (!execResult.executionId) {
      const errorMessage = `❌ Repay execution did not return an executionId: ${execResultRaw}`;
      console.error(errorMessage);
      await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\n${errorMessage}`);
      await mcp.disconnect();
      return;
    }

    // Step 3c: poll for the on-chain result.
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
      const errorMessage = `❌ Repay execution did not complete in time. Last status: ${JSON.stringify(statusResult)}`;
      console.error(errorMessage);
      await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\n${errorMessage}`);
      await mcp.disconnect();
      return;
    }

    const transactionLink =
      statusResult.transactionLink ||
      (statusResult.transactionHash ? `https://sepolia.basescan.org/tx/${statusResult.transactionHash}` : "Transaction link not available");

    const successMessage = `✅ Repay executed successfully via KeeperHub!\nTransaction: ${transactionLink}\nHealth factor was ${actualHealthFactor.toFixed(4)} (below threshold ${config.position.healthFactorThreshold})`;
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
