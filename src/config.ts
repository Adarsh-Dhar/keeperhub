import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required env var: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  keeperhub: {
    apiKey: required("KEEPERHUB_API_KEY"),
    mcpUrl: optional("KEEPERHUB_MCP_URL", "https://app.keeperhub.com/mcp"),
  },
  gemini: {
    apiKey: required("GEMINI_API_KEY"),
    model: optional("GEMINI_MODEL", "gemini-2.5-pro"),
  },
  position: {
    chainId: optional("CHAIN_ID", "84532"), // Default to Base Sepolia (safe testnet)
    walletAddress: required("GUARDIAN_WALLET_ADDRESS"),
    healthFactorThreshold: Number(optional("HEALTH_FACTOR_THRESHOLD", "1.5")),
    workflowId: optional("GUARDIAN_WORKFLOW_ID", ""),
  },
  assets: {
    // Debt asset address (what you borrowed) - required from .env
    debtAsset: required("DEBT_ASSET_ADDRESS"),
    // Collateral asset address (what you supplied) - required from .env
    collateralAsset: required("COLLATERAL_ASSET_ADDRESS"),
    // Actual ERC20 token addresses for wallet balance checks (these are the real tokens users hold)
    walletDebtAsset: optional("WALLET_DEBT_ASSET_ADDRESS", "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a"), // Base Sepolia USDT (Aave underlying)
    walletCollateralAsset: optional("WALLET_COLLATERAL_ASSET_ADDRESS", "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"), // Base Sepolia USDC (Aave underlying)
  },
  rpc: {
    url: optional("BASE_RPC_URL", "https://sepolia.base.org"),
  },
  contracts: {
    // Aave V3 Pool address - required from .env
    aavePool: required("AAVE_POOL_ADDRESS"),
  },
  notify: {
    discordWebhookUrl: optional("DISCORD_WEBHOOK_URL"),
  },
  marketplace: {
    payerPrivateKey: optional("X402_PAYER_PRIVATE_KEY"),
    workflowSlug: optional("GUARDIAN_WORKFLOW_SLUG", "position-guardian-aave-v3"),
  },
} as const;
