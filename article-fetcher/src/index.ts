import "dotenv/config";
import fs from "fs";
import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Readability } from "@mozilla/readability";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { fetch as undiciFetch } from "undici";

if (typeof globalThis.fetch !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = undiciFetch;
}

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

interface ArticlePayload {
  url: string;
  resolved_url: string;
  title: string;
  byline?: string | null;
  excerpt?: string | null;
  language?: string | null;
  word_count: number;
  estimated_read_time_minutes: number;
  published_at?: string | null;
  top_image_url?: string | null;
  text: string;
  html?: string | null;
  fetch_duration_ms: number;
  retrieved_at: string;
  source: {
    content_type?: string | null;
    content_length?: number | null;
  };
}

interface ArticleCleanup {
  cleaned_text: string;
  paragraphs: string[];
  headings: Array<{ level: number; text: string }>;
  images: Array<{ url: string; caption?: string | null }>;
  language: string | null;
  removal_notes?: string;
}

const CORAL_CONNECTION_URL = requireEnv("CORAL_CONNECTION_URL");
const CORAL_AGENT_ID = process.env.CORAL_AGENT_ID ?? "article_fetcher";
const NORMALIZED_AGENT_ID = CORAL_AGENT_ID.replace(/^@/, "").toLowerCase();
const USER_AGENT =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.FETCH_TIMEOUT_MS ?? "15000",
  10,
);
const WAIT_TIMEOUT_MS = Number.parseInt(process.env.WAIT_TIMEOUT_MS ?? "600000", 10);
const LOG_PATH = path.resolve(process.cwd(), "article-fetcher.log");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function appendLog(event: string, payload?: unknown) {
  const timestamp = new Date().toISOString();
  const suffix =
    payload === undefined
      ? ""
      : ` ${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
  fs.appendFile(LOG_PATH, `[${timestamp}] ${event}${suffix}\n`, () => {
    /* ignore logging errors */
  });
}

appendLog("Boot", {
  CORAL_AGENT_ID,
  CORAL_CONNECTION_URL,
  USER_AGENT,
  FETCH_TIMEOUT_MS,
  WAIT_TIMEOUT_MS,
});

function normalizeMention(raw: string): string {
  return raw
    .trim()
    .replace(/^@/, "")
    .split(/[#:]/, 1)[0]
    .toLowerCase();
}

function parseToolResult(response: unknown): ToolResult | null {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      try {
        return JSON.parse(item.text) as ToolResult;
      } catch (error) {
        appendLog("Failed to parse tool result", {
          error: error instanceof Error ? error.message : String(error),
          text: item.text,
        });
      }
    }
  }

  appendLog("Tool result missing text content", response as unknown);
  return null;
}

async function waitForMentions(client: Client): Promise<ResolvedMessage[]> {
  appendLog("wait_for_mentions:start", { timeoutMs: WAIT_TIMEOUT_MS });

  const response = await client.callTool({
    name: "coral_wait_for_mentions",
    arguments: { timeoutMs: WAIT_TIMEOUT_MS },
  } as any);

  const parsed = parseToolResult(response);
  if (!parsed) {
    appendLog("wait_for_mentions:invalid_response");
    return [];
  }

  if (parsed.result === "error_timeout") {
    appendLog("wait_for_mentions:timeout");
    return [];
  }

  if (
    parsed.result === "wait_for_mentions_success" &&
    Array.isArray(parsed.messages)
  ) {
    const messages = parsed.messages as ResolvedMessage[];
    appendLog("wait_for_mentions:success", { count: messages.length });
    return messages;
  }

  appendLog("wait_for_mentions:unexpected_result", parsed);
  return [];
}

async function sendMessage(
  client: Client,
  threadId: string,
  message: string,
  mentions: string[],
): Promise<void> {
  const response = await client.callTool({
    name: "coral_send_message",
    arguments: {
      threadId,
      content: message,
      mentions,
    },
  } as any);

  const parsed = parseToolResult(response);
  if (!parsed || parsed.result !== "send_message_success") {
    appendLog("send_message:unexpected_result", parsed ?? response);
    return;
  }

  appendLog("send_message:success", { threadId, mentions });
}

function shouldRespond(message: ResolvedMessage): boolean {
  if (message.senderId === CORAL_AGENT_ID) {
    appendLog("Ignoring own message", {
      threadId: message.threadId,
      messageId: message.id,
    });
    return false;
  }

  if (!message.mentions || message.mentions.length === 0) {
    appendLog("Message has no mentions", {
      threadId: message.threadId,
      messageId: message.id,
      senderId: message.senderId,
    });
    return false;
  }

  const match = message.mentions.some((mention) => {
    const normalized = normalizeMention(mention);
    return normalized === NORMALIZED_AGENT_ID;
  });

  if (!match) {
    appendLog("Mentions missing agent", {
      mentions: message.mentions,
      agentId: CORAL_AGENT_ID,
    });
  }

  return match;
}

function extractFirstUrl(text: string): string | null {
  const urlRegex = /https?:\/\/[^\s)]+/gi;
  const matches = text.match(urlRegex);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[0].replace(/[.,!?;:]+$/, "");
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function computeReadTime(wordCount: number): number {
  const wordsPerMinute = 200;
  return Math.max(1, Math.round(wordCount / wordsPerMinute));
}

async function extractArticle(url: string): Promise<ArticlePayload> {
  const start = performance.now();
  const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  const resolvedUrl = response.url || url;
  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  const html = await response.text();

  const dom = new JSDOM(html, { url: resolvedUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error("Failed to extract article content");
  }

  const text = article.textContent?.trim() ?? "";
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const language =
    dom.window.document.documentElement.lang ||
    dom.window.document.querySelector("meta[http-equiv='content-language']")?.getAttribute("content") ||
    dom.window.document.querySelector("meta[name='language']")?.getAttribute("content") ||
    null;

  const publishedAt =
    dom.window.document.querySelector("meta[property='article:published_time']")?.getAttribute("content") ||
    dom.window.document.querySelector("meta[name='pubdate']")?.getAttribute("content") ||
    dom.window.document.querySelector("meta[name='date']")?.getAttribute("content") ||
    dom.window.document.querySelector("time")?.getAttribute("datetime") ||
    null;

  const fetchDurationMs = Math.round(performance.now() - start);

  const articleImage = (article as unknown as { image?: string | null }).image ?? null;

  return {
    url,
    resolved_url: resolvedUrl,
    title: article.title ?? dom.window.document.title ?? "Untitled",
    byline: article.byline,
    excerpt: article.excerpt,
    language,
    word_count: wordCount,
    estimated_read_time_minutes: computeReadTime(wordCount),
    published_at: publishedAt,
    top_image_url: articleImage ||
      dom.window.document.querySelector("meta[property='og:image']")?.getAttribute("content") ||
      null,
    text,
    html: article.content,
    fetch_duration_ms: fetchDurationMs,
    retrieved_at: new Date().toISOString(),
    source: {
      content_type: contentType,
      content_length: contentLength ? Number(contentLength) : null,
    },
  };
}

function buildCleanArticle(article: ArticlePayload): ArticleCleanup {
  const dom = article.html ? new JSDOM(article.html, { url: article.resolved_url }) : null;
  const document = dom?.window.document ?? null;

  const paragraphs: string[] = [];
  const headings: Array<{ level: number; text: string }> = [];
  const images: Array<{ url: string; caption?: string | null }> = [];

  if (document) {
    const baseUrl = article.resolved_url || article.url;
    document.querySelectorAll("p").forEach((p) => {
      const text = p.textContent?.trim();
      if (text) {
        paragraphs.push(text.replace(/\s+/g, " "));
      }
    });

    document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
      const text = heading.textContent?.trim();
      if (text) {
        const level = Number.parseInt(heading.tagName.substring(1), 10) || 2;
        headings.push({ level, text: text.replace(/\s+/g, " ") });
      }
    });

    document.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src")?.trim();
      if (!src) return;
      try {
        const absolute = new URL(src, baseUrl).href;
        const caption =
          img.getAttribute("alt")?.trim() ||
          img.closest("figure")?.querySelector("figcaption")?.textContent?.trim() ||
          null;
        images.push({ url: absolute, caption });
      } catch {
        // Ignore invalid URLs
      }
    });
  }

  if (paragraphs.length === 0) {
    paragraphs.push(
      ...article.text
        .split(/\n{2,}/)
        .map((chunk) => chunk.trim())
        .filter(Boolean),
    );
  }

  return {
    cleaned_text: article.text,
    paragraphs,
    headings,
    images,
    language: article.language ?? null,
    removal_notes: document ? undefined : "Article HTML unavailable; derived from plain text.",
  };
}

async function handleMessage(client: Client, message: ResolvedMessage): Promise<void> {
  appendLog("handle_message", {
    threadId: message.threadId,
    messageId: message.id,
    senderId: message.senderId,
    mentions: message.mentions,
  });

  if (!shouldRespond(message)) {
    return;
  }

  const url = extractFirstUrl(message.content);
  if (!url) {
    appendLog("no_url_found", { contentSnippet: message.content.slice(0, 100) });
    await sendMessage(
      client,
      message.threadId,
      JSON.stringify({
        error: "No URL detected in the message. Please provide a valid article URL.",
      }),
      [message.senderId, CORAL_AGENT_ID],
    );
    return;
  }

  try {
    const article = await extractArticle(url);
    const clean = buildCleanArticle(article);
    const fallbackParagraphs = clean.paragraphs?.join("\n\n") ?? "";
    const cleanedText =
      (clean.cleaned_text && clean.cleaned_text.trim()) ||
      (article.text && article.text.trim()) ||
      fallbackParagraphs.trim();
    await sendMessage(
      client,
      message.threadId,
      JSON.stringify({ data: cleanedText }),
      [message.senderId, CORAL_AGENT_ID],
    );
  } catch (error) {
    appendLog("extract_article:error", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });

    await sendMessage(
      client,
      message.threadId,
      JSON.stringify({
        success: false,
        url,
        error: error instanceof Error ? error.message : String(error),
      }),
      [message.senderId, CORAL_AGENT_ID],
    );
  }
}

async function main(): Promise<void> {
  const transport = new SSEClientTransport(new URL(CORAL_CONNECTION_URL));
  const client = new Client(
    {
      name: `article-fetcher-${NORMALIZED_AGENT_ID}`,
      version: "0.0.1",
    },
    {
      capabilities: { tools: {} },
    },
  );

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
      appendLog("loop:error", {
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

main().catch((error) => {
  appendLog("fatal", {
    error: error instanceof Error ? error.message : String(error),
  });
  console.error("Fatal error", error);
  process.exit(1);
});
