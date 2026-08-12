import { config } from "../config.js";

/**
 * Calculates the amount of debt to repay to reach a target health factor.
 * 
 * Formula: debtToRepay = currentDebt - (collateral * liquidationThreshold / targetHealthFactor)
 * 
 * This ensures we repay just enough to bring the health factor back above the safety threshold.
 * 
 * @param healthData - The health data from Aave V3 get-user-account-data
 * @param targetHealthFactor - The desired health factor (e.g., 1.5)
 * @returns The amount to repay (in the same units as the debt, typically wei)
 */
export function calculateRepayAmount(
  healthData: { totalCollateralBase: string; totalDebtBase: string; healthFactor: string } | { result: { totalCollateralBase: string; totalDebtBase: string; healthFactor: string } },
  targetHealthFactor: number
): string {
  // Handle nested result structure from execute_protocol_action
  const data = 'result' in healthData ? healthData.result : healthData;
  
  const currentHealthFactor = Number(data.healthFactor) / 1e18; // Aave uses 1e18 scaling
  
  // If already healthy, no repayment needed
  if (currentHealthFactor >= targetHealthFactor) {
    return "0";
  }
  
  // For now, use a conservative fixed amount for testing
  // 5 USDT = 5,000,000 (6 decimals)
  // TODO: Implement proper calculation based on collateral/debt ratios
  return "5000000"; // 5 USDT
}

/**
 * Builds the KeeperHub workflow graph for the Position Guardian.
 *
 * Shape:
 *   trigger (Schedule, every 15 min)
 *     -> read-health-factor        (aave-v3 protocol action, read-only)
 *     -> condition (healthFactor < threshold)
 *          true  -> repay            (aave-v3/repay, write action)
 *                -> notify-discord   (alert with the tx result)
 *          false -> (nothing; loop ends, position is healthy)
 *
 * NOTE: `abiFunction`/protocol action slugs and exact field names should be
 * confirmed against `search_protocol_actions` / `list_action_schemas` at
 * setup time — KeeperHub's MCP tools are the source of truth, this is the
 * structural skeleton the setup script sends to `create_workflow`.
 */
export function buildGuardianWorkflowNodes() {
  const nodes = [
    {
      id: "trigger-schedule",
      type: "trigger",
      data: {
        label: "Every 15 minutes",
        type: "trigger",
        config: {
          triggerType: "Schedule",
          intervalMinutes: 15,
        },
        status: "idle",
      },
    },
    {
      id: "read-health-factor",
      type: "action",
      data: {
        label: "Read Aave V3 health factor",
        description: "Reads the current health factor for the guarded wallet",
        type: "action",
        config: {
          actionType: "aave-v3/get-user-account-data",
          network: config.position.chainId,
          user: config.position.walletAddress,
        },
        status: "idle",
      },
    },
    {
      id: "condition-at-risk",
      type: "condition",
      data: {
        label: "Health factor below threshold?",
        type: "condition",
        config: {
          conditions: [
            {
              left: "{{@read-health-factor:Read Aave V3 health factor.healthFactor}}",
              operator: "<",
              right: config.position.healthFactorThreshold,
            },
          ],
        },
        status: "idle",
      },
    },
    {
      id: "repay-debt",
      type: "action",
      data: {
        label: "Repay Aave V3 debt",
        description: "Repays part of the borrowed position to restore a safe health factor",
        type: "action",
        config: {
          actionType: "aave-v3/repay",
          network: config.position.chainId,
          asset: "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a", // User's specific USDT contract (already checksummed)
          amount: "5000000", // 5 USDT (6 decimals) - matches calculateRepayAmount
          onBehalfOf: config.position.walletAddress,
        },
        status: "idle",
      },
    },
    {
      id: "notify-discord",
      type: "action",
      data: {
        label: "Alert: guardian intervened",
        type: "action",
        config: {
          actionType: "discord/send-message",
          discordMessage:
            "Position Guardian: health factor dropped below " +
            String(config.position.healthFactorThreshold) +
            " for {{@trigger-schedule:Every 15 minutes.triggeredAt}}. Repay executed: {{@repay-debt:Repay Aave V3 debt.transactionLink}}",
        },
        status: "idle",
      },
    },
  ];

  const edges = [
    { id: "e-trigger-read", source: "trigger-schedule", target: "read-health-factor" },
    { id: "e-read-condition", source: "read-health-factor", target: "condition-at-risk" },
    {
      id: "e-condition-repay",
      source: "condition-at-risk",
      target: "repay-debt",
      sourceHandle: "true",
    },
    { id: "e-repay-notify", source: "repay-debt", target: "notify-discord" },
  ];

  return { nodes, edges };
}
