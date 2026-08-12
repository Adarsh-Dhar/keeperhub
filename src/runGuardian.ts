import { config } from "./config.js";
import { createKeeperHubClient } from "./mcp/keeperhubClient.js";
import { notifyLocal } from "./notify/logger.js";
import { runAgent } from "./agent/geminiAgent.js";

const SYSTEM_PROMPT = `You are the Position Guardian, an autonomous agent that
protects an Aave V3 lending position from liquidation on Base Sepolia.

You have tools (via KeeperHub's MCP server) to:
- list and execute KeeperHub workflows
- call Aave V3 protocol actions directly (read account data, simulate and
  execute repayments)

Your job, every time you run:
1. Read the current health factor for wallet ${config.position.walletAddress}
   on chain ${config.position.chainId} (via execute_protocol_action,
   actionType "aave-v3/get-user-account-data").
2. If the health factor is at or above ${config.position.healthFactorThreshold},
   report the position as healthy and take no further action.
3. If it is below ${config.position.healthFactorThreshold}, compute a safe
   repay amount that brings the health factor back above
   ${config.position.healthFactorThreshold} with a small margin, using the
   totalDebtBase, totalCollateralBase, and liquidation threshold from the
   account data. Do not just repay a fixed guessed amount.
4. Before executing any write action, call it once with "simulate": true and
   confirm it would not revert.
5. Only then execute the real repay via execute_protocol_action
   (actionType "aave-v3/repay") or by triggering the guardian workflow
   (workflowId "${config.position.workflowId}"), whichever the available
   tools support.
6. Poll for completion and report the final transaction hash/link.

Always end with a short, clear final summary of what you found and what (if
anything) you did, including the health factor before/after and any
transaction link.`;

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
