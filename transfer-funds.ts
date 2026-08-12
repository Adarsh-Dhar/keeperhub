import { createWalletClient, createPublicClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import "dotenv/config";

const ERC20_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.BASE_RPC_URL || "https://sepolia.base.org";
  
  if (!privateKey) {
    throw new Error("PRIVATE_KEY not set in environment");
  }

  // KeeperHub wallet address (Turnkey-managed signer)
  const keeperHubWallet = "0x486049aCC7D8b840789fb58fd88bb207357C0480" as const;
  
  // Token addresses on Base Sepolia
  const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
  const USDT_ADDRESS = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a" as const;

  // Amounts to transfer
  const USDC_AMOUNT = "50"; // 50 USDC
  const USDT_AMOUNT = "50"; // 50 USDT

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  console.log("Transferring funds from test wallet to KeeperHub wallet");
  console.log(`From: ${account.address}`);
  console.log(`To: ${keeperHubWallet}`);
  console.log(`USDC Amount: ${USDC_AMOUNT}`);
  console.log(`USDT Amount: ${USDT_AMOUNT}\n`);

  try {
    // Transfer USDC
    console.log("Transferring USDC...");
    // USDC and USDT both have 6 decimals on Base Sepolia
    const usdcDecimals = 6;
    const usdcAmount = parseUnits(USDC_AMOUNT, usdcDecimals);
    
    let usdcBalance: bigint;
    try {
      usdcBalance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      console.log(`Current USDC balance: ${usdcBalance.toString()}`);
    } catch (error) {
      console.log(`⚠️  Cannot check USDC balance (contract may not respond). Assuming 0 balance.`);
      usdcBalance = 0n;
    }
    
    if (usdcBalance < usdcAmount) {
      console.log(`⚠️  Insufficient USDC balance. Need at least ${USDC_AMOUNT} USDC, have ${usdcBalance.toString()}`);
    } else {
      const usdcHash = await walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [keeperHubWallet, usdcAmount],
      });
      
      console.log(`USDC transfer tx: ${usdcHash}`);
      await publicClient.waitForTransactionReceipt({ hash: usdcHash });
      console.log("✓ USDC transferred successfully\n");
    }

    // Transfer USDT
    console.log("Transferring USDT...");
    // USDC and USDT both have 6 decimals on Base Sepolia
    const usdtDecimals = 6;
    const usdtAmount = parseUnits(USDT_AMOUNT, usdtDecimals);
    
    let usdtBalance: bigint;
    try {
      usdtBalance = await publicClient.readContract({
        address: USDT_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      console.log(`Current USDT balance: ${usdtBalance.toString()}`);
    } catch (error) {
      console.log(`⚠️  Cannot check USDT balance (contract may not respond). Assuming 0 balance.`);
      usdtBalance = 0n;
    }
    
    if (usdtBalance < usdtAmount) {
      console.log(`⚠️  Insufficient USDT balance. Need at least ${USDT_AMOUNT} USDT, have ${usdtBalance.toString()}`);
    } else {
      const usdtHash = await walletClient.writeContract({
        address: USDT_ADDRESS,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [keeperHubWallet, usdtAmount],
      });
      
      console.log(`USDT transfer tx: ${usdtHash}`);
      await publicClient.waitForTransactionReceipt({ hash: usdtHash });
      console.log("✓ USDT transferred successfully\n");
    }

    // Check final balances
    console.log("Final balances at KeeperHub wallet:");
    let keeperHubUsdcBalance: bigint;
    let keeperHubUsdtBalance: bigint;
    
    try {
      keeperHubUsdcBalance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [keeperHubWallet],
      });
      console.log(`USDC: ${keeperHubUsdcBalance.toString()}`);
    } catch (error) {
      console.log(`USDC: Unable to check balance`);
    }
    
    try {
      keeperHubUsdtBalance = await publicClient.readContract({
        address: USDT_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [keeperHubWallet],
      });
      console.log(`USDT: ${keeperHubUsdtBalance.toString()}`);
    } catch (error) {
      console.log(`USDT: Unable to check balance`);
    }
    
    console.log("\n✅ Fund transfer complete!");
    console.log("Next step: Create Aave position via KeeperHub execute_protocol_action");

  } catch (error) {
    console.error("\n❌ Transfer failed:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
