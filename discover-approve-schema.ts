/**
 * Discover the schema for approve action via KeeperHub's execute_contract_call
 * This will help us approve USDT on the KeeperHub wallet for Aave pool interactions
 */
import { createKeeperHubClient } from "./src/mcp/keeperhubClient.js";
import { config } from "./src/config.js";

async function main() {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  console.log("=== Discovering approve action schema ===");

  try {
    // Try to get the schema for execute_contract_call
    const toolsDocumentation = await mcp.callTool("tools_documentation", {});
    console.log("Available tools documentation:");
    console.log(toolsDocumentation);
  } catch (e) {
    console.log("Error getting tools documentation:", e instanceof Error ? e.message : e);
  }

  try {
    // Try to list action schemas
    const actionSchemas = await mcp.callTool("list_action_schemas", {});
    console.log("\nAvailable action schemas:");
    console.log(actionSchemas);
  } catch (e) {
    console.log("Error listing action schemas:", e instanceof Error ? e.message : e);
  }

  // Try to approve USDT to Aave pool using execute_contract_call
  console.log("\n=== Attempting to approve USDT for Aave pool ===");
  console.log(`USDT address: ${config.assets.walletDebtAsset}`);
  console.log(`Aave pool address: ${config.contracts.aavePool}`);

  try {
    const approveResult = await mcp.callTool("execute_contract_call", {
      contract_address: config.assets.walletDebtAsset, // USDT
      chain_id: config.position.chainId,
      function_name: "approve",
      function_args: [
        config.contracts.aavePool, // Aave pool
        "115792089237316195423570985008687907853269984665640564039457584007913129639935" // max uint256
      ]
    });
    console.log("Approve result:");
    console.log(approveResult);
  } catch (e) {
    console.log("Error attempting approve:", e instanceof Error ? e.message : e);
  }

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
