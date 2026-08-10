import { createKeeperHubClient } from "../mcp/keeperhubClient.js";
import { buildGuardianWorkflowNodes } from "./workflowDefinition.js";

/**
 * Run once, interactively, before the guardian goes live:
 *   npm run setup:workflow
 *
 * 1. Discovers the real Aave V3 action schemas (field names change between
 *    KeeperHub releases, so we never hardcode them blindly).
 * 2. Builds the workflow graph.
 * 3. Creates it DISABLED so a human confirms before it can move funds.
 *    (create_workflow validates the structure server-side before saving).
 * 4. Prints the workflow ID needed by runGuardian.ts and the marketplace scripts.
 */
async function main() {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  console.log("Discovering Aave V3 protocol actions...");
  const actions = await mcp.callTool("search_protocol_actions", {
    protocol: "aave-v3",
  });
  console.log(actions);
  console.log(
    "\nCompare the field names above against src/workflows/workflowDefinition.ts " +
      "and adjust `actionType`/argument names if they differ before continuing.\n"
  );

  const { nodes, edges } = buildGuardianWorkflowNodes();

  console.log("Creating workflow (disabled by default)...");
  const created = await mcp.callTool("create_workflow", {
    name: "Position Guardian — Aave V3",
    description:
      "Monitors an Aave V3 health factor and auto-repays when it drops below the configured threshold.",
    nodes,
    edges,
    enabled: false,
  });
  console.log(created);

  console.log(
    "\nWorkflow created disabled. Review it in the KeeperHub dashboard, then either:\n" +
      "  - enable it there, or\n" +
      "  - call update_workflow with enabled=true once you're confident in the repay amount logic.\n" +
      "Copy the workflow id printed above into your notes — runGuardian.ts looks it up by name,\n" +
      "but scripting against the id directly is faster for iteration."
  );

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
