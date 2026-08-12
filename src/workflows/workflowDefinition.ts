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
  healthData:
    | { totalCollateralBase: string; totalDebtBase: string; currentLiquidationThreshold: string; healthFactor: string }
    | { result: { totalCollateralBase: string; totalDebtBase: string; currentLiquidationThreshold: string; healthFactor: string } },
  targetHealthFactor: number
): string {
  const data = "result" in healthData ? healthData.result : healthData;

  const collateral = Number(data.totalCollateralBase);
  const debt = Number(data.totalDebtBase);
  const liqThreshold = Number(data.currentLiquidationThreshold) / 10000; // e.g. 8600 -> 0.86

  const currentHealthFactor = Number(data.healthFactor) / 1e18;
  if (currentHealthFactor >= targetHealthFactor) return "0";

  // Repay a little past the line, not exactly to it, so the next interest
  // accrual tick doesn't immediately push it back under threshold.
  const BUFFER = 1.05; // land 5% above target
  const effectiveTarget = targetHealthFactor * BUFFER;

  const maxSafeDebtBase = (collateral * liqThreshold) / effectiveTarget;
  const debtToRepayBase = debt - maxSafeDebtBase;

  if (debtToRepayBase <= 0) return "0";

  // totalDebtBase/totalCollateralBase are Aave's 8-decimal base-currency
  // (oracle USD value) units, not the debt token's own decimals. This
  // assumes the debt asset (USDT) is ~1:1 pegged to that base currency.
  const BASE_CURRENCY_DECIMALS = 8;
  const DEBT_TOKEN_DECIMALS = 6; // USDT
  const decimalAdjustment = 10 ** (DEBT_TOKEN_DECIMALS - BASE_CURRENCY_DECIMALS);

  let repayAmountTokenUnits = Math.ceil(debtToRepayBase * decimalAdjustment);

  // Never try to repay more than the outstanding debt.
  const totalDebtTokenUnitsApprox = Math.ceil(debt * decimalAdjustment);
  repayAmountTokenUnits = Math.min(repayAmountTokenUnits, totalDebtTokenUnitsApprox);

  return repayAmountTokenUnits.toString();
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
          asset: "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a", // Base Sepolia Aave V3 USDT underlying (verified against aave-address-book)
          amount: "0", // placeholder — actual amount is computed by calculateRepayAmount() in runGuardian.ts at run time; this static node value isn't used by the live guardian:once/watch path
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
