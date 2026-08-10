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
          temperature: 0.7,
        },
        tools: [{ functionDeclarations }],
      },
    });

    const responseText = response.response?.text?.() || "";
    
    // Extract function calls from the response
    const functionCalls: any[] = [];
    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.functionCall) {
        functionCalls.push(part.functionCall);
      }
    }

    // Log the assistant's text response
    if (responseText.trim()) {
      transcript.push({ type: "thought", text: responseText });
    }

    // No function calls left => Gemini is done reasoning/acting.
    if (functionCalls.length === 0) {
      const finalText = responseText.trim() || "No text response from model";
      transcript.push({ type: "final", text: finalText });
      return { transcript, finalText };
    }

    // Add the assistant's response to the conversation
    contents.push({ role: "model", parts: parts });

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

    // Add function responses as a new user message using text format
    const resultTexts = functionCalls.map((call, index) => {
      const resultText = transcript.filter(s => s.type === "tool_result")[index]?.text || "(empty)";
      return `Tool ${call.name} returned: ${resultText}`;
    }).join("\n\n");
    
    contents.push({ role: "user", parts: [{ text: resultTexts }] });
  }

  const timeoutMsg = "Agent hit MAX_TURNS without reaching a final answer — stopping for safety.";
  transcript.push({ type: "final", text: timeoutMsg });
  return { transcript, finalText: timeoutMsg };
}
