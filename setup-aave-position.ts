import { exec } from "node:child_process";
import { promisify } from "node:util";
import "dotenv/config";

const execAsync = promisify(exec);

async function runCommand(command: string, description: string): Promise<void> {
  console.log(`\n${description}...`);
  console.log(`Command: ${command}`);
  try {
    const { stdout, stderr } = await execAsync(command);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.log("✓ Success");
  } catch (error) {
    console.error(`✗ Failed: ${error}`);
    throw error;
  }
}

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL || "https://sepolia.base.org";
  const privateKey = process.env.PRIVATE_KEY;
  
  if (!privateKey) {
    throw new Error("PRIVATE_KEY not set in environment");
  }

  // Derive wallet address from private key
  const { stdout: walletAddress } = await execAsync(
    `cast wallet address --private-key ${privateKey}`
  );
  const wallet = walletAddress.trim();

  // Aave V3 Base Sepolia contracts
  const pool = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
  const faucet = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D";
  const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const usdt = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a";

  // Amounts
  const mintUsdcAmount = process.env.MINT_USDC_AMOUNT || "100000000"; // 100 USDC
  const supplyUsdcAmount = process.env.SUPPLY_USDC_AMOUNT || "9985000000"; // 9,985 USDC (user's balance)
  const borrowUsdtAmount = process.env.BORROW_USDT_AMOUNT || "5000000000"; // 5,000 USDT (user's balance)

  console.log("Setting up Aave V3 position on Base Sepolia");
  console.log(`Wallet: ${wallet}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log("\n⚠️  Make sure your wallet has USDC before continuing!");
  console.log("Get USDC from Aave's Faucet tab: https://app.aave.com/faucet");

  try {
    // Step 1: Check USDC balance (assumes wallet is already funded)
    await runCommand(
      `cast call ${usdc} "balanceOf(address)(uint256)" ${wallet} --rpc-url ${rpcUrl}`,
      "Step 1: Checking USDC balance (ensure wallet has USDC)"
    );

    // Step 2: Approve Pool to spend USDC
    await runCommand(
      `cast send ${usdc} "approve(address,uint256)" ${pool} ${supplyUsdcAmount} --rpc-url ${rpcUrl} --private-key ${privateKey}`,
      "Step 2: Approving Pool to spend USDC"
    );

    // Step 3: Supply USDC as collateral
    await runCommand(
      `cast send ${pool} "supply(address,uint256,address,uint16)" ${usdc} ${supplyUsdcAmount} ${wallet} 0 --rpc-url ${rpcUrl} --private-key ${privateKey}`,
      "Step 3: Supplying USDC as collateral"
    );

    // Step 4: Borrow USDT
    await runCommand(
      `cast send ${pool} "borrow(address,uint256,uint256,uint16,address)" ${usdt} ${borrowUsdtAmount} 2 0 ${wallet} --rpc-url ${rpcUrl} --private-key ${privateKey}`,
      "Step 4: Borrowing USDT"
    );

    // Step 5: Check health factor
    await runCommand(
      `cast call ${pool} "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)" ${wallet} --rpc-url ${rpcUrl}`,
      "Step 5: Checking health factor"
    );

    console.log("\n✅ Aave position setup complete!");
    console.log("Your wallet now has collateral and debt.");
    console.log("You can now run the guardian: npm run guardian:once");

  } catch (error) {
    console.error("\n❌ Setup failed. Please ensure:");
    console.error("1. Your wallet has USDC (get from Aave's Faucet tab on app.aave.com)");
    console.error("2. Your wallet has ETH (Base Sepolia) for gas fees");
    console.error("3. The RPC URL is accessible");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
