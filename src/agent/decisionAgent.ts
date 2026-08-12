import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

const genai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

export interface DecisionContext {
  healthFactor: number;
  threshold: number;
  totalCollateralBase: string;
  totalDebtBase: string;
  liquidationThresholdPct: number; // e.g. 86 for 8600 bps
  debtAssetBalance: string; // USDT, human units
  collateralAssetBalance: string; // USDC, human units
  requiredRepayAmount: string; // USDT, human units
  requiredSupplyAmount: string; // USDC, human units
}

export interface Decision {
  action: "repay" | "supply";
  reasoning: string;
  raw: string;
}

const PROMPT_TEMPLATE = (ctx: DecisionContext) => `You are deciding how to protect an Aave V3 lending
position from liquidation on Base Sepolia. Both of the following actions are
affordable right now — the wallet holds enough of each asset. Choose exactly
one.

Position data:
- Health factor: ${ctx.healthFactor.toFixed(4)} (threshold: ${ctx.threshold})
- Total collateral: ${ctx.totalCollateralBase} (base currency units)
- Total debt: ${ctx.totalDebtBase} (base currency units)
- Liquidation threshold: ${ctx.liquidationThresholdPct}%

Option A — Repay debt:
- Wallet USDT balance: ${ctx.debtAssetBalance}
- Amount required to repay: ${ctx.requiredRepayAmount} USDT
- Effect: permanently reduces outstanding debt and the interest accruing on it.

Option B — Supply more collateral:
- Wallet USDC balance: ${ctx.collateralAssetBalance}
- Amount required to supply: ${ctx.requiredSupplyAmount} USDC
- Effect: raises the safety buffer immediately without touching debt, but
  debt keeps accruing interest and could erode the buffer again later. It
  also spends down the USDC reserve, which may be needed for a future event.

Weigh which option leaves the position better protected going forward, not
just which is numerically smaller right now. Consider: does this fix the
underlying problem (debt load) or just buy time? Which leaves more reserve
capacity (of either asset) available for the next at-risk event?

Respond in exactly this format, nothing else:
ACTION: <repay|supply>
REASONING: <2-4 sentences explaining the tradeoff and why you picked this one>`;

/**
 * Makes exactly one plain completion call — no tool access, no function
 * calling. The model cannot call any KeeperHub tool and cannot invent a
 * dollar amount that gets executed; it only picks between two amounts that
 * were already computed deterministically before this function was called.
 */
export async function decideRepayVsSupply(ctx: DecisionContext): Promise<Decision> {
  try {
    const response = await genai.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: "user", parts: [{ text: PROMPT_TEMPLATE(ctx) }] }],
      config: {
        maxOutputTokens: 512,
        temperature: 0.3, // low — this is a judgment call, not creative writing
      },
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("").trim();

    const actionMatch = text.match(/ACTION:\s*(repay|supply)/i);
    const reasoningMatch = text.match(/REASONING:\s*([\s\S]*)/i);

    if (!actionMatch) {
      // Fail safe to the more conservative, debt-reducing default rather
      // than guessing or throwing — a parse failure should never block the
      // guardian from acting.
      return {
        action: "repay",
        reasoning: `Could not parse a decision from the model's response — defaulting to repay (debt-reducing, more conservative). Raw response: ${text || "(empty)"}`,
        raw: text,
      };
    }

    return {
      action: actionMatch[1].toLowerCase() as "repay" | "supply",
      reasoning: reasoningMatch ? reasoningMatch[1].trim() : "(no reasoning provided)",
      raw: text,
    };
  } catch (error) {
    return {
      action: "repay",
      reasoning: `Decision call failed (${error instanceof Error ? error.message : String(error)}) — defaulting to repay (debt-reducing, more conservative).`,
      raw: "",
    };
  }
}
