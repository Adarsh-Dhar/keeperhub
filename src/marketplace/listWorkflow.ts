import { config } from "../config.js";
import { createKeeperHubClient } from "../mcp/keeperhubClient.js";

/**
 * Run once, after the guardian workflow is created and confirmed working:
 *   npm run marketplace:list
 *
 * Publishes it to KeeperHub's marketplace with a small per-call price so
 * other agents can subscribe their own wallet to the same guardian logic
 * and pay a few cents via x402 each time they call it.
 */
async function main() {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  console.log("Looking up the guardian workflow id...");
  const workflows = await mcp.callTool("list_workflows", {});
  console.log(workflows);
  console.log(
    "\nCopy the workflow id for 'Position Guardian — Aave V3' and paste it below " +
      "(left as a manual step so you don't accidentally list the wrong workflow).\n"
  );

  const workflowId = process.env.GUARDIAN_WORKFLOW_ID;
  if (!workflowId) {
    throw new Error(
      "Set GUARDIAN_WORKFLOW_ID in your shell env to the id printed above, then re-run."
    );
  }

  console.log(`Listing workflow ${workflowId} to the marketplace...`);
  const listing = await mcp.callTool("list_workflow", {
    workflowId,
    slug: config.marketplace.workflowSlug,
  });
  console.log(listing);

  console.log("Setting listing metadata and price...");
  const updated = await mcp.callTool("update_workflow_listing", {
    slug: config.marketplace.workflowSlug,
    description:
      "Checks an Aave V3 position's health factor on demand and repays if it is at risk. " +
      "Pay-per-call guardian check for agents managing their own lending positions.",
    category: "defi-risk-management",
    tags: ["aave", "defi", "risk", "health-factor"],
    priceUsd: "0.02",
  });
  console.log(updated);

  console.log(
    `\nListed at slug "${config.marketplace.workflowSlug}". Any agent can now discover it via ` +
      "search_workflows and call it via call_workflow — paid calls return a 402 challenge that " +
      "an x402-capable wallet (see marketplace/consumerPay.ts) settles automatically."
  );

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("Listing failed:", err);
  process.exit(1);
});
