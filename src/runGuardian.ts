import { config } from "./config.js";
import { createKeeperHubClient } from "./mcp/keeperhubClient.js";
import { notifyLocal } from "./notify/logger.js";

async function runOnce(): Promise<void> {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  console.log(`\n[${new Date().toISOString()}] Guardian run starting...`);
  console.log(`Checking wallet: ${config.position.walletAddress}`);
  console.log(`Chain ID: ${config.position.chainId}`);
  
  // Direct approach: call the protocol action and analyze the result
  const healthResult = await mcp.callTool("execute_protocol_action", {
    actionType: "aave-v3/get-user-account-data",
    params: {
      network: config.position.chainId,
      user: config.position.walletAddress.toLowerCase(),
    },
  });

  console.log("Health factor result:", healthResult);
  
  const healthData = JSON.parse(healthResult);
  const healthFactor = healthData.result?.healthFactor;
  const totalCollateral = healthData.result?.totalCollateralBase;
  const totalDebt = healthData.result?.totalDebtBase;
  
  let summary: string;
  if (healthFactor && Number(healthFactor) >= config.position.healthFactorThreshold) {
    summary = `Position is healthy. Current health factor: ${healthFactor} (threshold: ${config.position.healthFactorThreshold}). No action needed.`;
  } else {
    summary = `Position at risk. Current health factor: ${healthFactor} (threshold: ${config.position.healthFactorThreshold}). Manual intervention required.`;
  }

  console.log(`\n=== SUMMARY ===\n${summary}\n`);
  await notifyLocal(`**Position Guardian run** (${new Date().toISOString()})\n${summary}`);

  await mcp.disconnect();
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
