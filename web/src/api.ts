// Cliente da API, com recuo para a demo estática (JSON exportado) quando não há servidor.

export interface Health {
  ok: boolean;
  demo?: boolean;
  database: string;
  documents: number;
  chunks: number;
  graphNodes: number;
  embedding: string | null;
  generator: string | null;
  publicOnly: boolean;
  exportedAt?: string;
}

export interface Source {
  n: number;
  kind: "trecho" | "grafo";
  docId: string | null;
  repo: string | null;
  title: string;
  subject: string;
  section: string;
  heading: string | null;
  pages: string | null;
  visibility: "publico" | "privado";
  text: string;
  score: number | null;
}

export interface DoneInfo {
  citations: { valid: number[]; invalid: number[] };
  model: string;
  provider: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
  retrievalMs: number;
}

export interface DocumentRow {
  id: string;
  repo: string;
  path: string;
  section: string;
  subject: string;
  visibility: "publico" | "privado";
  format: string;
  title: string;
  pages: number | null;
  chars: number;
  chunks: number;
  tokens: number;
  quality: { flags: string[]; emptyPages: number; removedBoilerplate: number; garbledRatio: number };
}

export interface ChunkRow {
  doc_id?: string;
  ord: number;
  heading: string | null;
  page_start: number | null;
  page_end: number | null;
  text: string;
  tokens: number;
}

export interface GraphNode {
  id: string;
  type: "disciplina" | "conceito" | "livro" | "curso";
  label: string;
  data: { visibility: string; docs: string[]; codes?: string[]; tpei?: string; ementa?: string; ref?: string; year?: string };
}

export interface GraphEdge {
  src: string;
  dst: string;
  type: string;
  weight: number;
  evidence: { docId: string; visibility: string; detail?: string }[];
}

export interface RetrievalMetrics {
  hit1: number;
  hit3: number;
  hit8: number;
  mrr: number;
  n: number;
}

export interface EvalItemResult {
  id: string;
  tipo: string;
  pergunta: string;
  fontes: string[];
  fatos: string[][];
  nota?: string;
  retrieval: Record<string, { rank: number | null; docs: string[] }>;
  answer: null | {
    text?: string;
    pass: boolean;
    factsOk?: boolean;
    factsFound?: boolean[];
    citations?: { valid: number[]; invalid: number[] };
    citedExpected?: boolean;
    abstained?: boolean;
    sources?: { n: number; docId: string | null; title: string; subject: string; pages: string | null; heading: string | null }[];
    latencyMs?: number;
    model?: string;
    error?: string;
  };
}

export interface EvalReport {
  date: string;
  label: string | null;
  set: string;
  k: number;
  embedding: string;
  generator: string | null;
  retrieval: Record<string, RetrievalMetrics>;
  answers: null | {
    n: number;
    pass: number | null;
    factsOk: number | null;
    citedExpected: number | null;
    invalidCitations: number;
    abstainedCorrectly: number | null;
    falseAbstentions: number;
    medianLatencyMs: number;
  };
  items: EvalItemResult[];
}

let demoMode: boolean | null = null;

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export async function getHealth(): Promise<Health> {
  try {
    const h = await json<Health>("api/health");
    demoMode = false;
    return h;
  } catch {
    demoMode = true;
    return json<Health>("demo/health.json");
  }
}

export const isDemo = () => demoMode === true;

export async function getDocuments(): Promise<DocumentRow[]> {
  const r = await json<{ documents: DocumentRow[] }>(isDemo() ? "demo/documents.json" : "api/documents");
  return r.documents;
}

let demoChunks: Promise<ChunkRow[]> | null = null;
export async function getChunks(docId: string): Promise<ChunkRow[]> {
  if (isDemo()) {
    demoChunks ??= json<{ chunks: ChunkRow[] }>("demo/chunks.json").then((r) => r.chunks);
    return (await demoChunks).filter((c) => c.doc_id === docId);
  }
  return (await json<{ chunks: ChunkRow[] }>(`api/documents/${encodeURIComponent(docId)}/chunks`)).chunks;
}

export async function getGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  return json(isDemo() ? "demo/graph.json" : "api/graph");
}

export async function getEval(): Promise<EvalReport | null> {
  try {
    return await json<EvalReport>(isDemo() ? "demo/eval.json" : "api/eval/latest");
  } catch {
    return null;
  }
}

export interface AskHandlers {
  onSources: (s: Source[]) => void;
  onDelta: (t: string) => void;
  onDone: (d: DoneInfo) => void;
  onError: (m: string) => void;
}

/** Lê o stream SSE de POST /api/ask (EventSource não aceita POST, então o parser é manual). */
export async function ask(
  body: { question: string; history: { role: "user" | "assistant"; content: string }[]; publicOnly?: boolean },
  h: AskHandlers,
  signal: AbortSignal,
) {
  const res = await fetch("api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    h.onError(`A API respondeu ${res.status}`);
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === "sources") h.onSources(payload);
      else if (event === "delta") h.onDelta(payload.text);
      else if (event === "done") h.onDone(payload);
      else if (event === "error") h.onError(payload.message);
    }
  }
}

export const SECTION_LABEL: Record<string, string> = {
  syllabus: "Ementa",
  exams: "Prova",
  exercises: "Lista",
  notes: "Notas de aula",
  bibliography: "Referência",
  flashcards: "Flashcards",
  ecossistema: "UÉFIabecê",
  grafo: "Grafo",
  outros: "Outros",
};
