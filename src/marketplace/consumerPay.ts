import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { config } from "../config.js";
import { createKeeperHubClient } from "../mcp/keeperhubClient.js";

/**
 * Demonstrates the marketplace loop: a SEPARATE agent identity discovers the
 * listed guardian workflow and pays a few cents of Base Sepolia USDC per call
 * via x402, instead of running its own copy of the guardian logic.
 *
 * IMPORTANT — read before running:
 * KeeperHub's docs describe two supported paths for this:
 *   1. Production path: install the official KeeperHub agentic wallet
 *      (`@keeperhub/wallet` skill) inside Claude Code. Its PreToolUse hook
 *      intercepts the 402 challenge that `call_workflow` surfaces as an MCP
 *      tool error, evaluates it against ~/.keeperhub/safety.json, and retries
 *      automatically. That is the officially supported, safety-hook-gated
 *      route and is what you should demo as your primary flow.
 *   2. DIY path (this file): calls the MCP `call_workflow` tool directly,
 *      catches the 402 challenge in the tool error text, and pays it with a
 *      plain x402 wallet (x402-fetch + viem) instead of the agentic wallet.
 *      This only works if KeeperHub also exposes the listed workflow over a
 *      plain HTTP endpoint that returns a standard x402 402 response (rather
 *      than an MCP tool error) — confirm the exact call shape against
 *      KeeperHub's live API/marketplace docs before the demo, and adjust
 *      `PAID_CALL_URL` below accordingly.
 *
 * Both paths pay in Base Sepolia USDC and never touch a private key with
 * real funds — use a throwaway test wallet only.
 */

const PAID_CALL_URL = process.env.KEEPERHUB_PAID_CALL_URL ?? "";

async function main() {
  if (!config.marketplace.payerPrivateKey) {
    throw new Error("Set X402_PAYER_PRIVATE_KEY in .env — use a throwaway testnet key only.");
  }

  console.log("Discovering the listed guardian via MCP search_workflows (read path, no payment)...");
  const mcp = createKeeperHubClient();
  await mcp.connect();
  const listings = await mcp.callTool("search_workflows", {
    query: config.marketplace.workflowSlug,
  });
  console.log(listings);
  await mcp.disconnect();

  if (!PAID_CALL_URL) {
    console.log(
      "\nSet KEEPERHUB_PAID_CALL_URL to the plain HTTP endpoint for this listing " +
        "(check the marketplace listing page / API docs for the exact route) to run the " +
        "paid call below. Skipping the payment step for now.\n" +
        "Alternative: install the official @keeperhub/wallet skill in Claude Code and simply " +
        "ask it to call the workflow — its PreToolUse hook handles the 402 for you."
    );
    return;
  }

  const account = privateKeyToAccount(config.marketplace.payerPrivateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, transport: http(), chain: baseSepolia });
  const fetchWithPay = wrapFetchWithPayment(fetch, walletClient);

  console.log(`Calling paid endpoint as ${account.address} (auto-pays any 402 challenge)...`);
  const response = await fetchWithPay(PAID_CALL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: {
        chainId: config.position.chainId,
        userAddress: config.position.walletAddress,
      },
    }),
  });

  const data = await response.json();
  console.log("Paid call result:", data);
}

main().catch((err) => {
  console.error("Consumer payment demo failed:", err);
  process.exit(1);
});
