import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../config.js";

/**
 * Gemini's function declaration format. We convert every MCP tool KeeperHub
 * exposes into this shape once, at connect time, so the agent loop never has
 * to think about MCP directly.
 * 
 * Note: Gemini's JSON Schema support is a stricter subset than Anthropic's.
 * Some KeeperHub tool schemas may need sanitizing (stripping unsupported
 * keywords like certain `oneOf`/`additionalProperties` combos) before Gemini
 * will accept them as function declarations.
 */
export interface GeminiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class KeeperHubMCP {
  private client: Client;
  private connected = false;

  constructor(private readonly mcpUrl: string, private readonly apiKey: string) {
    this.client = new Client(
      { name: "position-guardian-agent", version: "0.1.0" },
      { capabilities: {} }
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  /** List every tool KeeperHub exposes, converted to Gemini's function declaration schema. */
  async listGeminiTools(): Promise<GeminiTool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      // MCP inputSchema is already JSON Schema — Gemini's parameters
      // expects the same shape, but with stricter validation.
      // We sanitize the schema to remove unsupported keywords.
      parameters: this.sanitizeSchema((t.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      }),
    }));
  }

  /**
   * Sanitize JSON Schema to be compatible with Gemini's stricter requirements.
   * Removes or transforms schema keywords that Gemini doesn't support.
   */
  private sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = { ...schema };
    
    // Remove unsupported keywords that Gemini may reject
    const unsupportedKeywords = [
      'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
      'patternProperties', 'additionalProperties', 'unevaluatedProperties',
      'minProperties', 'maxProperties', 'propertyNames', 'dependencies',
      'contains', 'pattern', 'minContains', 'maxContains'
    ];
    
    for (const keyword of unsupportedKeywords) {
      delete sanitized[keyword];
    }
    
    // Recursively sanitize nested objects (properties, items, etc.)
    if (sanitized.properties && typeof sanitized.properties === 'object') {
      for (const [key, value] of Object.entries(sanitized.properties)) {
        if (typeof value === 'object' && value !== null) {
          (sanitized.properties as Record<string, unknown>)[key] = this.sanitizeSchema(value as Record<string, unknown>);
        }
      }
    }
    
    if (sanitized.items && typeof sanitized.items === 'object') {
      sanitized.items = this.sanitizeSchema(sanitized.items as Record<string, unknown>);
    }
    
    return sanitized;
  }

  /** Call a single KeeperHub MCP tool by name and return its raw text content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args });
    } catch (err) {
      // one retry for transient network errors (e.g. "fetch failed")
      await new Promise((r) => setTimeout(r, 1000));
      result = await this.client.callTool({ name, arguments: args });
    }
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");

    if (result.isError) {
      throw new Error(`KeeperHub MCP tool "${name}" returned an error: ${text}`);
    }
    return text || "(empty response)";
  }
}

export function createKeeperHubClient(): KeeperHubMCP {
  return new KeeperHubMCP(config.keeperhub.mcpUrl, config.keeperhub.apiKey);
}
