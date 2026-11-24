import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { answer } from "./answer.js";
import { convene, loadCouncil, professorCoverage, selectProfessors } from "./council.js";
import { ROOT, settings } from "./config.js";
import { costSummary, recordQuery, type GenerationRecord } from "./cost.js";
import { getDb } from "./db.js";
import { getGenerator } from "./generate.js";
import { loadGraph } from "./graph.js";
import { search } from "./retrieve.js";
import { flushTracing, initTracing } from "./trace.js";
import { getTrace, listTraces, stageStats } from "./traces.js";

const app = Fastify({ logger: { level: "info" } });

const csv = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const SearchQuery = z.object({
  q: z.string().min(2),
  k: z.coerce.number().int().min(1).max(30).default(8),
  repo: z.string().optional(),
  section: z.string().optional(),
  mode: z.enum(["hybrid", "vector", "lexical"]).default("hybrid"),
  public: z.enum(["0", "1"]).optional(),
});

const AskBody = z.object({
  question: z.string().min(2).max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
    .max(20)
    .default([]),
  repos: z.array(z.string()).optional(),
  sections: z.array(z.string()).optional(),
  publicOnly: z.boolean().optional(),
});

app.get("/api/health", async () => {
  const db = await getDb();
  const [docs, chunks, nodes, embedding] = await Promise.all([
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents"),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM chunks"),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM graph_nodes"),
    db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding'"),
  ]);
  const generator = getGenerator();
  return {
    ok: true,
    database: db.kind,
    documents: docs.rows[0]?.n ?? 0,
    chunks: chunks.rows[0]?.n ?? 0,
    graphNodes: nodes.rows[0]?.n ?? 0,
    embedding: embedding.rows[0]?.value ?? null,
    generator: `${generator.provider}:${generator.model}`,
    publicOnly: settings.publicOnly,
  };
});

/** Busca sem geração: é o que os servidores MCP chamam, porque quem escreve a resposta lá é o LLM do cliente. */
app.get("/api/search", async (req, reply) => {
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const { q, k, repo, section, mode } = parsed.data;
  const started = Date.now();
  const hits = await search(q, { k, mode, repos: csv(repo), sections: csv(section), publicOnly: parsed.data.public === "1" });
  return { query: q, tookMs: Date.now() - started, hits };
});

