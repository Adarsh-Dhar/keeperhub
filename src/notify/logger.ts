import { config } from "../config.js";

/**
 * The primary alert path is the Discord action wired directly into the
 * KeeperHub workflow (see workflowDefinition.ts) — that's what fires
 * on-chain, inside KeeperHub's own retry/audit-trail machinery.
 *
 * This function is a secondary, agent-side notification: it posts the
 * *agent's own reasoning summary* (not just the workflow's raw output),
 * which is useful for demoing what Claude decided and why. Safe to skip
 * entirely if DISCORD_WEBHOOK_URL is unset.
 */
export async function notifyLocal(message: string): Promise<void> {
  if (!config.notify.discordWebhookUrl) {
    console.log("[notify] DISCORD_WEBHOOK_URL not set — skipping local alert.");
    return;
  }

  const response = await fetch(config.notify.discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message.slice(0, 1900) }),
  });

  if (!response.ok) {
    console.warn(`[notify] Discord webhook returned ${response.status}`);
  }
}
