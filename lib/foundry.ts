// Client fetch minimal vers Azure AI Foundry (endpoint compatible Anthropic).
// Routing par nom de deployment (champ model), auth x-api-key, retry/backoff sur 429/5xx.

const API_VERSION = "2024-10-01-preview";

export interface FoundryTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      is_error?: boolean;
      content: string;
    };

export interface FoundryMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface FoundryResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

function baseUrl(): string {
  const b = process.env.FOUNDRY_BASE_URL;
  if (!b) throw new Error("FOUNDRY_BASE_URL manquant");
  return b.replace(/\/$/, "");
}

function apiKey(): string {
  const k = process.env.FOUNDRY_API_KEY;
  if (!k) throw new Error("FOUNDRY_API_KEY manquant");
  return k;
}

export function workerModel(): string {
  return process.env.FOUNDRY_WORKER_DEPLOYMENT || "claude-opus-4-6";
}
export function judgeModel(): string {
  return process.env.FOUNDRY_JUDGE_DEPLOYMENT || "claude-opus-4-8";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callMessages(opts: {
  model: string;
  system?: string;
  messages: FoundryMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: FoundryTool[];
  tool_choice?: { type: "tool"; name: string } | { type: "auto" };
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<FoundryResponse> {
  const url = `${baseUrl()}/v1/messages?api-version=${API_VERSION}`;
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.max_tokens ?? 4096,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;
  if (opts.tools) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  // temperature: certains modèles récents (Opus 4.7+/Fable) rejettent les sampling params.
  if (opts.temperature !== undefined && !/fable|opus-4-[7-9]/.test(opts.model)) {
    body.temperature = opts.temperature;
  }

  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
        lastErr = new Error(`Foundry ${res.status}: ${(await res.text()).slice(0, 200)}`);
        if (attempt < maxRetries) {
          await sleep(retryAfter * 1000);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        throw new Error(`Foundry ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      return (await res.json()) as FoundryResponse;
    } catch (e) {
      clearTimeout(to);
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (lastErr.name === "AbortError") lastErr = new Error("Foundry timeout");
      if (attempt < maxRetries) {
        await sleep(2 ** attempt * 1500);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("Foundry: échec inconnu");
}

// Streaming (SSE Anthropic) — utilisé par le juge pour le verdict exécutif.
export async function* streamText(opts: {
  model: string;
  system?: string;
  messages: FoundryMessage[];
  max_tokens?: number;
}): AsyncGenerator<string> {
  const url = `${baseUrl()}/v1/messages?api-version=${API_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.max_tokens ?? 1024,
      system: opts.system,
      messages: opts.messages,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Foundry stream ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          yield ev.delta.text as string;
        }
      } catch {
        // ligne partielle — ignorée
      }
    }
  }
}
