import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { answer, type Source } from "./answer.js";
import { ROOT } from "./config.js";
import { getDb } from "./db.js";
import { getGenerator } from "./generate.js";
import { DEFAULT_LEXICAL_WEIGHT, search } from "./retrieve.js";

export interface EvalItem {
  id: string;
  conjunto: "publico" | "privado";
  tipo: string;
  pergunta: string;
  /** Prefixos de docId: o item acerta a recuperação se algum trecho vier de um desses documentos. */
  fontes: string[];
  /** Cada grupo precisa aparecer na resposta; dentro do grupo, qualquer alternativa vale. */
  fatos: string[][];
  nota?: string;
}

const MODES = ["hybrid", "vector", "lexical"] as const;
const K = 8;

const ABSTAIN =
  /n[aã]o (encontrei|h[aá] (informa|men[cç]|dado|registro)|consta|aparece|traz|trazem|cont[eé]m|informa|menciona|mencionam|est[aá] (nas|no|entre)|foi poss[ií]vel|tenho|disp[oõ]e)|nenhuma (das fontes|fonte)|as fontes (fornecidas |dispon[ií]veis )?n[aã]o|acervo n[aã]o|fora do (escopo|acervo)/i;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, "");

export function factsFound(text: string, groups: string[][]): boolean[] {
  const t = norm(text);
  return groups.map((alts) => alts.some((a) => t.includes(norm(a))));
}

export function abstained(text: string): boolean {
  return ABSTAIN.test(text);
}

function firstRelevantRank(docIds: string[], expected: string[]): number | null {
  const i = docIds.findIndex((id) => expected.some((e) => id.startsWith(e)));
  return i >= 0 ? i + 1 : null;
}

interface RetrievalMetrics {
  hit1: number;
  hit3: number;
  hit8: number;
  mrr: number;
  n: number;
}

function summarizeRetrieval(ranks: (number | null)[]): RetrievalMetrics {
  const n = ranks.length || 1;
  const within = (k: number) => ranks.filter((r) => r !== null && r <= k).length / n;
  return {
    hit1: within(1),
    hit3: within(3),
    hit8: within(K),
    mrr: ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n,
    n: ranks.length,
  };
}

export interface EvalOptions {
  set: "publico" | "privado" | "todos";
  limit?: number;
  answers: boolean;
  label?: string;
  log?: (line: string) => void;
}

