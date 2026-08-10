import { config } from "../config.js";

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
          userAddress: config.position.walletAddress,
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
          onBehalfOf: config.position.walletAddress,
          // amount left as "max available in wallet" at creation time; refine
          // via search_protocol_actions once the exact field name is confirmed
          amount: "auto",
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
          message:
            "Position Guardian: health factor dropped below " +
            String(config.position.healthFactorThreshold) +
            " for {{@trigger-schedule}}. Repay executed: {{@repay-debt.transactionLink}}",
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
