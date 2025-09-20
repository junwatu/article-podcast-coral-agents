import "dotenv/config";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import { fetch as undiciFetch } from "undici";
import OpenAI from "openai";

if (typeof globalThis.fetch !== "function") {
  (globalThis as any).fetch = undiciFetch;
}

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

interface DialogueLine { text: string; voice_id: string }

interface SynthesisResult {
  audioPath: string;
  bytes: number;
  mime: string;
  format: string;
  base64?: string;
  dataUri?: string;
}

interface DialogueEnvelope {
  dialogue?: DialogueLine[];
  inputs?: DialogueLine[];
  force?: boolean;
}

// —— Env ——
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing required environment variable " + name);
  return v;
}

const CORAL_CONNECTION_URL = requireEnv("CORAL_CONNECTION_URL");
const ELEVENLABS_API_KEY = requireEnv("ELEVENLABS_API_KEY");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");

const CORAL_AGENT_ID = process.env.CORAL_AGENT_ID || "podcast_generator";
const NORMALIZED_AGENT_ID = CORAL_AGENT_ID.replace(/^@/, "").toLowerCase();

const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(process.cwd(), "out");
const WAIT_TIMEOUT_MS = Number.parseInt(process.env.WAIT_TIMEOUT_MS || "600000", 10);
const LOG_PATH = path.resolve(process.cwd(), "podcast-generator.log");

const RETURN_BASE64 = ["1", "true"].includes((process.env.ELEVENLABS_RETURN_BASE64 || "").trim().toLowerCase());
const MAX_INLINE_BYTES = Math.min(
  (() => {
    const raw = process.env.MAX_INLINE_BYTES;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024;
  })(),
  8 * 1024 * 1024
);

const recentDialogueHashes = new Map<string, string>();

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const USE_AI_PARSE = (process.env.USE_AI_PARSE || "fallback") as "always" | "fallback" | "never";
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// —— Utilities ——
async function appendLogAsync(event: string, payload?: unknown) {
  const ts = new Date().toISOString();
  const sfx = payload === undefined ? "" : " " + (typeof payload === "string" ? payload : JSON.stringify(payload));
  await fs.promises.appendFile(LOG_PATH, `[${ts}] ${event}${sfx}\n`);
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
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      try { return JSON.parse(item.text) as ToolResult; } catch { }
    }
  }
  return null;
}

async function waitForMentions(client: Client): Promise<ResolvedMessage[]> {
  await appendLogAsync("wait_for_mentions:start", { timeoutMs: WAIT_TIMEOUT_MS });
  const response = await client.callTool({ name: "coral_wait_for_mentions", arguments: { timeoutMs: WAIT_TIMEOUT_MS } });
  const parsed = parseToolResult(response);
  if (!parsed) return [];
  if (parsed.result === "error_timeout") return [];
  if (parsed.result === "wait_for_mentions_success" && Array.isArray(parsed.messages)) {
    const messages = parsed.messages as ResolvedMessage[];
    await appendLogAsync("wait_for_mentions:success", { count: messages.length });
    return messages;
  }
  return [];
}

