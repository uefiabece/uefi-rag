/**
 * Conselho de professores: a mesma pergunta explicada por áreas diferentes, cada uma buscando no
 * acervo da própria área, seguida de uma síntese que mostra onde as perspectivas convergem e onde
 * divergem. Área sem material no acervo participa, mas o que disser sem fonte sai marcado [geral].
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCitations, renderSources, toSources, traceGeneration, type Source } from "./answer.js";
import { ROOT, settings } from "./config.js";
import { getDb } from "./db.js";
import type { Span } from "@opentelemetry/api";
import { getGenerator, type Generator } from "./generate.js";
import { search } from "./retrieve.js";
import { contentAttributes, withSpan, withSpanSync } from "./trace.js";

export interface Professor {
  id: string;
  grupo: string;
  area: string;
  titulo: string;
  /** Que cursos o professor representa, ex.: "Bacharelado em Física e Licenciatura em Física (pela LCNE)". */
  cursos: string;
  repos: string[];
  lente: string;
}

export interface CouncilConfig {
  padrao: string[];
  grupos: { id: string; nome: string }[];
  professores: Professor[];
}

export function loadCouncil(): CouncilConfig {
  return JSON.parse(readFileSync(path.join(ROOT, "conselho.config.json"), "utf8")) as CouncilConfig;
}

export function selectProfessors(config: CouncilConfig, ids?: string[]): Professor[] {
  const wanted = ids?.length ? ids : config.padrao;
  const unknown = wanted.filter((id) => !config.professores.some((p) => p.id === id));
  if (unknown.length) throw new Error(`Professor desconhecido: ${unknown.join(", ")}`);
  if (wanted.length < 2) throw new Error("Um conselho precisa de pelo menos dois professores.");
  if (wanted.length > 5) throw new Error("No máximo cinco professores por pergunta.");
  // Ordem da configuração, não do pedido: a mesma pergunta sempre lê na mesma ordem.
  return config.professores.filter((p) => wanted.includes(p.id));
}

/** Quantos documentos do acervo cada professor alcança, respeitando o filtro de visibilidade. */
export async function professorCoverage(publicOnly = false): Promise<(Professor & { documentos: number })[]> {
  const db = await getDb();
  const { rows } = await db.query<{ repo: string; n: number }>(
    `SELECT repo, count(*)::int AS n FROM documents ${publicOnly || settings.publicOnly ? "WHERE visibility = 'publico'" : ""} GROUP BY repo`,
  );
  const byRepo = new Map(rows.map((r) => [r.repo, r.n]));
  return loadCouncil().professores.map((p) => ({ ...p, documentos: p.repos.reduce((s, r) => s + (byRepo.get(r) ?? 0), 0) }));
}

// ---------------------------------------------------------------- prompts

export function professorPrompt(prof: Professor, colleagues: Professor[], hasSources: boolean): string {
  const others = colleagues.filter((c) => c.id !== prof.id).map((c) => c.area);
  // Só a inicial vai para minúscula: o nome do curso continua com maiúsculas ("professora de Engenharia de Energia").
  const titulo = prof.titulo.charAt(0).toLowerCase() + prof.titulo.slice(1);
  return `Você é ${titulo} da UFABC, representando ${prof.cursos}, e participa de um conselho de professores de áreas diferentes que explicam a mesma questão a um aluno. Também estão no conselho: ${others.join(", ")}.

Explique a questão pela lente da sua área: ${prof.lente}. Concentre-se no que a sua área enxerga e as outras não enxergariam; não tente cobrir a questão inteira, porque os colegas cobrem o resto.

${
  hasSources
    ? "Você recebe trechos do acervo da sua área. Quando uma afirmação vier deles, cite a fonte entre colchetes, como [2]."
    : "O acervo não tem material da sua área, então nenhuma afirmação sua terá fonte numerada."
}
Tudo o que vier do seu conhecimento geral da área, sem trecho que sustente, marque com [geral] no fim da frase. Nunca invente citação numérica, e só cite um trecho se ele disser de fato o que a frase afirma: o aluno precisa saber o que pode conferir no acervo e o que é a sua palavra.

Fatos sobre a UFABC (duração de curso, regras, créditos, disciplinas, quem ensina o quê) você só afirma se estiverem nos trechos. Se a pergunta pedir um fato assim e ele não estiver nos seus trechos, diga que isso é com os documentos do curso e explique apenas o que a sua área tem a dizer sobre a questão.

Fale como professor: nomeie o conceito central da sua área para essa questão, dê um exemplo concreto e, se couber, termine com uma pergunta que leve o aluno a pensar. Entre 120 e 250 palavras, em português, em prosa, sem títulos.`;
}

