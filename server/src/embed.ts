import { settings } from "./config.js";

export interface Embedder {
  readonly model: string;
  dim(): Promise<number>;
  embed(texts: string[]): Promise<number[][]>;
}

class OllamaEmbedder implements Embedder {
  private dimension?: number;
  constructor(readonly model: string, private url: string) {}

  async dim() {
    this.dimension ??= (await this.embed(["dimensão"]))[0]!.length;
    return this.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts, truncate: true }),
    }).catch((err: unknown) => {
      throw new Error(`Ollama não respondeu em ${this.url} (${String(err)}). Ele está aberto? "ollama pull ${this.model}" já rodou?`);
    });
    if (!res.ok) throw new Error(`Ollama /api/embed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings;
  }
}

class OpenAIEmbedder implements Embedder {
  constructor(readonly model: string, private apiKey: string) {}

  async dim() {
    return (await this.embed(["dimensão"]))[0]!.length;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI /v1/embeddings ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export function getEmbedder(): Embedder {
  if (settings.embed.provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("EMBED_PROVIDER=openai exige OPENAI_API_KEY.");
    return new OpenAIEmbedder(process.env.EMBED_MODEL ?? "text-embedding-3-small", key);
  }
  return new OllamaEmbedder(settings.embed.model, settings.ollamaUrl);
}

/**
 * Texto que vai para o embedding: o trecho precedido de onde ele está.
 * "Bibliografia Básica" sozinho não diz de qual disciplina; com o cabeçalho, a busca por
 * "livros de Bases Matemáticas" encontra o trecho certo.
 */
export function contextualize(meta: { subject: string; title: string; section: string }, heading: string | null, text: string) {
  const where = [meta.subject, meta.title, heading].filter(Boolean).join(" › ");
  return `${where}\n\n${text}`;
}
