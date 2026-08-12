import { createKeeperHubClient, KeeperHubMCP } from "./src/mcp/keeperhubClient.js";
import { config } from "./src/config.js";
import { checksumAddress } from "viem";
import "dotenv/config";

// KeeperHub wallet address (Turnkey-managed signer) - properly checksummed
const KEEPERHUB_WALLET = checksumAddress("0x486049Acc7D8b840789fb58fd88bb207357C0480");

// Token addresses on Base Sepolia
const USDC_ADDRESS = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const USDT_ADDRESS = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a";
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // WETH on Base

// Amounts (in token decimals - 6 for both USDC and USDT, 18 for WETH)
const BORROW_WETH_AMOUNT = "1000000000000000"; // 0.001 WETH to create test risk

async function executeProtocolWrite(
  mcp: KeeperHubMCP,
  actionType: string,
  params: Record<string, unknown>
): Promise<{ success: boolean; transactionLink?: string; error?: string }> {
  console.log(`Simulating ${actionType} via KeeperHub...`);
  const simResultRaw = await mcp.callTool("execute_protocol_action", {
    actionType,
    params,
    simulate: true,
  });
  const simResult = JSON.parse(simResultRaw);
  console.log("Simulation result:", JSON.stringify(simResult, null, 2));

  // If simulation fails, return the actual error message
  if (simResult.success === false || simResult.wouldRevert) {
    return { success: false, error: `Simulation failed: ${simResultRaw}` };
  }

  // Simulation succeeded — proceed to real execution
  console.log(`Simulation passed. Executing real ${actionType} via KeeperHub...`);
  const execResultRaw = await mcp.callTool("execute_protocol_action", {
    actionType,
    params,
    idempotency_key: `borrow-${Date.now()}`,
  });
  const execResult = JSON.parse(execResultRaw);
  console.log("Execution submitted:", JSON.stringify(execResult, null, 2));

  // Handle sponsored transactions that execute immediately
  if (execResult.transactionHash && execResult.success === true) {
    console.log("✅ Transaction executed immediately (sponsored transaction)");
    const transactionLink = execResult.transactionLink || 
      (execResult.transactionHash ? `https://sepolia.basescan.org/tx/${execResult.transactionHash}` : undefined);
    return { success: true, transactionLink };
  }

  // Handle async executions that return executionId
  if (!execResult.executionId) {
    return { success: false, error: `Execution did not return an executionId: ${execResultRaw}` };
  }

  console.log("Polling for execution status...");
  let statusResult: any;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const statusRaw = await mcp.callTool("get_direct_execution_status", {
      executionId: execResult.executionId,
    });
    statusResult = JSON.parse(statusRaw);
    console.log(`Status check ${attempt + 1}:`, statusResult.status);
    if (statusResult.status === "completed" || statusResult.status === "failed") break;
  }

  if (!statusResult || statusResult.status !== "completed") {
    return { success: false, error: `Execution did not complete in time. Last status: ${JSON.stringify(statusResult)}` };
  }

  const transactionLink =
    statusResult.transactionLink ||
    (statusResult.transactionHash ? `https://sepolia.basescan.org/tx/${statusResult.transactionHash}` : undefined);

  return { success: true, transactionLink };
}

async function main() {
  console.log("Adding borrow to create test position");
  console.log(`Target wallet: ${KEEPERHUB_WALLET}`);
  console.log(`Chain ID: ${config.position.chainId}`);
  console.log(`Borrow WETH: ${parseInt(BORROW_WETH_AMOUNT) / 1e18} WETH\n`);

  const mcp = createKeeperHubClient();

  try {
    await mcp.connect();
    console.log("Connected to KeeperHub MCP\n");

    // Check current position
    console.log("=== Checking current position ===");
    const healthDataResult = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/get-user-account-data",
      params: {
        network: config.position.chainId,
        user: KEEPERHUB_WALLET,
      },
    });
    const healthData = JSON.parse(healthDataResult);
    console.log("Current position:", JSON.stringify(healthData, null, 2));

    if (healthData.result && healthData.result.totalDebtBase && healthData.result.totalDebtBase !== "0") {
      console.log("\n⚠️  Position already has debt. Skipping borrow to avoid over-leveraging.");
      await mcp.disconnect();
      return;
    }

    // Step 1: Borrow WETH to create risk
    console.log("\n=== Step 1: Borrowing WETH to create test risk ===");
    const borrowResult = await executeProtocolWrite(mcp, "aave-v3/borrow", {
      network: config.position.chainId,
      asset: WETH_ADDRESS,
      amount: BORROW_WETH_AMOUNT,
      onBehalfOf: KEEPERHUB_WALLET,
      interestRateMode: 2, // Variable
      referralCode: 0,
    });

    if (!borrowResult.success) {
      console.error("❌ Borrow failed:", borrowResult.error);
      await mcp.disconnect();
      process.exit(1);
    }

    console.log(`✅ Borrow successful: ${borrowResult.transactionLink}\n`);

    // Step 2: Verify the new position
    console.log("=== Step 2: Verifying new position ===");
    const newHealthDataResult = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/get-user-account-data",
      params: {
        network: config.position.chainId,
        user: KEEPERHUB_WALLET,
      },
    });
    const newHealthData = JSON.parse(newHealthDataResult);
    console.log("New position data:", JSON.stringify(newHealthData, null, 2));

    if (newHealthData.result && newHealthData.result.healthFactor) {
      const healthFactorRaw = newHealthData.result.healthFactor;
      const maxUint256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
      let healthFactor: number;
      
      if (healthFactorRaw === maxUint256) {
        healthFactor = Infinity;
      } else {
        healthFactor = Number(BigInt(healthFactorRaw)) / 1e18;
      }
      
      console.log(`\n✅ Borrow complete!`);
      console.log(`Health factor: ${healthFactor === Infinity ? "Infinity" : healthFactor.toFixed(4)}`);
      console.log(`Total debt: ${newHealthData.result.totalDebtBase}`);
      console.log(`Total collateral: ${newHealthData.result.totalCollateralBase}`);
      console.log("\nYou can now test the guardian: npm run guardian:once");
      console.log("The guardian should detect the position and potentially take action if health factor is low.");
    } else {
      console.error("❌ Could not verify position health factor");
      await mcp.disconnect();
      process.exit(1);
    }

    await mcp.disconnect();

  } catch (error) {
    console.error("\n❌ Setup failed:", error);
    await mcp.disconnect();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