export const SYNTHESIS_PROMPT = `Você media um conselho de professores de áreas diferentes da UFABC. Recebe a pergunta de um aluno e a explicação de cada professor.

Escreva a síntese para o aluno, em três parágrafos curtos:
1. onde as áreas convergem;
2. onde divergem, se tensionam ou respondem a perguntas diferentes;
3. como as perspectivas se completam para entender a questão, e por onde o aluno poderia começar.

Não acrescente fatos novos: tudo o que disser precisa estar numa das explicações, e você se refere a elas pelo nome da área ("a Neurociência mostra…"). Quando a ideia de um professor veio de conhecimento geral, e não do acervo, preserve essa ressalva. Não use números entre colchetes. Até 220 palavras, em português.`;

export function countGeneral(text: string): number {
  return text.match(/\[geral\]/gi)?.length ?? 0;
}

export function renderPerspectives(
  items: { prof: Professor; text: string; cited: number; general: number; grounded: boolean }[],
): string {
  return items
    .map(({ prof, text, cited, general, grounded }) => {
      // Sem acervo, a perspectiva é geral por construção: a síntese não pode tratá-la como sustentada.
      const origem = grounded ? `citacoes_do_acervo="${cited}" afirmacoes_gerais="${general}"` : `origem="conhecimento geral, sem acervo"`;
      return `<perspectiva area="${prof.area}" ${origem}>\n${text}\n</perspectiva>`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------- execução

export type CouncilEvent =
  | { type: "professores"; professores: { id: string; area: string; titulo: string }[] }
  | { type: "sources"; professor: string; sources: Source[] }
  | { type: "delta"; professor: string; text: string }
  | {
      type: "perspectiva";
      professor: string;
      citations: { valid: number[]; invalid: number[] };
      general: number;
      /** Recebeu trechos do acervo? Sem trechos, a perspectiva inteira é conhecimento geral, marque o modelo ou não. */
      grounded: boolean;
      model: string | null;
      latencyMs: number;
      outputTokens: number | null;
      error?: string;
    }
  | { type: "done"; latencyMs: number; inputTokens: number; outputTokens: number };

export interface CouncilOptions {
  professors?: string[];
  publicOnly?: boolean;
  signal?: AbortSignal;
  onEvent: (e: CouncilEvent) => void;
  generator?: Generator;
  k?: number;
}

export const SYNTHESIS_ID = "sintese";

export async function convene(question: string, opts: CouncilOptions) {
  const generator = opts.generator ?? getGenerator();
  const professors = selectProfessors(loadCouncil(), opts.professors);
  const k = opts.k ?? 5;
  const rootAttrs = {
    "rag.council.professors": professors.map((p) => p.id),
    "rag.k": k,
    "rag.public_only": !!(opts.publicOnly || settings.publicOnly),
    ...contentAttributes({ "rag.question": question }),
  };
  // Um trace por conselho: um ramo por professor, todos em paralelo, e a síntese no fim.
  return withSpan("rag.conselho", rootAttrs, (root) => runCouncil(question, opts, generator, professors, k, root));
}

async function runCouncil(
  question: string,
  opts: CouncilOptions,
  generator: Generator,
  professors: Professor[],
  k: number,
  root: Span,
) {
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  opts.onEvent({ type: "professores", professores: professors.map(({ id, area, titulo }) => ({ id, area, titulo })) });

  // Cada professor busca só no acervo da própria área; as perspectivas rodam em paralelo.
  const results = await Promise.all(
    professors.map(async (prof) => {
      const t0 = Date.now();
      const branchAttrs = { "rag.professor.id": prof.id, "rag.professor.area": prof.area, "rag.professor.repos": prof.repos.length };
      try {
        // withSpan marca o ramo como erro e relança; o catch abaixo mantém o conselho de pé sem esse professor.
        return await withSpan("rag.conselho.professor", branchAttrs, async (span) => {
          const hits = prof.repos.length
            ? await search(question, { repos: prof.repos, k, perDoc: 2, publicOnly: opts.publicOnly })
            : [];
          const sources = toSources(hits, null);
          opts.onEvent({ type: "sources", professor: prof.id, sources });
          const user = `${sources.length ? `<fontes>\n${renderSources(sources)}\n</fontes>\n\n` : ""}<pergunta>\n${question}\n</pergunta>`;
          const r = await traceGeneration(
            generator,
            "rag.geracao",
            (onText) => generator.stream(professorPrompt(prof, professors, sources.length > 0), [{ role: "user", content: user }], onText, opts.signal),
            (text) => opts.onEvent({ type: "delta", professor: prof.id, text }),
            { "rag.professor.id": prof.id },
          );
          inputTokens += r.usage?.inputTokens ?? 0;
          outputTokens += r.usage?.outputTokens ?? 0;
          const { citations, general } = withSpanSync("rag.citacoes", { "rag.sources": sources.length }, (s) => {
            const c = { citations: parseCitations(r.text, sources.length), general: countGeneral(r.text) };
            s.setAttributes({
              "rag.citations.valid": c.citations.valid.length,
              "rag.citations.invalid": c.citations.invalid.length,
              "rag.citations.general": c.general,
            });
            return c;
          });
          span.setAttribute("rag.professor.grounded", sources.length > 0);
          opts.onEvent({
            type: "perspectiva",
            professor: prof.id,
            citations,
            general,
            grounded: sources.length > 0,
            model: r.model,
            latencyMs: Date.now() - t0,
            outputTokens: r.usage?.outputTokens ?? null,
          });
          return { prof, text: r.text, cited: citations.valid.length, general, grounded: sources.length > 0 };
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        opts.onEvent({
          type: "perspectiva",
          professor: prof.id,
          citations: { valid: [], invalid: [] },
          general: 0,
          grounded: false,
          model: null,
          latencyMs: Date.now() - t0,
          outputTokens: null,
          error: message,
        });
        return null;
      }
    }),
  );

  const ok = results.filter((r): r is NonNullable<typeof r> => r !== null && r.text.trim().length > 0);
  if (ok.length >= 2) {
    const t0 = Date.now();
    try {
      const r = await withSpan("rag.conselho.sintese", { "rag.council.perspectives": ok.length }, () =>
        traceGeneration(
          generator,
          "rag.geracao",
          (onText) =>
            generator.stream(
              SYNTHESIS_PROMPT,
              [{ role: "user", content: `<pergunta>\n${question}\n</pergunta>\n\n${renderPerspectives(ok)}` }],
              onText,
              opts.signal,
            ),
          (text) => opts.onEvent({ type: "delta", professor: SYNTHESIS_ID, text }),
        ),
      );
      inputTokens += r.usage?.inputTokens ?? 0;
      outputTokens += r.usage?.outputTokens ?? 0;
      opts.onEvent({
        type: "perspectiva",
        professor: SYNTHESIS_ID,
        citations: { valid: [], invalid: [] },
        general: 0,
        grounded: false,
        model: r.model,
        latencyMs: Date.now() - t0,
        outputTokens: r.usage?.outputTokens ?? null,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      opts.onEvent({
        type: "perspectiva",
        professor: SYNTHESIS_ID,
        citations: { valid: [], invalid: [] },
        general: 0,
        grounded: false,
        model: null,
        latencyMs: Date.now() - t0,
        outputTokens: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  root.setAttributes({
    "rag.council.perspectives": ok.length,
    "rag.council.failed": results.filter((r) => r === null).length,
    "gen_ai.usage.input_tokens": inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
  });
  opts.onEvent({ type: "done", latencyMs: Date.now() - started, inputTokens, outputTokens });
}
