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
  return publicClient.readContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [walletAddress as `0x${string}`],
  }) as Promise<bigint>;
}

/** Wallet's current balance of the debt asset (USDT, 6 decimals) — what a repay would spend. */
export async function getDebtAssetBalance(walletAddress: string): Promise<bigint> {
  return getErc20Balance(config.assets.debtAsset, walletAddress);
}

/** Wallet's current balance of the collateral asset (USDC, 6 decimals) — what a supply would spend. */
export async function getCollateralAssetBalance(walletAddress: string): Promise<bigint> {
  return getErc20Balance(config.assets.collateralAsset, walletAddress);
}
