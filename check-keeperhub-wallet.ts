/**
 * Diagnostic: find the KeeperHub org-managed wallet address, and check
 * whether it can actually repay/supply on Aave — i.e. does it hold the
 * asset, and has it approved the pool to spend it.
 *
 * Run with: npx tsx check-keeperhub-wallet.ts
 */
import { config } from "./src/config.js";
import { createKeeperHubClient } from "./src/mcp/keeperhubClient.js";
import { createPublicClient, http, checksumAddress } from "viem";
import { baseSepolia } from "viem/chains";

const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

async function main() {
  const mcp = createKeeperHubClient();
  await mcp.connect();

  console.log("=== Available integrations ===");
  const integrationsRaw = await mcp.callTool("list_integrations", {});
  console.log(integrationsRaw);

  let integrationId: string | undefined;
  let walletAddress: string | undefined;

  try {
    const integrations = JSON.parse(integrationsRaw);
    console.log("\nParsed integrations:", JSON.stringify(integrations, null, 2));

    // Try to find a wallet integration (type can be "wallet" or "web3")
    if (Array.isArray(integrations)) {
      const walletIntegration = integrations.find((i: any) =>
        i.type === "wallet" || i.type === "web3" || i.integrationType === "wallet" || i.category === "wallet"
      );
      if (walletIntegration) {
        integrationId = walletIntegration.id || walletIntegration.integrationId;
        walletAddress = walletIntegration.address || walletIntegration.walletAddress;
      }
    } else if (integrations.result && Array.isArray(integrations.result)) {
      const walletIntegration = integrations.result.find((i: any) =>
        i.type === "wallet" || i.type === "web3" || i.integrationType === "wallet" || i.category === "wallet"
      );
      if (walletIntegration) {
        integrationId = walletIntegration.id || walletIntegration.integrationId;
        walletAddress = walletIntegration.address || walletIntegration.walletAddress;
      }
    }
  } catch (e) {
    console.log("Could not parse integrations:", e instanceof Error ? e.message : e);
  }

  if (!integrationId) {
    console.log("\n⚠️ Could not find a wallet integration ID from the response above.");
    console.log("Please manually identify the wallet integration ID and address, then re-run.");
    await mcp.disconnect();
    return;
  }

  console.log(`\nFound wallet integration ID: ${integrationId}`);
  console.log(`Wallet address: ${walletAddress}`);

  if (walletAddress) {
    const checksummedWallet = checksumAddress(walletAddress as `0x${string}`);
    console.log(`\nKeeperHub-managed wallet: ${checksummedWallet}`);

    console.log("\n=== Spending limits (KeeperHub-side, if configured) ===");
    try {
      const limits = await mcp.callTool("get_spending_limits", {});
      console.log(limits);
    } catch (e) {
      console.log("No spending limits tool response:", e instanceof Error ? e.message : e);
    }

    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpc.url) });
    const aavePool = checksumAddress(config.contracts.aavePool as `0x${string}`);
    const debtAsset = checksumAddress(config.assets.walletDebtAsset as `0x${string}`);
    const collateralAsset = checksumAddress(config.assets.walletCollateralAsset as `0x${string}`);

    console.log("\n=== KeeperHub wallet on-chain state (Base Sepolia) ===");
    for (const [label, token] of [
      ["Debt asset (USDT)", debtAsset],
      ["Collateral asset (USDC)", collateralAsset],
    ] as const) {
      const balance = await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [checksummedWallet],
      });
      const allowance = await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [checksummedWallet, aavePool],
      });
      console.log(`${label}: balance=${balance.toString()}  allowance(to Aave pool)=${allowance.toString()}`);
    }
  } else {
    console.log("\n⚠️ No wallet address found - cannot check on-chain state.");
  }

  await mcp.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
