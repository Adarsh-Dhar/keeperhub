# Position Guardian — Aave V3, built on KeeperHub

An autonomous agent that watches an Aave V3 lending position's health factor,
decides when it's at risk, and repays debt through KeeperHub's execution layer
— then lists itself on KeeperHub's marketplace so other agents can pay a few
cents per call via x402 instead of running their own copy.

Built for the KeeperHub hackathon. Gemini (via the Google AI API) is the
reasoning agent; every on-chain read and write goes through KeeperHub's MCP
server — nothing here talks to an RPC node directly.

## How it fits together

```
runGuardian.ts
  └─ connects to KeeperHub's MCP server (mcp/keeperhubClient.ts)
  └─ hands the full KeeperHub tool list to Gemini (agent/geminiAgent.ts)
  └─ Gemini decides: trigger the workflow, read the health factor,
     repay if needed, confirm via status polling
  └─ logs a full transcript (the audit trail) + posts a summary to Discord

workflows/
  workflowDefinition.ts     the actual KeeperHub node/edge graph
  setupGuardianWorkflow.ts  one-time script: validate + create it (disabled)

marketplace/
  listWorkflow.ts   publishes the workflow with a per-call USDC price
  consumerPay.ts    a second wallet discovers + pays to call it via x402
```

## Prerequisites

- Node.js 18.17+
- A KeeperHub account and organization API key (`kh_...`) — Settings > API Keys
- A Google AI Studio API key
- A funded Ethereum Sepolia wallet with an open Aave V3 position (some
  collateral supplied, some debt borrowed) — this is your test fixture
- (Stretch) a second, throwaway Base Sepolia wallet with a little test USDC,
  for the marketplace payment demo

## Setup

```bash
npm install
cp .env.example .env
# fill in KEEPERHUB_API_KEY, GEMINI_API_KEY, GUARDIAN_WALLET_ADDRESS
```

Verify the KeeperHub key works before building anything on top of it:

```bash
curl -sf -H "Authorization: Bearer $KEEPERHUB_API_KEY" https://app.keeperhub.com/api/keys
```

## Day 1 — create and validate the workflow

```bash
npm run setup:workflow
```

This calls `search_protocol_actions` for `aave-v3` first and prints the real
action schema. **Check the printed field names against
`src/workflows/workflowDefinition.ts` before continuing** — protocol action
slugs and required fields are the one thing in this repo you should not trust
blindly, since they're defined server-side and can differ from the skeleton
here. Adjust `workflowDefinition.ts`, re-run, and it validates + creates the
workflow disabled. Enable it from the KeeperHub dashboard once you're happy
with it, or via `update_workflow` with `enabled: true`.

Confirm it manually:

```bash
npm run guardian:once
```

You should see a transcript of Gemini listing the workflow, executing it, and
reporting the current health factor. Nothing gets written on-chain yet if the
position is healthy.

## Day 2 — force a real intervention and watch it end-to-end

1. Push the test position's health factor below your `HEALTH_FACTOR_THRESHOLD`
   (borrow a bit more, or lower the threshold temporarily).
2. Run `npm run guardian:once` again and watch the transcript: it should read
   the at-risk health factor, simulate the repay, execute it, poll for
   completion, and report a real Sepolia transaction hash.
3. Check the Discord channel wired into the workflow's `notify-discord` node
   for the alert — this is your primary demo clip.
4. For continuous monitoring instead of one-shot: `npm run guardian:watch`.

## Day 3 — marketplace / x402 loop

```bash
GUARDIAN_WORKFLOW_ID=<id from setup output> npm run marketplace:list
npm run marketplace:pay
```

`consumerPay.ts` is written to work two ways — read the comment at the top of
that file before running it. The officially supported path is installing
KeeperHub's `@keeperhub/wallet` skill inside your AI editor and just asking it to
call the workflow; the DIY `x402-fetch` path in this file is a fallback that
needs its target URL confirmed against KeeperHub's live marketplace API at
hack time.

## Safety notes

- Every write goes through KeeperHub's `simulate: true` preflight before a
  real broadcast — this repo never signs and sends in one step.
- `runAgent` caps itself at `MAX_TURNS` so a confused model can't loop
  indefinitely against a wallet with real value.
- The workflow is created **disabled**; you enable it deliberately after
  reviewing it.
- Use testnets (Sepolia / Base Sepolia) throughout. Do not point
  `GUARDIAN_WALLET_ADDRESS` at a mainnet position while iterating.

## What's a skeleton vs. what's load-bearing

- `mcp/keeperhubClient.ts` and `agent/geminiAgent.ts` are the real,
  reusable core — the tool-use loop against KeeperHub's MCP server. This
  doesn't change if you swap Aave for a different protocol.
- `workflows/workflowDefinition.ts` is protocol-specific and is the piece
  you'll iterate on most during Day 1 once you see the real
  `search_protocol_actions` output.
- `marketplace/consumerPay.ts` is the least certain piece (see its header
  comment) — treat it as a starting point, not a guarantee.
# keeperhub
