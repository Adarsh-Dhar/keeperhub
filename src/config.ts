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
    chainId: optional("CHAIN_ID", "1"), // Default to Ethereum mainnet (supported by Aave V3)
    walletAddress: required("GUARDIAN_WALLET_ADDRESS"),
    healthFactorThreshold: Number(optional("HEALTH_FACTOR_THRESHOLD", "1.5")),
  },
  notify: {
    discordWebhookUrl: optional("DISCORD_WEBHOOK_URL"),
  },
  marketplace: {
    payerPrivateKey: optional("X402_PAYER_PRIVATE_KEY"),
    workflowSlug: optional("GUARDIAN_WORKFLOW_SLUG", "position-guardian-aave-v3"),
  },
} as const;
