import { createKeeperHubClient } from "../mcp/keeperhubClient.js";
import { buildGuardianWorkflowNodes } from "./workflowDefinition.js";
import fs from "node:fs";
import path from "node:path";

const WORKFLOW_NAME = "Position Guardian — Aave V3";

function writeWorkflowIdToEnv(workflowId: string): void {
  const envPath = path.resolve(process.cwd(), ".env");
  let contents = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

  if (/^GUARDIAN_WORKFLOW_ID=.*$/m.test(contents)) {
    contents = contents.replace(/^GUARDIAN_WORKFLOW_ID=.*$/m, `GUARDIAN_WORKFLOW_ID=${workflowId}`);
  } else {
    contents += `\nGUARDIAN_WORKFLOW_ID=${workflowId}\n`;
  }

  fs.writeFileSync(envPath, contents);
  console.log(`\nWrote GUARDIAN_WORKFLOW_ID=${workflowId} to .env`);
}

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

  console.log("Checking for an existing guardian workflow...");
  const existingWorkflowsRaw = await mcp.callTool("list_workflows", {});
  const existingWorkflows = JSON.parse(existingWorkflowsRaw);
  const existingWorkflow = existingWorkflows.find(
    (w: any) => w.name === WORKFLOW_NAME
  );

  const { nodes, edges } = buildGuardianWorkflowNodes();

  if (existingWorkflow) {
    console.log(`Found existing workflow: ${existingWorkflow.id}`);
    console.log(`Status: ${existingWorkflow.enabled ? "ENABLED" : "DISABLED"}`);

    console.log("\nAttempting to update existing workflow with latest configuration...");
    try {
      const updated = await mcp.callTool("update_workflow", {
        workflowId: existingWorkflow.id,
        nodes,
        edges,
        inputSchema: { type: "object" }, // Required for marketplace listing
        // enabled intentionally omitted — don't flip an already-reviewed
        // workflow's enabled state as a side effect of a config update.
      });
      console.log(updated);
      writeWorkflowIdToEnv(existingWorkflow.id);
      console.log(`Dashboard link: https://app.keeperhub.com/workflows/${existingWorkflow.id}`);
    } catch (updateError) {
      console.error(`Failed to update workflow: ${updateError}`);
      console.log("Creating a new workflow instead...");
      
      const created = await mcp.callTool("create_workflow", {
        name: WORKFLOW_NAME,
        description:
          "Monitors an Aave V3 health factor and auto-repays when it drops below the configured threshold.",
        nodes,
        edges,
        enabled: false, // created disabled — a human enables it deliberately after review
        inputSchema: { type: "object" }, // Required for marketplace listing
      });
      console.log(created);
      const newWorkflowId = JSON.parse(created).id;
      writeWorkflowIdToEnv(newWorkflowId);
      console.log(`Dashboard link: https://app.keeperhub.com/workflows/${newWorkflowId}`);
    }
  } else {
    console.log(`No existing "${WORKFLOW_NAME}" workflow found. Creating a new one...`);
    const created = await mcp.callTool("create_workflow", {
      name: WORKFLOW_NAME,
      description:
        "Monitors an Aave V3 health factor and auto-repays when it drops below the configured threshold.",
      nodes,
      edges,
      enabled: false, // created disabled — a human enables it deliberately after review
      inputSchema: { type: "object" }, // Required for marketplace listing
    });
    console.log(created);
    const newWorkflowId = JSON.parse(created).id;
    writeWorkflowIdToEnv(newWorkflowId);
    console.log(`Dashboard link: https://app.keeperhub.com/workflows/${newWorkflowId}`);
  }

  console.log(
    "\nReview the workflow in the KeeperHub dashboard, then enable it deliberately when ready."
  );

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
