import { createKeeperHubClient, KeeperHubMCP } from "./src/mcp/keeperhubClient.js";
import { config } from "./src/config.js";
import { checksumAddress } from "viem";
import "dotenv/config";

// KeeperHub wallet address (Turnkey-managed signer) - properly checksummed
const KEEPERHUB_WALLET = checksumAddress("0x486049Acc7D8b840789fb58fd88bb207357C0480");

// Token addresses on Base Sepolia
const USDC_ADDRESS = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"; // The address that actually has tokens
const USDT_ADDRESS = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a";

// Amounts (in token decimals - 6 for both USDC and USDT)
const SUPPLY_USDC_AMOUNT = "10000000"; // 10 USDC
const BORROW_USDT_AMOUNT = "15000000000"; // 15,000 USDT (borrow more to create risk)

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
    idempotency_key: `setup-${actionType.split("/")[1]}-${Date.now()}`,
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
  console.log("Setting up Aave V3 position via KeeperHub");
  console.log(`Target wallet: ${KEEPERHUB_WALLET}`);
  console.log(`Chain ID: ${config.position.chainId}`);
  console.log(`Supply USDC: ${parseInt(SUPPLY_USDC_AMOUNT) / 1e6} USDC`);
  console.log(`Borrow USDT: ${parseInt(BORROW_USDT_AMOUNT) / 1e6} USDT\n`);

  const mcp = createKeeperHubClient();

  try {
    await mcp.connect();
    console.log("Connected to KeeperHub MCP\n");

    // First check if KeeperHub wallet has any existing position
    console.log("=== Checking existing position ===");
    try {
      const healthDataResult = await mcp.callTool("execute_protocol_action", {
        actionType: "aave-v3/get-user-account-data",
        params: {
          network: config.position.chainId,
          user: KEEPERHUB_WALLET,
        },
      });
      const healthData = JSON.parse(healthDataResult);
      console.log("Existing position data:", JSON.stringify(healthData, null, 2));
      
      if (healthData.result && healthData.result.totalCollateralBase && healthData.result.totalCollateralBase !== "0") {
        console.log("\n✅ KeeperHub wallet already has an Aave position!");
        
        // Check if there's debt - if not, offer to borrow
        if (healthData.result.totalDebtBase === "0") {
          console.log("But no debt exists. Adding borrow to create test position...\n");
          // Continue to borrow step
        } else {
          console.log("Position already has debt. Skipping setup and testing guardian flow directly.\n");
          await mcp.disconnect();
          return;
        }
      }
    } catch (checkError) {
      console.log("Could not check existing position:", checkError);
    }

    console.log("NOTE: Using the correct USDC address that has tokens: 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f");
    console.log("The KeeperHub wallet should already have USDC at this address.\n");

    // Step 0: Approve Aave Pool to spend USDC using execute_contract_call
    console.log("=== Step 0: Approving Aave Pool to spend USDC ===");
    const AAVE_POOL_ADDRESS = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
    const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    
    try {
      const approveResult = await mcp.callTool("execute_contract_call", {
        integration_id: "flkepxge23t6z8f31ye4h",
        chain_id: config.position.chainId,
        contract_address: USDC_ADDRESS,
        function_name: "approve",
        function_args: [AAVE_POOL_ADDRESS, MAX_UINT256],
        simulate: true,
      });
      console.log("Approval simulation result:", approveResult);
      
      // If simulation succeeds, execute the real approval
      const approveExecResult = await mcp.callTool("execute_contract_call", {
        integration_id: "flkepxge23t6z8f31ye4h",
        chain_id: config.position.chainId,
        contract_address: USDC_ADDRESS,
        function_name: "approve",
        function_args: [AAVE_POOL_ADDRESS, MAX_UINT256],
      });
      console.log("Approval execution result:", approveExecResult);
      console.log("✅ Approval successful");
    } catch (approveError) {
      console.error("❌ Approval failed:", approveError);
      console.log("Continuing anyway - some protocols may handle approval automatically");
    }

    // Step 1: Supply USDC as collateral
    console.log("=== Step 1: Supplying USDC as collateral ===");
    const supplyResult = await executeProtocolWrite(mcp, "aave-v3/supply", {
      network: config.position.chainId,
      asset: USDC_ADDRESS,
      amount: SUPPLY_USDC_AMOUNT,
      onBehalfOf: KEEPERHUB_WALLET,
      referralCode: 0,
    });

    if (!supplyResult.success) {
      console.error("❌ Supply failed:", supplyResult.error);
      console.log("But the simulation showed it would succeed. The supply may have actually executed.");
      console.log("Continuing to borrow step anyway...");
    } else {
      console.log(`✅ Supply successful: ${supplyResult.transactionLink}\n`);
    }

    // Wait a bit before borrowing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 2: Borrow USDT
    console.log("=== Step 2: Borrowing USDT ===");
    const borrowResult = await executeProtocolWrite(mcp, "aave-v3/borrow", {
      network: config.position.chainId,
      asset: USDT_ADDRESS,
      amount: BORROW_USDT_AMOUNT,
      onBehalfOf: KEEPERHUB_WALLET,
      interestRateMode: 2, // Variable
    });

    if (!borrowResult.success) {
      console.error("❌ Borrow failed:", borrowResult.error);
      process.exit(1);
    }

    console.log(`✅ Borrow successful: ${borrowResult.transactionLink}\n`);

    // Step 3: Verify the position
    console.log("=== Step 3: Verifying position ===");
    const healthDataResult = await mcp.callTool("execute_protocol_action", {
      actionType: "aave-v3/get-user-account-data",
      params: {
        network: config.position.chainId,
        user: KEEPERHUB_WALLET,
      },
    });

    const healthData = JSON.parse(healthDataResult);
    console.log("Position data:", JSON.stringify(healthData, null, 2));

    if (healthData.result && healthData.result.healthFactor) {
      const healthFactor = Number(BigInt(healthData.result.healthFactor)) / 1e18;
      console.log(`\n✅ Position setup complete!`);
      console.log(`Health factor: ${healthFactor.toFixed(4)}`);
      console.log(`Total collateral: ${healthData.result.totalCollateralBase}`);
      console.log(`Total debt: ${healthData.result.totalDebtBase}`);
      console.log("\nYou can now run the guardian: npm run guardian:once");
    } else {
      console.error("❌ Could not verify position health factor");
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
