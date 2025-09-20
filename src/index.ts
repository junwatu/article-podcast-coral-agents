import "dotenv/config";
import fs from "fs";
import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import { fetch as undiciFetch } from "undici";

// Ensure fetch exists (Node < 18 or custom runtimes)
if (typeof globalThis.fetch !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = undiciFetch;
}

/**
 * Podcast Generator Agent (TTS-only, ElevenLabs)
 * ------------------------------------------------
 * This agent listens for mentions via MCP. The mentioned message must contain
 * a JSON payload with the final dialogue script:
 *   { "dialogue": [ { "text": string, "voice_id": string }, ... ] }
 * or alternatively:
 *   { "inputs": [ { "text": string, "voice_id": string }, ... ] }
 *
 * It then POSTs that array to ElevenLabs /v1/text-to-dialogue with xi-api-key
 * and returns a local MP3 path plus meta back into the thread as JSON.
 */

// —— Types ——
interface ResolvedMessage {
  id: string;
  threadName: string;
  threadId: string;
  senderId: string;
  content: string;
  timestamp: number;
  mentions: string[];
}

interface ToolResult {
  result?: string;
  messages?: unknown;
  [key: string]: unknown;
}

interface DialogueLine {
  text: string;
  voice_id: string;
}

interface SynthesisResult {
  audioPath: string;
  bytes: number;
  mime: string;
  format: string;
  inlineBase64?: string;
  inline?: boolean;
  maxInlineBytes: number;
}

// —— Env ——
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing required environment variable " + name);
  return v;
}

const CORAL_CONNECTION_URL = requireEnv("CORAL_CONNECTION_URL");
const ELEVENLABS_API_KEY = requireEnv("ELEVENLABS_API_KEY");
const CORAL_AGENT_ID = process.env.CORAL_AGENT_ID || "podcast_tts";
const NORMALIZED_AGENT_ID = CORAL_AGENT_ID.replace(/^@/, "").toLowerCase();

const ELEVENLABS_OUTPUT_FORMAT =
  process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";
const OUTPUT_DIR =
  process.env.OUTPUT_DIR || path.resolve(process.cwd(), "out");
const WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.WAIT_TIMEOUT_MS || "600000",
  10,
);
const ELEVENLABS_RETURN_BASE64 = (() => {
  const raw = (process.env.ELEVENLABS_RETURN_BASE64 ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
})();
const MAX_INLINE_BYTES = (() => {
  const raw = process.env.MAX_INLINE_BYTES;
  if (!raw) return 5 * 1024 * 1024; // 5 MB default when not specified
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024;
})();
const LOG_PATH = path.resolve(process.cwd(), "podcast-tts.log");

// —— Utilities ——
function appendLog(event: string, payload?: unknown) {
  const ts = new Date().toISOString();
  const sfx =
    payload === undefined
      ? ""
      : " " + (typeof payload === "string" ? payload : JSON.stringify(payload));
  fs.appendFile(LOG_PATH, "[" + ts + "] " + event + sfx + "\n", () => {});
}

function normalizeMention(raw: string): string {
  return raw.trim().replace(/^@/, "").split(/[#:]/, 1)[0].toLowerCase();
}

function shouldRespond(message: ResolvedMessage): boolean {
  if (message.senderId === CORAL_AGENT_ID) return false;
  if (!message.mentions || message.mentions.length === 0) return false;
  return message.mentions.some((m) => normalizeMention(m) === NORMALIZED_AGENT_ID);
}

function parseToolResult(response: unknown): ToolResult | null {
  const content = (
    response as { content?: Array<{ type?: string; text?: string }> }
  ).content ?? [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      try {
        return JSON.parse(item.text) as ToolResult;
      } catch {}
    }
  }
  return null;
}

async function waitForMentions(client: Client): Promise<ResolvedMessage[]> {
  const response = await client.callTool({
    name: "coral_wait_for_mentions",
    arguments: { timeoutMs: WAIT_TIMEOUT_MS },
  });
  const parsed = parseToolResult(response);
  if (!parsed) return [];
  if (parsed.result === "error_timeout") return [];
  if (parsed.result === "wait_for_mentions_success" && Array.isArray(parsed.messages)) {
    return parsed.messages as ResolvedMessage[];
  }
  return [];
}

async function sendMessage(
  client: Client,
  threadId: string,
  content: string,
  mentions: string[],
): Promise<void> {
  await client.callTool({
    name: "coral_send_message",
    arguments: { threadId, content, mentions },
  });
}

function buildMentions(message: ResolvedMessage): string[] {
  const m = new Set<string>();
  if (message.senderId) m.add(message.senderId);
  const ignored = new Set([NORMALIZED_AGENT_ID, "article_fetcher"]);
  for (const mention of message.mentions ?? []) {
    const n = normalizeMention(mention);
    if (n && !ignored.has(n)) m.add(mention);
  }
  m.add(CORAL_AGENT_ID);
  return Array.from(m);
}

// —— Input parsing ——
const lineSchema = z.object({ text: z.string().min(1), voice_id: z.string().min(1) });
const payloadSchema = z.object({ dialogue: z.array(lineSchema).min(1) });
const altSchema = z.object({ inputs: z.array(lineSchema).min(1) });

function extractInputs(raw: string): DialogueLine[] {
  const trimmed = (raw || "").trim();
  if (!trimmed) throw new Error("Empty message content; expected JSON with dialogue");

  // Try direct JSON first
  try {
    const parsed = JSON.parse(trimmed);
    const p = payloadSchema.safeParse(parsed);
    if (p.success) return p.data.dialogue;
    const a = altSchema.safeParse(parsed);
    if (a.success) return a.data.inputs;
  } catch {}

  // Try fenced JSON ```json ... ```
  const fence =
    trimmed.match(/```json([\s\S]*?)```/i) ||
    trimmed.match(/```([\s\S]*?)```/);
  if (fence && fence[1]) {
    try {
      const parsed2 = JSON.parse(fence[1].trim());
      const p2 = payloadSchema.safeParse(parsed2);
      if (p2.success) return p2.data.dialogue;
      const a2 = altSchema.safeParse(parsed2);
      if (a2.success) return a2.data.inputs;
    } catch {}
  }

  throw new Error(
    "Unable to parse dialogue JSON; expected { dialogue: [...] } or { inputs: [...] }.",
  );
}

// —— ElevenLabs: text-to-dialogue → MP3 ——
async function synthesizeWithElevenLabs(
  inputs: DialogueLine[],
): Promise<SynthesisResult> {
  const base = "https://api.elevenlabs.io/v1/text-to-dialogue";
  const url = base + "?output_format=" + encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({ inputs }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("ElevenLabs error " + res.status + ": " + txt);
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const audioPath = path.join(OUTPUT_DIR, "podcast_" + Date.now() + ".mp3");
  fs.writeFileSync(audioPath, buf);

  const inline = ELEVENLABS_RETURN_BASE64 && buf.length <= MAX_INLINE_BYTES;
  const inlineBase64 = inline ? buf.toString("base64") : undefined;

  if (ELEVENLABS_RETURN_BASE64 && !inline) {
    appendLog("inline_base64:skipped", {
      bytes: buf.length,
      maxInlineBytes: MAX_INLINE_BYTES,
    });
  }

  return {
    audioPath,
    bytes: buf.length,
    mime: "audio/mpeg",
    format: ELEVENLABS_OUTPUT_FORMAT,
    inlineBase64,
    inline,
    maxInlineBytes: MAX_INLINE_BYTES,
  };
}

// —— Handler ——
async function handleMessage(client: Client, message: ResolvedMessage): Promise<void> {
  appendLog("handle_message", { threadId: message.threadId, messageId: message.id });
  if (!shouldRespond(message)) return;

  const mentions = buildMentions(message);

  let inputs: DialogueLine[];
  try {
    inputs = extractInputs(message.content);
  } catch (err) {
    await sendMessage(
      client,
      message.threadId,
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      mentions,
    );
    return;
  }

  try {
    const audio = await synthesizeWithElevenLabs(inputs);
    const payload = { success: true, inputs, elevenlabs: audio };
    await sendMessage(client, message.threadId, JSON.stringify(payload, null, 2), mentions);
  } catch (err) {
    const payload = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      inputs,
    };
    await sendMessage(client, message.threadId, JSON.stringify(payload, null, 2), mentions);
  }
}

// —— Main loop ——
async function main(): Promise<void> {
  const transport = new SSEClientTransport(new URL(CORAL_CONNECTION_URL));
  const client = new Client(
    { name: "podcast-tts-" + NORMALIZED_AGENT_ID, version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  await client.connect(transport);

  const sessionInfo = (transport as unknown as { sessionId?: string }).sessionId;
  appendLog("mcp:connected", { sessionId: sessionInfo });

  while (true) {
    try {
      const messages = await waitForMentions(client);
      for (const m of messages) {
        await handleMessage(client, m);
      }
    } catch (err) {
      appendLog("loop:error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  appendLog("fatal", { error: err instanceof Error ? err.message : String(err) });
  console.error("Fatal error", err);
  process.exit(1);
});
