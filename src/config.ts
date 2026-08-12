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
    // Base Sepolia Aave V3 USDT underlying — the debt asset for this position
    debtAsset: optional("DEBT_ASSET_ADDRESS", "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a"),
    // Base Sepolia USDC — the collateral asset supplied by setup-aave-position
    collateralAsset: optional("USDC", "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f"),
  },
  rpc: {
    url: optional("RPC_URL", "https://sepolia.base.org"),
  },
  notify: {
    discordWebhookUrl: optional("DISCORD_WEBHOOK_URL"),
  },
  marketplace: {
    payerPrivateKey: optional("X402_PAYER_PRIVATE_KEY"),
    workflowSlug: optional("GUARDIAN_WORKFLOW_SLUG", "position-guardian-aave-v3"),
  },
} as const;
