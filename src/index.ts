import "dotenv/config";
import fs from "fs";
import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { fetch as undiciFetch } from "undici";

if (typeof globalThis.fetch !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = undiciFetch;
}

/**
 * Minimal, strict-JSON podcast script agent.
 * - Feed a single cleaned article string.
 * - Model outputs ONLY the final JSON shape, enforced by Structured Outputs.
 * - No envelope parsing / headings / paragraphs logic.
 */

interface ResolvedMessage {
  id: string;
  threadName: string;
  threadId: string;
  senderId: string;
  content: string; // should contain the cleaned article text
  timestamp: number;
  mentions: string[];
}

interface ToolResult {
  result?: string;
  messages?: unknown;
  [key: string]: unknown;
}

interface FinalDialogueLine {
  text: string;
  voice_id: string;
}

interface FinalDialogueResponse {
  dialogue: FinalDialogueLine[];
}

function assertJsonSerializable(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  try {
    JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Generated output is not valid JSON: ${error.message}`
        : "Generated output is not valid JSON.",
    );
  }
  return serialized;
}

function buildErrorResponse(message: string, details?: string): string {
  const payload: { error: { message: string; details?: string } } = {
    error: { message },
  };

  if (details !== undefined) {
    payload.error.details = details;
  }

  return assertJsonSerializable(payload);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const HOST_VOICE_ID = process.env.PODCAST_HOST_VOICE_ID?.trim() || "gmnazjXOFoOcWA59sd5m";
const GUEST_VOICE_ID = process.env.PODCAST_GUEST_VOICE_ID?.trim() || "1kNciG1jHVSuFBPoxdRZ";
const MAX_SCRIPT_CHARACTERS = 2400;

// ——— System prompt: enforces role↔voice mapping and JSON-only output ———
// Build without template literals to avoid accidental backticks or unterminated strings
const BASE_SYSTEM_PROMPT = [
  "Create a short podcast script from the given article content. Make it engaging and conversational, and keep combined dialogue under " + String(MAX_SCRIPT_CHARACTERS) + " characters.",
  "",
  "Rules:",
  "- Alternate lines between two speakers: host then guest, then host, etc.",
  "- For host lines, set \"voice_id\" to \"" + HOST_VOICE_ID + "\".",
  "- For guest lines, set \"voice_id\" to \"" + GUEST_VOICE_ID + "\".",
  "- Output ONLY JSON that matches this schema exactly: { \"dialogue\": [ { \"text\": \"…\", \"voice_id\": \"…\" } ] }",
  "- No markdown fences. No extra fields. No commentary.",
].join("\n");

const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "";
const SCRIPT_PROMPT_APPEND = process.env.SCRIPT_PROMPT_APPEND ?? "";
const CORAL_CONNECTION_URL = requireEnv("CORAL_CONNECTION_URL");
const CORAL_AGENT_ID = process.env.CORAL_AGENT_ID ?? "podcast_script";
const NORMALIZED_AGENT_ID = CORAL_AGENT_ID.replace(/^@/, "").toLowerCase();
const WAIT_TIMEOUT_MS = Number.parseInt(process.env.WAIT_TIMEOUT_MS ?? "600000", 10);
const LOG_PATH = path.resolve(process.cwd(), "podcast-script.log");

// ——— FINAL structured output schema (strict JSON) ———
const finalDialogueSchema = z.object({
  dialogue: z.array(
    z.object({
      text: z.string().min(1).transform((s) => s.trim()),
      voice_id: z.enum([HOST_VOICE_ID, GUEST_VOICE_ID] as [string, string]),
    })
  ).min(2, "Provide at least two turns in the dialogue."),
});

// ——— Logging helpers ———
function appendLog(event: string, payload?: unknown) {
  const timestamp = new Date().toISOString();
  const suffix =
    payload === undefined
      ? ""
      : ` ${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
  fs.appendFile(LOG_PATH, `[${timestamp}] ${event}${suffix}
`, () => {
    /* ignore logging errors */
  });
}

appendLog("Boot", {
  CORAL_AGENT_ID,
  CORAL_CONNECTION_URL,
  OPENAI_MODEL: OPENAI_MODEL || "<default>",
  WAIT_TIMEOUT_MS,
});

function normalizeMention(raw: string): string {
  return raw.trim().replace(/^@/, "").split(/[#:]/, 1)[0].toLowerCase();
}

function shouldRespond(message: ResolvedMessage): boolean {
  if (message.senderId === CORAL_AGENT_ID) {
    appendLog("Ignoring own message", { threadId: message.threadId, messageId: message.id });
    return false;
  }
  if (!message.mentions || message.mentions.length === 0) {
    appendLog("Message has no mentions", { threadId: message.threadId, messageId: message.id, senderId: message.senderId });
    return false;
  }
  const match = message.mentions.some((m) => normalizeMention(m) === NORMALIZED_AGENT_ID);
  if (!match) {
    appendLog("Mentions missing agent", { mentions: message.mentions, agentId: CORAL_AGENT_ID });
  }
  return match;
}

function parseToolResult(response: unknown): ToolResult | null {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      try { return JSON.parse(item.text) as ToolResult; } catch (error) {
        appendLog("Failed to parse tool result", { error: error instanceof Error ? error.message : String(error), text: item.text });
      }
    }
  }
  appendLog("Tool result missing text content", response);
  return null;
}

async function waitForMentions(client: Client): Promise<ResolvedMessage[]> {
  appendLog("wait_for_mentions:start", { timeoutMs: WAIT_TIMEOUT_MS });
  const response = await client.callTool({ name: "coral_wait_for_mentions", arguments: { timeoutMs: WAIT_TIMEOUT_MS } });
  const parsed = parseToolResult(response);
  if (!parsed) return [];
  if (parsed.result === "error_timeout") return [];
  if (parsed.result === "wait_for_mentions_success" && Array.isArray(parsed.messages)) {
    const messages = parsed.messages as ResolvedMessage[];
    appendLog("wait_for_mentions:success", { count: messages.length });
    return messages;
  }
  appendLog("wait_for_mentions:unexpected_result", parsed);
  return [];
}

async function sendMessage(client: Client, threadId: string, message: string, mentions: string[]): Promise<void> {
  const response = await client.callTool({ name: "coral_send_message", arguments: { threadId, content: message, mentions } });
  const parsed = parseToolResult(response);
  if (!parsed || parsed.result !== "send_message_success") {
    appendLog("send_message:unexpected_result", parsed ?? response);
    return;
  }
  appendLog("send_message:success", { threadId, mentions });
}

// ——— Minimal context builder: just accept cleaned string and (optionally) clip ———
function extractArticleContext(raw: string): { success: true; context: string } | { success: false; error: string } {
  const text = raw?.trim();
  if (!text) return { success: false, error: "Empty article content." };
  const max = 3500; // soft cap to keep prompt lean
  const clipped = text.length > max ? text.slice(0, max) : text;
  return {
    success: true, context: `Article Content:

${clipped}`
  };
}

async function generatePodcastScript(message: ResolvedMessage, articleContext: string): Promise<FinalDialogueResponse> {
  const userPrompt = [
    `Thread: ${message.threadName}`,
    `Requested by: ${message.senderId}`,
    "Article Overview:",
    articleContext,
  ].join("\n\n");

  let extraInstruction = "";
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const instructions = [
      BASE_SYSTEM_PROMPT,
      `Ensure the combined character count across all "text" values stays comfortably below ${MAX_SCRIPT_CHARACTERS}.`,
      SCRIPT_PROMPT_APPEND.trim(),
      extraInstruction ? `Adjustment request: ${extraInstruction}` : "",
    ].filter(Boolean).join("\n\n");

    const agent = new Agent({
      name: "Podcast Script Agent",
      instructions,
      outputType: finalDialogueSchema, // ← Structured Outputs (strict JSON)
      ...(OPENAI_MODEL ? { model: OPENAI_MODEL } : {}),
    });

    try {
      const result = await run(agent, userPrompt);
      const final = result.finalOutput as z.infer<typeof finalDialogueSchema>;

      // Enforce character budget (sum of text lengths)
      const totalChars = final.dialogue.reduce((n, d) => n + d.text.length, 0);
      if (totalChars > MAX_SCRIPT_CHARACTERS) {
        extraInstruction = `Your last script used ${totalChars} characters. Shorten total "text" to under ${MAX_SCRIPT_CHARACTERS}. Keep structure identical.`;
        continue;
      }

      return final; // already matches FinalDialogueResponse
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      appendLog("agents:sdk_error", { attempt, error: msg });
      lastError = error;
      if (/voice_id/i.test(msg)) {
        extraInstruction = `Every dialogue item MUST include "voice_id" set to "${HOST_VOICE_ID}" for host lines and "${GUEST_VOICE_ID}" for guest lines.`;
      } else if (/dialogue/i.test(msg)) {
        extraInstruction = `Return ONLY a top-level object with a "dialogue" array. No extra keys. No markdown.`;
      } else {
        extraInstruction = `Alternate host/guest lines, starting with host. Keep output strictly matching the required JSON schema.`;
      }
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `Unable to generate compliant podcast script: ${lastError.message}`
      : "Unable to generate compliant podcast script after multiple attempts.",
  );
}

function buildMentions(message: ResolvedMessage): string[] {
  const mentions = new Set<string>();
  if (message.senderId) mentions.add(message.senderId);
  const ignoredAgents = new Set([NORMALIZED_AGENT_ID, "article_fetcher"]);
  for (const mention of message.mentions ?? []) {
    const normalized = normalizeMention(mention);
    if (normalized && !ignoredAgents.has(normalized)) mentions.add(mention);
  }
  mentions.add(CORAL_AGENT_ID);
  return Array.from(mentions);
}

async function handleMessage(client: Client, message: ResolvedMessage): Promise<void> {
  appendLog("handle_message", { threadId: message.threadId, messageId: message.id, senderId: message.senderId, mentions: message.mentions });

  if (!shouldRespond(message)) return;

  const contextResult = extractArticleContext(message.content);
  if (!contextResult.success) {
    await sendMessage(
      client,
      message.threadId,
      buildErrorResponse(contextResult.error),
      buildMentions(message),
    );
    return;
  }

  let script: FinalDialogueResponse;
  try {
    script = await generatePodcastScript(message, contextResult.context);
  } catch (error) {
    appendLog("agents:script_generation_failed", { error: error instanceof Error ? error.message : String(error) });
    await sendMessage(
      client,
      message.threadId,
      buildErrorResponse(
        "Failed to generate podcast script.",
        error instanceof Error ? error.message : String(error),
      ),
      buildMentions(message),
    );
    return;
  }

  try {
    await sendMessage(client, message.threadId, assertJsonSerializable(script), buildMentions(message));
  } catch (error) {
    appendLog("send_message:error", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function main(): Promise<void> {
  const transport = new SSEClientTransport(new URL(CORAL_CONNECTION_URL));
  const client = new Client({ name: `podcast-script-${NORMALIZED_AGENT_ID}`, version: "0.0.1" }, { capabilities: { tools: {} } });

  await client.connect(transport);
  const sessionInfo = (transport as unknown as { sessionId?: string }).sessionId;
  appendLog("mcp:connected", { sessionId: sessionInfo });

  while (true) {
    try {
      const messages = await waitForMentions(client);
      for (const message of messages) {
        await handleMessage(client, message);
      }
    } catch (error) {
      appendLog("wait_for_mentions:error", { error: error instanceof Error ? error.message : String(error) });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

main().catch((error) => {
  appendLog("fatal", { error: error instanceof Error ? error.message : String(error) });
  console.error("Fatal error", error);
  process.exit(1);
});
