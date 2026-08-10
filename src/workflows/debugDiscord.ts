import { createKeeperHubClient } from "../mcp/keeperhubClient.js";

async function main() {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  const result = await mcp.callTool("list_action_schemas", { category: "discord" });
  console.log(result);

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("debugDiscord failed:", err);
  process.exit(1);
});
