import Anthropic from "@anthropic-ai/sdk";
import { settings } from "./config.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerationResult {
  text: string;
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface Generator {
  readonly provider: "anthropic" | "openai" | "ollama";
  readonly model: string;
  stream(system: string, messages: ChatTurn[], onText: (delta: string) => void, signal?: AbortSignal): Promise<GenerationResult>;
}

class AnthropicGenerator implements Generator {
  readonly provider = "anthropic";
  private client = new Anthropic();
  constructor(readonly model: string) {}

  async stream(system: string, messages: ChatTurn[], onText: (delta: string) => void, signal?: AbortSignal) {
    // Fallback no servidor: se o modelo recusar por política, a mesma requisição continua noutro modelo.
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        messages,
      },
      { signal },
    );
    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") onText(event.delta.text);
      }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || (err instanceof Error && /authentication method/i.test(err.message))) {
        throw new Error("Sem credencial da Anthropic: defina ANTHROPIC_API_KEY no .env, ou use LLM_PROVIDER=ollama para gerar localmente.");
      }
      throw err;
    }
    const message = await stream.finalMessage();
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return {
      text,
      model: message.model,
      stopReason: message.stop_reason,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

class OpenAIGenerator implements Generator {
  readonly provider = "openai";
  constructor(readonly model: string, private apiKey: string | undefined, private url: string) {}

  async stream(system: string, messages: ChatTurn[], onText: (delta: string) => void, signal?: AbortSignal) {
    const request = () =>
      fetch(`${this.url}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }) },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "system", content: system }, ...messages],
        }),
      });
    // Modelos gratuitos (OpenRouter, Groq) devolvem 429 por minuto ou por pool compartilhado; esperar resolve.
    let res = await request();
    for (let attempt = 1; attempt <= 5 && (res.status === 429 || res.status === 503); attempt++) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel();
      await sleep(after > 0 ? after * 1000 : 5000 * 2 ** attempt, signal);
      res = await request();
    }
    if (!res.ok || !res.body) throw new Error(`${this.url}/chat/completions ${res.status}: ${await res.text()}`);
    let text = "";
    let stopReason: string | null = null;
    let usage: GenerationResult["usage"] = null;
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      const json = JSON.parse(data) as {
        choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onText(delta);
      }
      stopReason = json.choices?.[0]?.finish_reason ?? stopReason;
      if (json.usage) usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
    }
    return { text, model: this.model, stopReason, usage };
  }
}

class OllamaGenerator implements Generator {
  readonly provider = "ollama";
  constructor(readonly model: string, private url: string) {}

  async stream(system: string, messages: ChatTurn[], onText: (delta: string) => void, signal?: AbortSignal) {
    const res = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        options: { num_ctx: 16384, temperature: 0.2 },
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama /api/chat ${res.status}: ${await res.text()}`);
    let text = "";
    let usage: GenerationResult["usage"] = null;
    let stopReason: string | null = null;
    for await (const line of lines(res.body)) {
      const json = JSON.parse(line) as {
        message?: { content?: string };
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const delta = json.message?.content;
      if (delta) {
        text += delta;
        onText(delta);
      }
      if (json.done) {
        stopReason = json.done_reason ?? "stop";
        usage = { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 };
      }
    }
    return { text, model: this.model, stopReason, usage };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of lines(body)) if (line.startsWith("data:")) yield line.slice(5).trim();
}

export function getGenerator(override?: { provider?: string; model?: string }): Generator {
  const provider = override?.provider ?? settings.llm.provider;
  const model = override?.model ?? settings.llm.model;
  switch (provider) {
    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      // Servidores locais compatíveis (Ollama, LM Studio) não pedem chave; a API da OpenAI sim.
      if (!key && !process.env.OPENAI_BASE_URL) throw new Error("LLM_PROVIDER=openai exige OPENAI_API_KEY (ou OPENAI_BASE_URL para um servidor compatível sem chave).");
      return new OpenAIGenerator(model ?? "gpt-5", key, settings.openaiUrl);
    }
    case "ollama":
      return new OllamaGenerator(model ?? "qwen2.5:7b", settings.ollamaUrl);
    default:
      return new AnthropicGenerator(model ?? "claude-opus-5");
  }
}
