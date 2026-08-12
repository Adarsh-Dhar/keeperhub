import { config } from "./config.js";
import { createKeeperHubClient } from "./mcp/keeperhubClient.js";
import { notifyLocal } from "./notify/logger.js";
import { runAgent } from "./agent/geminiAgent.js";

const SYSTEM_PROMPT = `You are the Position Guardian. Check wallet ${config.position.walletAddress} on chain ${config.position.chainId}.

STEP 1: Call execute_protocol_action with actionType "aave-v3/get-user-account-data", params: {"user": "${config.position.walletAddress}", "network": ${config.position.chainId}}

STEP 2: Check the healthFactor from the result. If healthFactor >= ${config.position.healthFactorThreshold}, report "Position is healthy" and STOP. Do not call any other tools.

STEP 3: Only if healthFactor < ${config.position.healthFactorThreshold}, call execute_protocol_action with actionType "aave-v3/repay", params: {"asset": "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a", "amount": "5000000", "network": ${config.position.chainId}, "onBehalfOf": "${config.position.walletAddress}", "interestRateMode": "2"}

DO NOT call list_workflows, search_protocol_actions, or any other tools. Only use execute_protocol_action.`;

async function runOnce(): Promise<void> {
  if (!config.position.workflowId) {
    console.error(
      "GUARDIAN_WORKFLOW_ID is not set. Run `npm run setup:workflow` first, " +
        "or add it to .env manually."
    );
    return;
  }

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

  try {
    const tools = await mcp.listGeminiTools();
    const userPrompt = "Run a guardian check now and act if needed.";

    const result = await runAgent(SYSTEM_PROMPT, userPrompt, mcp, tools);

    for (const step of result.transcript) {
      const icon = { thought: "🤔 THOUGHT", tool_call: "🔧 CALL", tool_result: "📄 RESULT", final: "✅ FINAL" }[step.type];
      console.log(`${icon}   ${step.text}`);
    }

    console.log(`\n=== SUMMARY ===\n${result.finalText}\n`);
    await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${result.finalText}`);
  } catch (error) {
    console.error("Guardian run failed:", error);
    await notifyLocal(`**Position Guardian run failed** (${new Date().toISOString()})\nError: ${error}`);
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