app.get("/api/documents", async (req) => {
  const publicOnly = (req.query as { public?: string }).public === "1" || settings.publicOnly;
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT d.id, d.repo, d.path, d.section, d.subject, d.course, d.visibility, d.format, d.title,
            d.pages, d.chars, d.quality, d.ingested_at, count(c.id)::int AS chunks, coalesce(sum(c.tokens), 0)::int AS tokens
       FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id
      ${publicOnly ? "WHERE d.visibility = 'publico'" : ""}
      GROUP BY d.id ORDER BY d.repo, d.path`,
  );
  return { documents: rows };
});

app.get("/api/documents/:id/chunks", async (req) => {
  const { id } = req.params as { id: string };
  const db = await getDb();
  const { rows } = await db.query(
    `SELECT c.ord, c.heading, c.page_start, c.page_end, c.text, c.tokens
       FROM chunks c JOIN documents d ON d.id = c.doc_id
      WHERE c.doc_id = $1 ${settings.publicOnly ? "AND d.visibility = 'publico'" : ""}
      ORDER BY c.ord`,
    [id],
  );
  return { chunks: rows };
});

app.get("/api/graph", async (req) => loadGraph((req.query as { public?: string }).public === "1"));

app.get("/api/eval/latest", async (req, reply) => {
  const file = path.join(ROOT, "eval", "resultados", "latest.json");
  if (!existsSync(file)) return reply.code(404).send({ error: "Nenhuma avaliação rodada ainda (npm run eval)." });
  return JSON.parse(readFileSync(file, "utf8"));
});

/**
 * Pergunta com resposta em streaming (Server-Sent Events):
 *   event: sources  → fontes recuperadas, antes de qualquer token
 *   event: delta    → pedaço de texto
 *   event: done     → citações validadas, modelo, uso e latências
 *   event: error    → falha no meio do caminho
 */
app.post("/api/ask", async (req, reply) => {
  const parsed = AskBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const { question, history, repos, sections, publicOnly } = parsed.data;

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const result = await answer(question, history, { repos, sections, publicOnly }, {
      onSources: (sources) => send("sources", sources),
      onText: (delta) => send("delta", { text: delta }),
      signal: abort.signal,
    });
    send("done", {
      citations: result.citations,
      model: result.model,
      provider: result.provider,
      stopReason: result.stopReason,
      usage: result.usage,
      latencyMs: result.latencyMs,
      retrievalMs: result.retrievalMs,
      costUsd: result.costUsd,
    });
    record(req.log, "resposta", [
      { etapa: null, provider: result.provider, model: result.model, usage: result.usage, costUsd: result.costUsd, latencyMs: result.latencyMs - result.retrievalMs },
    ]);
  } catch (err) {
    if (!abort.signal.aborted) {
      req.log.error(err);
      send("error", { message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    res.end();
  }
});

const CouncilBody = z.object({
  question: z.string().min(2).max(2000),
  professors: z.array(z.string()).max(5).optional(),
  publicOnly: z.boolean().optional(),
});

app.get("/api/council", async (req) => {
  const publicOnly = (req.query as { public?: string }).public === "1";
  const { padrao, grupos } = loadCouncil();
  return { padrao, grupos, professores: await professorCoverage(publicOnly) };
});

/**
 * Conselho de professores em SSE. Os professores escrevem em paralelo, então cada evento diz de
 * quem é: professores → sources (por professor) → delta (por professor, intercalados) →
 * perspectiva (fim de cada um) → delta/perspectiva da síntese → done.
 */
app.post("/api/council", async (req, reply) => {
  const parsed = CouncilBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  try {
    selectProfessors(loadCouncil(), parsed.data.professors);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    const calls = await convene(parsed.data.question, {
      professors: parsed.data.professors,
      publicOnly: parsed.data.publicOnly,
      signal: abort.signal,
      onEvent: (e) => {
        const { type, ...data } = e;
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      },
    });
    record(req.log, "conselho", calls);
  } catch (err) {
    if (!abort.signal.aborted) {
      req.log.error(err);
      res.write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`);
    }
  } finally {
    res.end();
  }
});

/** Registrar custo é acessório: se o banco falhar aqui, a resposta já foi entregue e só o log reclama. */
function record(log: { error: (o: unknown, msg?: string) => void }, tipo: "resposta" | "conselho", calls: GenerationRecord[]) {
  if (calls.length) recordQuery(tipo, calls).catch((err) => log.error(err, "falha ao registrar o custo da consulta"));
}

/** Custo por provedor/modelo, por tipo de consulta e das últimas consultas. Só metadados, sem texto. */
app.get("/api/custos", async (req) => {
  const limit = Number((req.query as { limit?: string }).limit ?? 20);
  return costSummary(Number.isFinite(limit) ? limit : 20);
});

/**
 * Traces gravados localmente (aba Observabilidade). Mesmos atributos do OTLP: sem texto de trecho e
 * com docId privado mascarado, então não há filtro de visibilidade a aplicar aqui.
 */
const Limit = z.coerce.number().int().min(1).max(500);

app.get("/api/traces", async (req, reply) => {
  const limit = Limit.default(50).safeParse((req.query as { limit?: string }).limit);
  if (!limit.success) return reply.code(400).send({ error: "limit deve ser um inteiro entre 1 e 500." });
  return { traces: await listTraces(limit.data) };
});

app.get("/api/traces/etapas", async (req, reply) => {
  const last = Limit.default(200).safeParse((req.query as { ultimos?: string }).ultimos);
  if (!last.success) return reply.code(400).send({ error: "ultimos deve ser um inteiro entre 1 e 500." });
  return stageStats(last.data);
});

app.get("/api/traces/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^[0-9a-f]{32}$/.test(id)) return reply.code(400).send({ error: "Id de trace inválido (32 caracteres hexadecimais)." });
  const spans = await getTrace(id);
  if (!spans.length) return reply.code(404).send({ error: "Trace não encontrado; só os mais recentes ficam guardados." });
  return { traceId: id, spans };
});

const shutdown = async () => {
  await app.close();
  await flushTracing();
  await (await getDb()).close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await initTracing();
await getDb();
await app.listen({ host: "127.0.0.1", port: settings.port });
