import { getGenerator, type ChatTurn, type Generator } from "./generate.js";
import { graphContext } from "./graph.js";
import { search, type Hit, type SearchFilters } from "./retrieve.js";

export const SECTION_LABEL: Record<string, string> = {
  syllabus: "ementa / plano de ensino",
  exams: "prova",
  exercises: "lista de exercícios",
  notes: "notas de aula",
  bibliography: "documento de referência",
  flashcards: "flashcards",
  ecossistema: "documentação UÉFIabecê",
  grafo: "grafo de contexto",
};

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

export interface AnswerResult {
  text: string;
  sources: Source[];
  citations: { valid: number[]; invalid: number[] };
  model: string;
  provider: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
  retrievalMs: number;
}

export interface AnswerCallbacks {
  onSources?: (sources: Source[]) => void;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export const SYSTEM_PROMPT = `Você é o assistente do acervo UÉFIabecê: ementas, PPCs, provas antigas, listas, notas de aula e bibliografias de cursos da UFABC.

Responda apenas com o que está nas fontes numeradas que acompanham cada pergunta. Depois de cada afirmação, cite a fonte entre colchetes, como [2] ou [1][3]. Não cite números que não estejam na lista.

Se as fontes não respondem à pergunta, diga isso com clareza e indique que tipo de documento resolveria (por exemplo, o catálogo de disciplinas ou a coordenação do curso). Não complete com conhecimento geral, mesmo que pareça óbvio: o aluno vai tomar decisões de matrícula com base no que você disser.

Distinga documentos oficiais (PPC, ementa, catálogo, planejamento de oferta) de material de estudo (listas, notas, flashcards, resumos feitos por alunos). Quando houver versões diferentes, como PPC 2015 e PPC 2023, diga a qual delas cada informação pertence.

Para exercícios e provas, explique o raciocínio passo a passo, ainda citando de onde vem o enunciado. Escreva em português, de forma direta, usando listas só quando houver itens de fato.`;

function pagesLabel(h: Pick<Hit, "pageStart" | "pageEnd">): string | null {
  if (!h.pageStart) return null;
  return h.pageEnd && h.pageEnd !== h.pageStart ? `p. ${h.pageStart}–${h.pageEnd}` : `p. ${h.pageStart}`;
}

export function toSources(hits: Hit[], graph: string | null): Source[] {
  const sources: Source[] = hits.map((h, i) => ({
    n: i + 1,
    kind: "trecho",
    docId: h.docId,
    repo: h.repo,
    title: h.title,
    subject: h.subject,
    section: h.section,
    heading: h.heading,
    pages: pagesLabel(h),
    visibility: h.visibility,
    text: h.text,
    score: h.score,
  }));
  if (graph) {
    sources.push({
      n: sources.length + 1,
      kind: "grafo",
      docId: null,
      repo: null,
      title: "Grafo de contexto (extraído das ementas)",
      subject: "Acervo",
      section: "grafo",
      heading: null,
      pages: null,
      visibility: "publico",
      text: graph,
      score: null,
    });
  }
  return sources;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function renderSources(sources: Source[]): string {
  return sources
    .map((s) => {
      const attrs = [
        `n="${s.n}"`,
        `disciplina="${escapeAttr(s.subject)}"`,
        `documento="${escapeAttr(s.title)}"`,
        `tipo="${SECTION_LABEL[s.section] ?? s.section}"`,
        s.heading ? `secao="${escapeAttr(s.heading)}"` : "",
        s.pages ? `paginas="${s.pages}"` : "",
      ].filter(Boolean);
      return `<fonte ${attrs.join(" ")}>\n${s.text}\n</fonte>`;
    })
    .join("\n\n");
}

export function parseCitations(text: string, sourceCount: number): { valid: number[]; invalid: number[] } {
  const found = new Set<number>();
  for (const m of text.matchAll(/\[(\d+(?:\s*[,;–-]\s*\d+)*)\]/g)) {
    const inner = m[1]!;
    const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(inner);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]) && n - Number(range[1]) < 20; n++) found.add(n);
    } else {
      for (const n of inner.split(/[,;]/)) found.add(Number(n.trim()));
    }
  }
  const all = [...found].sort((a, b) => a - b);
  return { valid: all.filter((n) => n >= 1 && n <= sourceCount), invalid: all.filter((n) => n < 1 || n > sourceCount) };
}

/** Em conversa, a pergunta de seguimento ("e a bibliografia?") sozinha não acha nada; junta com a anterior. */
export function retrievalQuery(question: string, history: ChatTurn[]): string {
  const lastUser = [...history].reverse().find((t) => t.role === "user");
  return lastUser && question.length < 80 ? `${lastUser.content}\n${question}` : question;
}

export async function answer(
  question: string,
  history: ChatTurn[] = [],
  filters: SearchFilters = {},
  cb: AnswerCallbacks = {},
  generator: Generator = getGenerator(),
  k = 8,
): Promise<AnswerResult> {
  const started = Date.now();
  const query = retrievalQuery(question, history);
  const [hits, graph] = await Promise.all([search(query, { ...filters, k }), graphContext(query, filters)]);
  const sources = toSources(hits, graph);
  const retrievalMs = Date.now() - started;
  cb.onSources?.(sources);

  const user = `<fontes>\n${renderSources(sources)}\n</fontes>\n\n<pergunta>\n${question}\n</pergunta>`;
  const messages: ChatTurn[] = [...history.slice(-6), { role: "user", content: user }];
  const result = await generator.stream(SYSTEM_PROMPT, messages, (d) => cb.onText?.(d), cb.signal);

  let text = result.text;
  if (result.stopReason === "refusal" && !text.trim()) {
    text = "O modelo recusou esta pergunta. Tente reformulá-la.";
    cb.onText?.(text);
  }
  return {
    text,
    sources,
    citations: parseCitations(text, sources.length),
    model: result.model,
    provider: generator.provider,
    stopReason: result.stopReason,
    usage: result.usage,
    latencyMs: Date.now() - started,
    retrievalMs,
  };
}
