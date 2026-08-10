import { config } from "./config.js";
import { createKeeperHubClient } from "./mcp/keeperhubClient.js";
import { runAgent, AgentStep } from "./agent/geminiAgent.js";
import { notifyLocal } from "./notify/logger.js";

const SYSTEM_PROMPT = `You are the Position Guardian, an autonomous agent responsible for a
single Aave V3 lending position on chain ${config.position.chainId}, wallet
${config.position.walletAddress}.

Your job, every time you are invoked:
1. Find the "Position Guardian — Aave V3" workflow with list_workflows, then trigger it with
   execute_workflow, then read the result with get_execution.
2. From the execution result, determine the current health factor.
3. If the health factor is at or above ${config.position.healthFactorThreshold}, state clearly
   that the position is healthy and stop. Do not take any write action.
4. If the health factor is below ${config.position.healthFactorThreshold}, the workflow's
   condition branch should have already triggered a repay. Confirm this by checking the
   execution logs for the repay and notification steps. If for any reason the automated
   repay did NOT fire (e.g. the workflow is disabled), fall back to direct execution:
   a. Call execute_protocol_action for aave-v3/repay with simulate: true first.
   b. Only if the simulation returns success: true and wouldRevert: false, repeat the call
      with simulate omitted and a fresh idempotency_key.
   c. Poll get_direct_execution_status until the status is completed or failed.
5. Always end your final message with a one-paragraph plain-English summary of what you
   found and what you did (or explicitly that you did nothing because the position was
   healthy). This summary is the audit record a human will read.

Never guess at a transaction outcome — always confirm status via the MCP tools before
reporting success. Treat any tool error as a hard stop: report it, do not retry blindly.`;

const USER_PROMPT = `Check the Aave V3 position and act according to your instructions.`;

async function runOnce(): Promise<void> {
  const mcp = createKeeperHubClient();
  await mcp.connect();
  const tools = await mcp.listGeminiTools();

  console.log(`\n[${new Date().toISOString()}] Guardian run starting...`);
  const { transcript, finalText } = await runAgent(SYSTEM_PROMPT, USER_PROMPT, mcp, tools);

  logTranscript(transcript);
  console.log(`\n=== SUMMARY ===\n${finalText}\n`);
  await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${finalText}`);

  await mcp.disconnect();
}

function logTranscript(transcript: AgentStep[]): void {
  for (const step of transcript) {
    const prefix =
      step.type === "thought"
        ? "🤔 THOUGHT "
        : step.type === "tool_call"
        ? "🔧 CALL    "
        : step.type === "tool_result"
        ? "📄 RESULT  "
        : "✅ FINAL   ";
    console.log(`${prefix}${truncate(step.text, 500)}`);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "... [truncated]" : s;
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
