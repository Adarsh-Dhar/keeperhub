import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { config } from "../config.js";

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpc.url),
});

async function getErc20Balance(tokenAddress: string, walletAddress: string): Promise<bigint> {
  try {
    const balance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [walletAddress as `0x${string}`],
    }) as bigint;
    return balance;
  } catch (error) {
    // Silently return 0 balance if contract call fails (Base Sepolia has read issues)
    return BigInt(0);
  }
}

/** Wallet's current balance of the debt asset (USDT, 6 decimals) — what a repay would spend. */
export async function getDebtAssetBalance(walletAddress: string): Promise<bigint> {
  try {
    // Use the actual ERC20 token address for wallet balance checks
    const balance = await getErc20Balance(config.assets.walletDebtAsset, walletAddress);
    return balance;
  } catch (error) {
    console.log("⚠️ Error getting debt asset balance, assuming 0");
    return BigInt(0);
  }
}

/** Wallet's current balance of the collateral asset (USDC, 6 decimals) — what a supply would spend. */
export async function getCollateralAssetBalance(walletAddress: string): Promise<bigint> {
  try {
    // Use the actual ERC20 token address for wallet balance checks
    const balance = await getErc20Balance(config.assets.walletCollateralAsset, walletAddress);
    return balance;
  } catch (error) {
    console.log("⚠️ Error getting collateral asset balance, assuming 0");
    return BigInt(0);
  }
}