export async function runEval(opts: EvalOptions) {
  const log = opts.log ?? (() => {});
  const items = readFileSync(path.join(ROOT, "eval", "perguntas.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalItem)
    .filter((it) => opts.set === "todos" || it.conjunto === opts.set)
    .slice(0, opts.limit);
  const publicOnly = opts.set === "publico";
  const db = await getDb();
  const embedding = (await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding'")).rows[0]?.value;
  const generator = opts.answers ? getGenerator() : null;

  const results = [];
  const ranks: Record<(typeof MODES)[number], (number | null)[]> = { hybrid: [], vector: [], lexical: [] };

  for (const item of items) {
    const answerable = item.fontes.length > 0;
    const retrieval: Record<string, { rank: number | null; docs: string[] }> = {};
    for (const mode of MODES) {
      const hits = await search(item.pergunta, { k: K, mode, publicOnly });
      const docs = hits.map((h) => h.docId);
      const rank = answerable ? firstRelevantRank(docs, item.fontes) : null;
      retrieval[mode] = { rank, docs };
      if (answerable) ranks[mode].push(rank);
    }

    let graded: Record<string, unknown> | null = null;
    if (generator) {
      try {
        const r = await answer(item.pergunta, [], { publicOnly }, {}, generator, K);
        const found = factsFound(r.text, item.fatos);
        const cited = r.citations.valid.map((n) => r.sources[n - 1]).filter((s): s is Source => !!s);
        const didAbstain = abstained(r.text);
        const factsOk = found.every(Boolean);
        const citedExpected = cited.some((s) => s.docId && item.fontes.some((e) => s.docId!.startsWith(e)));
        const pass = answerable
          ? factsOk && r.citations.valid.length > 0 && r.citations.invalid.length === 0
          : didAbstain && r.citations.invalid.length === 0;
        graded = {
          text: r.text,
          pass,
          factsOk,
          factsFound: found,
          citations: r.citations,
          citedExpected,
          abstained: didAbstain,
          sources: r.sources.map((s) => ({ n: s.n, docId: s.docId, title: s.title, subject: s.subject, pages: s.pages, heading: s.heading })),
          latencyMs: r.latencyMs,
          usage: r.usage,
          model: r.model,
        };
      } catch (err) {
        graded = { error: err instanceof Error ? err.message : String(err), pass: false };
      }
    }
    const mark = graded ? (graded.pass ? "✓" : "✗") : " ";
    log(`${mark} ${item.id.padEnd(8)} híbrida ${String(retrieval.hybrid!.rank ?? "–").padStart(2)}  vetorial ${String(retrieval.vector!.rank ?? "–").padStart(2)}  léxica ${String(retrieval.lexical!.rank ?? "–").padStart(2)}  ${item.pergunta}`);
    results.push({ ...item, retrieval, answer: graded });
  }

  const retrievalSummary = Object.fromEntries(MODES.map((m) => [m, summarizeRetrieval(ranks[m])]));
  const answered = results.filter((r) => r.answer && !("error" in r.answer));
  const answerable = answered.filter((r) => r.fontes.length > 0);
  const outOfScope = answered.filter((r) => r.fontes.length === 0);
  const rate = (xs: unknown[], pred: (x: (typeof answered)[number]) => boolean) =>
    xs.length ? (xs as typeof answered).filter(pred).length / xs.length : null;
  const answersSummary = generator
    ? {
        n: answered.length,
        errors: results.length - answered.length,
        pass: rate(answered, (r) => !!r.answer?.pass),
        factsOk: rate(answerable, (r) => !!r.answer?.factsOk),
        citedExpected: rate(answerable, (r) => !!r.answer?.citedExpected),
        invalidCitations: answered.reduce((s, r) => s + ((r.answer?.citations as { invalid: number[] }).invalid.length ?? 0), 0),
        abstainedCorrectly: rate(outOfScope, (r) => !!r.answer?.abstained),
        falseAbstentions: answerable.filter((r) => r.answer?.abstained && !r.answer?.factsOk).length,
        medianLatencyMs: median(answered.map((r) => Number(r.answer?.latencyMs ?? 0))),
      }
    : null;

  const report = {
    date: new Date().toISOString(),
    label: opts.label ?? null,
    set: opts.set,
    k: K,
    lexicalWeight: DEFAULT_LEXICAL_WEIGHT,
    embedding,
    generator: generator ? `${generator.provider}:${generator.model}` : null,
    retrieval: retrievalSummary,
    answers: answersSummary,
    items: results,
  };

  // Resultados do conjunto privado citam documentos que não são públicos: ficam fora do git.
  const dir = path.join(ROOT, "eval", "resultados", opts.set === "publico" ? "" : "privado");
  mkdirSync(dir, { recursive: true });
  const stamp = report.date.slice(0, 16).replace(/[:T]/g, "-");
  const name = `${opts.set}-${stamp}${opts.label ? `-${opts.label}` : ""}.json`;
  writeFileSync(path.join(dir, name), JSON.stringify(report, null, 2));
  if (opts.set === "publico") writeFileSync(path.join(dir, "latest.json"), JSON.stringify(report, null, 2));

  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "  –  " : `${(x * 100).toFixed(0).padStart(3)}%`);
  log("\nRecuperação (documento esperado entre os trechos devolvidos)");
  log("            hit@1  hit@3  hit@8   MRR");
  for (const m of MODES) {
    const s = retrievalSummary[m]!;
    log(`  ${m.padEnd(9)} ${pct(s.hit1)}  ${pct(s.hit3)}  ${pct(s.hit8)}  ${s.mrr.toFixed(2)}`);
  }
  if (answersSummary) {
    log(`\nRespostas (${report.generator})`);
    log(`  aprovadas ${pct(answersSummary.pass)} · fatos ${pct(answersSummary.factsOk)} · cita a fonte esperada ${pct(answersSummary.citedExpected)}`);
    log(`  abstenção correta fora do acervo ${pct(answersSummary.abstainedCorrectly)} · abstenções indevidas ${answersSummary.falseAbstentions} · citações inválidas ${answersSummary.invalidCitations}`);
    log(`  latência mediana ${answersSummary.medianLatencyMs} ms`);
  }
  log(`\nSalvo em ${path.relative(ROOT, path.join(dir, name))}`);
  return report;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
