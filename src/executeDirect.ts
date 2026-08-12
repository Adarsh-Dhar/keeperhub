import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { config } from './config.js';

// NOTE: Aave V3 Pool.repay's real on-chain order is
//   repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
// interestRateMode comes BEFORE onBehalfOf. The previous version of this ABI had
// onBehalfOf/interestRateMode swapped, which caused viem to encode the wallet
// address into the interestRateMode slot (and "2" into the onBehalfOf slot) —
// that's the "repay reverted" error. Fixed below.
const AAVE_POOL_ABI = [
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" }
    ],
    name: "repay",
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function"
  }
];

const ERC20_ABI = [
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    name: "allowance",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function"
  }
];

const AAVE_POOL_ADDRESS = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as `0x${string}`;
const DEBT_ASSET_ADDRESS = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a" as `0x${string}`; // Base Sepolia Aave V3 USDT underlying (verified against aave-address-book)

export async function executeDirectRepay(
  amount: string,
  onBehalfOf: string,
  interestRateMode: string
): Promise<{ success: boolean; transactionHash?: string; error?: string }> {
  const privateKey = process.env.PRIVATE_KEY;
  
  if (!privateKey) {
    return {
      success: false,
      error: "PRIVATE_KEY not set in environment"
    };
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  
  const client = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });

  try {
    console.log(`Executing repay from wallet: ${account.address}`);
    console.log(`Asset: ${DEBT_ASSET_ADDRESS}`);
    console.log(`Amount: ${amount}`);
    console.log(`On behalf of: ${onBehalfOf}`);
    console.log(`Interest rate mode: ${interestRateMode}`);

    const amountBig = BigInt(amount);

    // repay() pulls USDT from the wallet via transferFrom, so the Pool needs
    // an ERC20 allowance first. Check current allowance and top it up if needed.
    const currentAllowance = await publicClient.readContract({
      address: DEBT_ASSET_ADDRESS,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, AAVE_POOL_ADDRESS],
    }) as bigint;

    if (currentAllowance < amountBig) {
      console.log(`Allowance (${currentAllowance}) is insufficient, approving Pool to spend USDT...`);
      const approveHash = await client.writeContract({
        address: DEBT_ASSET_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [AAVE_POOL_ADDRESS, amountBig],
      });
      console.log(`Approve tx sent: ${approveHash}`);
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("Approval confirmed.");
    }

    const hash = await client.writeContract({
      address: AAVE_POOL_ADDRESS,
      abi: AAVE_POOL_ABI,
      functionName: "repay",
      args: [
        DEBT_ASSET_ADDRESS,
        amountBig,
        BigInt(interestRateMode),
        onBehalfOf as `0x${string}` 
      ],
    });

    console.log(`Transaction sent: ${hash}`);
    console.log(`Explorer: https://sepolia.basescan.org/tx/${hash}`);

    return {
      success: true,
      transactionHash: hash
    };
  } catch (error) {
    console.error("Direct execution failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
