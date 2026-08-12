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

  // Check for existing workflow by name (not hardcoded ID)
  console.log("Checking for existing workflows...");
  const existingWorkflows = await mcp.callTool("list_workflows", {});
  const workflowName = "Position Guardian — Aave V3";
  const existingWorkflow = JSON.parse(existingWorkflows).find(
    (w: any) => w.name === workflowName && !w.deletedAt
  );

  let workflowId: string;
  if (existingWorkflow) {
    workflowId = existingWorkflow.id;
    console.log(`Found existing workflow: ${workflowId}`);
    console.log(`Status: ${existingWorkflow.enabled ? "ENABLED" : "DISABLED"}`);
    console.log(`Last updated: ${existingWorkflow.updatedAt}`);
    
    // Update to use latest configuration (chain/network changes)
    console.log("\nUpdating workflow with latest configuration...");
    const { nodes, edges } = buildGuardianWorkflowNodes();
    const updated = await mcp.callTool("update_workflow", {
      workflowId,
      nodes,
      edges,
      enabled: false, // Create disabled, enable deliberately
      inputSchema: { type: "object" }, // Required for marketplace listing
    });
    console.log(updated);
    console.log(`\nWorkflow updated (DISABLED). Dashboard link: https://app.keeperhub.com/workflows/${workflowId}`);
  } else {
    console.log(`No existing workflow found. Creating new workflow...`);
    const { nodes, edges } = buildGuardianWorkflowNodes();

    console.log("Creating new workflow (DISABLED for safety)...");
    const created = await mcp.callTool("create_workflow", {
      name: workflowName,
      description:
        "Monitors an Aave V3 health factor and auto-repays when it drops below the configured threshold.",
      nodes,
      edges,
      enabled: false, // Create disabled, enable deliberately
      inputSchema: { type: "object" }, // Required for marketplace listing
    });
    console.log(created);
    workflowId = JSON.parse(created).id;
    console.log(`\nWorkflow created (DISABLED). Dashboard link: https://app.keeperhub.com/workflows/${workflowId}`);
  }

  // Write the workflow ID to .env
  console.log(`\n=== IMPORTANT ===`);
  console.log(`Add this to your .env file:`);
  console.log(`GUARDIAN_WORKFLOW_ID=${workflowId}`);
  console.log(`==================\n`);

  console.log(
    "\nNext steps:\n1. Add GUARDIAN_WORKFLOW_ID to your .env file (see above)\n2. Review the workflow in the KeeperHub dashboard\n3. Enable it from the dashboard when ready\n"
  );

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
