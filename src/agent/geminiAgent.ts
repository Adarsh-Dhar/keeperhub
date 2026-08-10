import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { KeeperHubMCP, GeminiTool } from "../mcp/keeperhubClient.js";

export interface AgentStep {
  type: "thought" | "tool_call" | "tool_result" | "final";
  text: string;
}

export interface AgentRunResult {
  transcript: AgentStep[];
  finalText: string;
}

const genai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const MAX_TURNS = 8; // hard stop so a confused agent can't loop forever against real funds

/**
 * Runs Gemini in a function-calling loop against every tool KeeperHub's MCP server
 * exposes. Gemini decides which tools to call and in what order; this
 * function just relays calls and results and stops when Gemini emits a
 * final text-only reply (no more functionCall parts) or MAX_TURNS is hit.
 */
export async function runAgent(
  systemPrompt: string,
  userPrompt: string,
  mcp: KeeperHubMCP,
  tools: GeminiTool[]
): Promise<AgentRunResult> {
  const transcript: AgentStep[] = [];
  
  // Convert tools to Gemini's FunctionDeclaration format
  const functionDeclarations = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  }));

  // Gemini uses 'contents' array with 'role' and 'parts'
  const contents: Array<{ role: string; parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> }> = [
    { role: "user", parts: [{ text: userPrompt }] }
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await genai.models.generateContent({
      model: config.gemini.model,
      contents: contents,
      config: {
        systemInstruction: systemPrompt,
        generationConfig: {
          maxOutputTokens: 2048,
        },
        tools: [{ functionDeclarations }],
      },
    });

    const responseText = response.response.text();
    const functionCalls = response.functionCalls();

    // Log the assistant's text response
    if (responseText.trim()) {
      transcript.push({ type: "thought", text: responseText });
    }

    // No function calls left => Gemini is done reasoning/acting.
    if (!functionCalls || functionCalls.length === 0) {
      const finalText = responseText.trim();
      transcript.push({ type: "final", text: finalText });
      return { transcript, finalText };
    }

    // Add the assistant's response to the conversation
    contents.push({ role: "model", parts: response.response.candidates[0].content.parts });

    // Process each function call
    for (const call of functionCalls) {
      transcript.push({
        type: "tool_call",
        text: `${call.name}(${JSON.stringify(call.args)})`,
      });

      let resultText: string;
      try {
        resultText = await mcp.callTool(call.name, call.args);
      } catch (err) {
        resultText = `ERROR: ${(err as Error).message}`;
      }

      transcript.push({ type: "tool_result", text: resultText });
    }

    // Add function responses as a new user message
    const functionResponses = functionCalls.map((call, index) => {
      const resultText = transcript.filter(s => s.type === "tool_result")[index]?.text || "(empty)";
      return {
        functionResponse: {
          name: call.name,
          response: { result: resultText },
        },
      };
    });

    contents.push({ role: "user", parts: functionResponses });
  }

  const timeoutMsg = "Agent hit MAX_TURNS without reaching a final answer — stopping for safety.";
  transcript.push({ type: "final", text: timeoutMsg });
  return { transcript, finalText: timeoutMsg };
}
