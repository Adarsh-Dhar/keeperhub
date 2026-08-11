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

  // Check if workflow already exists
  console.log("Checking for existing workflows...");
  const existingWorkflows = await mcp.callTool("list_workflows", {});
  const workflowName = "Position Guardian — Aave V3";
  const existingWorkflow = JSON.parse(existingWorkflows).find(
    (w: any) => w.name === workflowName
  );

  if (existingWorkflow) {
    console.log(`Found existing workflow: ${existingWorkflow.id}`);
    console.log(`Status: ${existingWorkflow.enabled ? "ENABLED" : "DISABLED"}`);
    console.log(`Last updated: ${existingWorkflow.updatedAt}`);
    
    // Always update to use latest configuration (chain/network changes)
    console.log("\nUpdating existing workflow with latest configuration...");
    const { nodes, edges } = buildGuardianWorkflowNodes();
    const updated = await mcp.callTool("update_workflow", {
      workflowId: existingWorkflow.id,
      nodes,
      edges,
      enabled: existingWorkflow.enabled, // Preserve enabled status
    });
    console.log(updated);
    console.log(`\nWorkflow updated. Dashboard link: https://app.keeperhub.com/workflows/${existingWorkflow.id}`);
  } else {
    const { nodes, edges } = buildGuardianWorkflowNodes();

    console.log("Creating new workflow (disabled by default)...");
    const created = await mcp.callTool("create_workflow", {
      name: workflowName,
      description:
        "Monitors an Aave V3 health factor and auto-repays when it drops below the configured threshold.",
      nodes,
      edges,
      enabled: false,
    });
    console.log(created);
    console.log(`\nDashboard link: https://app.keeperhub.com/workflows/${JSON.parse(created).id}`);
  }

  console.log(
    "\nReview the workflow in the KeeperHub dashboard, then enable it when ready."
  );

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
