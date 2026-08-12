import { createKeeperHubClient } from "./src/mcp/keeperhubClient.js";
import { config } from "./src/config.js";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import "dotenv/config";

const KEEPERHUB_WALLET = "0x486049Acc7D8b840789FB58FD88bb207357C0480";
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function main() {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  console.log("=== KeeperHub Wallet Analysis ===");
  console.log("Wallet address:", KEEPERHUB_WALLET);
  console.log("Guardian wallet configured in .env:", config.position.walletAddress);
  console.log("\nFetching KeeperHub's integrations...\n");

  // First list integrations to get the integration ID
  const integrationsResult = await mcp.callTool("list_integrations", {});
  console.log("Integrations:", integrationsResult);

  // Parse the result to find wallet integration
  try {
    const integrations = JSON.parse(integrationsResult);
    const walletIntegration = integrations.find((i: any) => i.type === "web3" || i.type === "wallet");
    
    if (walletIntegration && walletIntegration.id) {
      console.log("\nFound wallet integration ID:", walletIntegration.id);
      console.log("\nFetching wallet integration details...\n");
      
      const walletResult = await mcp.callTool("get_wallet_integration", { integrationId: walletIntegration.id });
      console.log("Wallet integration details:", walletResult);
    } else {
      console.log("\nNo wallet integration found in list_integrations result");
    }
  } catch (parseError) {
    console.log("\nCould not parse integrations result:", integrationsResult);
  }

  await mcp.disconnect();

  // Check wallet balances directly using viem
  console.log("\n=== Direct Wallet Balance Check ===");
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpc.url),
  });

  try {
    // Check BASE (native token) balance
    const baseBalance = await publicClient.getBalance({
      address: KEEPERHUB_WALLET as `0x${string}`,
    });
    console.log(`BASE balance: ${baseBalance.toString()} wei (${Number(baseBalance) / 1e18} BASE)`);

    // Check USDC balance
    const usdcBalance = await publicClient.readContract({
      address: USDC_ADDRESS as `0x${string}`,
      abi: [
        {
          inputs: [{ name: "account", type: "address" }],
          name: "balanceOf",
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "balanceOf",
      args: [KEEPERHUB_WALLET as `0x${string}`],
    });
    console.log(`USDC balance: ${usdcBalance.toString()} (${Number(usdcBalance) / 1e6} USDC)`);

    console.log("\n=== Fund Requirements ===");
    console.log("For Aave V3 supply operation:");
    console.log("1. BASE (gas): ~0.01-0.05 BASE per transaction");
    console.log("2. USDC: Amount you want to supply (e.g., 10-50 USDC for testing)");
    console.log("\nCurrent status:");
    console.log(`- BASE: ${Number(baseBalance) / 1e18} BASE (need ~0.05 for gas)`);
    console.log(`- USDC: ${Number(usdcBalance) / 1e6} USDC (need 10+ for position)`);
    
    if (Number(baseBalance) / 1e18 < 0.05) {
      console.log("\n⚠️  INSUFFICIENT BASE for gas - needs more BASE");
    }
    if (Number(usdcBalance) / 1e6 < 10) {
      console.log("⚠️  INSUFFICIENT USDC - needs 10+ USDC to create meaningful position");
    }

  } catch (balanceError) {
    console.log("Could not check balances directly:", balanceError);
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});