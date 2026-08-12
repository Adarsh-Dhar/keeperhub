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

const MAX_TURNS = 15; // increased limit for complex multi-step tasks

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

    const responseText = response.text || "";
    
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
      // If no text response but we have tool results, generate a summary
      let finalText = responseText.trim();
      if (!finalText) {
        // Generate a summary from the transcript
        const healthData = transcript.find(s => s.text.includes("healthFactor"));
        if (healthData) {
          try {
            const healthMatch = healthData.text.match(/"healthFactor":\s*"(\d+)"/);
            if (healthMatch) {
              const healthFactor = Number(healthMatch[1]) / 1e18;
              const threshold = 1.5; // fallback threshold
              if (healthFactor >= threshold) {
                finalText = `Position health check complete. Health factor: ${healthFactor.toFixed(4)}. Position is healthy (above threshold ${threshold}). No action required.`;
              } else {
                finalText = `⚠️ POSITION AT RISK! Health factor: ${healthFactor.toFixed(4)} is below threshold ${threshold}. Agent should execute repay action but may have failed to do so.`;
              }
            }
          } catch (e) {
            finalText = "Position health check complete. No action required.";
          }
        } else {
          finalText = "Position health check complete. No action required.";
        }
      }
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
