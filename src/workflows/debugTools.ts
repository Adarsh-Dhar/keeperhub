import { createKeeperHubClient } from "../mcp/keeperhubClient.js";

async function main() {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  const tools = await mcp.listGeminiTools();
  for (const t of tools) {
    console.log(`\n=== ${t.name} ===`);
    console.log(t.description);
    console.log(JSON.stringify(t.parameters, null, 2));
  }

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("debugTools failed:", err);
  process.exit(1);
});