async function sendMessage(client: Client, threadId: string, content: string, mentions: string[]): Promise<void> {
  try {
    await client.callTool({ name: "coral_send_message", arguments: { threadId, content, mentions } });
  } catch (e) {
    await appendLogAsync("coral_send_message:error", e instanceof Error ? e.message : String(e));
    if (content.length > 200_000) {
      const truncated = content.slice(0, 199_000) + "\n...[truncated]";
      await client.callTool({ name: "coral_send_message", arguments: { threadId, content: truncated, mentions } });
    } else {
      throw e;
    }
  }
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

function summarizeInputs(inputs: DialogueLine[], limit = 3) {
  return inputs.slice(0, limit).map((line, idx) => ({
    index: idx,
    voice_id: line.voice_id,
    preview: line.text.slice(0, 120),
    length: line.text.length,
  }));
}

// —— Schema ——
const safeText = z.string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .refine((s) => s.length > 0 && s.length <= 600, {
    message: "text must be 1–600 chars after normalization",
  });

const lineSchema = z.object({
  text: safeText,
  voice_id: z.string(),
});

const dialogueSchema = z.object({ dialogue: z.array(lineSchema).min(1).max(100) });
const inputsSchema = z.object({ inputs: z.array(lineSchema).min(1).max(100) });

// —— Parsing helpers ——
function extractFirstBalancedJson(raw: string): string | null {
  const s = raw;
  let i = s.indexOf("{");
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;

  for (; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(raw: string): DialogueLine[] | null {
  const attempt = (obj: unknown) => {
    const d = dialogueSchema.safeParse(obj);
    if (d.success) return d.data.dialogue;
    const i = inputsSchema.safeParse(obj);
    if (i.success) return i.data.inputs;
    return null;
  };

  try {
    const o = JSON.parse(raw);
    const r = attempt(o);
    if (r) return r;
  } catch { }

  const fence = raw.match(/```json([\s\S]*?)```/i) || raw.match(/```([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      const o2 = JSON.parse(fence[1].trim());
      const r2 = attempt(o2);
      if (r2) return r2;
    } catch { }
  }

  const balanced = extractFirstBalancedJson(raw);
  if (balanced) {
    try {
      const o3 = JSON.parse(balanced);
      const r3 = attempt(o3);
      if (r3) return r3;
    } catch { }
  }
  return null;
}

// —— AI parse ——
const dialogueJsonSchema = {
  type: "object",
  properties: {
    dialogue: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: 600 },
          voice_id: { type: "string", minLength: 1 }
        },
        required: ["text", "voice_id"]
      }
    }
  },
  required: ["dialogue"],
  additionalProperties: false
} as const;

async function aiExtractInputsAsync(raw: string): Promise<DialogueLine[]> {
  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "You extract podcast dialogue arrays. Return ONLY valid JSON that matches the given schema."
      },
      {
        role: "user",
        content: "From the following content, extract the podcast dialogue. If JSON is already present, normalize it to the schema. If multiple appear, use the most complete one:\n\n" + raw
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "podcast_dialogue",
        schema: dialogueJsonSchema,
        strict: true
      }
    }
  });

  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error("AI returned empty content.");
  await appendLogAsync("ai_parse:raw_json_preview", content.slice(0, 500));

  const parsed = JSON.parse(content) as { dialogue: DialogueLine[] };
  return dialogueSchema.parse(parsed).dialogue;
}

async function extractInputsAsync(raw: string): Promise<DialogueLine[]> {
  const trimmed = (raw || "").trim();
  if (!trimmed) throw new Error("Empty message content; expected JSON with dialogue or inputs");

  const attemptLocal = () => {
    const direct = tryParse(trimmed);
    if (direct) return z.array(lineSchema).min(1).parse(direct);
    return null;
  };

  if (USE_AI_PARSE === "always") {
    try { return await aiExtractInputsAsync(trimmed); } catch (e) {
      await appendLogAsync("extract:ai_failed", String(e));
      const local = attemptLocal();
      if (local) return local;
      throw e;
    }
  } else if (USE_AI_PARSE === "fallback") {
    const local = attemptLocal();
    if (local) return local;
    await appendLogAsync("extract:local_failed_falling_back_to_ai");
    return await aiExtractInputsAsync(trimmed);
  } else {
    const local = attemptLocal();
    if (local) return local;
    throw new Error("Unable to parse JSON locally and AI parse disabled");
  }
}

// —— Dialogue hash ——
function computeDialogueHash(inputs: DialogueLine[]): string {
  const canonical = JSON.stringify(inputs.map((item) => ({ text: item.text, voice_id: item.voice_id })));
  return createHash("sha256").update(canonical).digest("hex");
}

function shouldSkipSynthesis(threadId: string, inputs: DialogueLine[], force?: boolean): boolean {
  const hash = computeDialogueHash(inputs);
  if (force) { recentDialogueHashes.set(threadId, hash); return false; }
  const last = recentDialogueHashes.get(threadId);
  if (last && last === hash) return true;
  recentDialogueHashes.set(threadId, hash);
  return false;
}

// —— ElevenLabs synthesis ——
function extFromFormat(fmt: string): { ext: string; mime: string } {
  const f = fmt.toLowerCase();
  if (f.startsWith("mp3")) return { ext: "mp3", mime: "audio/mpeg" };
  if (f.startsWith("wav")) return { ext: "wav", mime: "audio/wav" };
  if (f.startsWith("ogg")) return { ext: "ogg", mime: "audio/ogg" };
  if (f.startsWith("flac")) return { ext: "flac", mime: "audio/flac" };
  return { ext: "bin", mime: "application/octet-stream" };
}

async function synthesizeWithElevenLabs(inputs: DialogueLine[]): Promise<SynthesisResult> {
  const { ext, mime } = extFromFormat(ELEVENLABS_OUTPUT_FORMAT);
  const url = "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=" + encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT);

  await appendLogAsync("elevenlabs:request_preflight", {
    inputCount: inputs.length,
    uniqueVoices: [...new Set(inputs.map(i => i.voice_id))].length,
    summaries: summarizeInputs(inputs, 5),
    format: ELEVENLABS_OUTPUT_FORMAT,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": ELEVENLABS_API_KEY },
    body: JSON.stringify({ inputs }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("ElevenLabs error " + res.status + ": " + txt);
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const audioPath = path.join(OUTPUT_DIR, "podcast_" + Date.now() + "." + ext);
  fs.writeFileSync(audioPath, buf);

  const result: SynthesisResult = { audioPath, bytes: buf.length, mime, format: ELEVENLABS_OUTPUT_FORMAT };
  if (RETURN_BASE64 && buf.length <= MAX_INLINE_BYTES) {
    const b64 = buf.toString("base64");
    result.base64 = b64;
    result.dataUri = "data:" + mime + ";base64," + b64;
  }
  return result;
}

// —— Handler ——
async function handleMessage(client: Client, message: ResolvedMessage): Promise<void> {
  await appendLogAsync("handle_message", { threadId: message.threadId, messageId: message.id });
  if (!shouldRespond(message)) return;

  const mentions = buildMentions(message);
  await appendLogAsync("incoming_message:content", {
    threadId: message.threadId,
    messageId: message.id,
    senderId: message.senderId,
    contentLength: message.content.length,
    preview: message.content.slice(0, 500),
  });

  let inputs: DialogueLine[];
  try {
    inputs = await extractInputsAsync(message.content);
    await appendLogAsync("synthesis:inputs_summary", {
      count: inputs.length,
      uniqueVoices: [...new Set(inputs.map(i => i.voice_id))].length,
      sample: summarizeInputs(inputs, 2),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await appendLogAsync("synthesis:parse_error", {
      threadId: message.threadId,
      messageId: message.id,
      error: errorMessage,
    });
    await sendMessage(client, message.threadId, JSON.stringify({ success: false, error: errorMessage }), mentions);
    return;
  }

  let force = false;
  try {
    const envJson = extractFirstBalancedJson(message.content);
    if (envJson) {
      const envelope = JSON.parse(envJson) as DialogueEnvelope;
      force = Boolean(envelope.force);
    }
  } catch {
    // ignore non-JSON wrappers
  }

  if (shouldSkipSynthesis(message.threadId, inputs, force)) {
    await appendLogAsync("synthesis:skipped_duplicate", {
      threadId: message.threadId,
      messageId: message.id,
      force,
    });
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
    { name: "podcast-generator", version: "0.0.7" },
    { capabilities: { tools: {} } }
  );
  await client.connect(transport);

  const sessionInfo = (transport as unknown as { sessionId?: string }).sessionId;
  await appendLogAsync("mcp:connected", { sessionId: sessionInfo });

  while (true) {
    try {
      const messages = await waitForMentions(client);
      for (const m of messages) {
        await handleMessage(client, m);
      }
    } catch (err) {
      await appendLogAsync("loop:error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch(async (err) => {
  await appendLogAsync("fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  console.error("Fatal error", err);
  process.exit(1);
});

