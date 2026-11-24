import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { SpanStatusCode } from "@opentelemetry/api";
import { getDb } from "./db.js";

/**
 * Traces gravados no próprio banco (tabela `spans`), para a aba Observabilidade funcionar sem Jaeger
 * nem Langfuse. Os atributos são os mesmos que vão por OTLP: nunca texto de trecho nem docId privado.
 */
export const MAX_TRACES = 500;

export interface SpanRow {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  startMs: number;
  durationMs: number;
  status: "ok" | "erro";
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; offsetMs: number }[];
}

export function spanToRow(span: ReadableSpan): SpanRow {
  const startMs = hrTimeToMilliseconds(span.startTime);
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    startMs,
    durationMs: hrTimeToMilliseconds(span.duration),
    status: span.status.code === SpanStatusCode.ERROR ? "erro" : "ok",
    statusMessage: span.status.message ?? null,
    attributes: { ...span.attributes },
    events: span.events.map((e) => ({ name: e.name, offsetMs: hrTimeToMilliseconds(e.time) - startMs })),
  };
}

export class DbSpanExporter implements SpanExporter {
  private pending = Promise.resolve();

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    // Encadeado: lotes seguidos não disputam o banco, e shutdown() espera o último.
    this.pending = this.pending.then(async () => {
      try {
        await saveSpans(spans.map(spanToRow));
        done({ code: ExportResultCode.SUCCESS });
      } catch (err) {
        done({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
  }

  async shutdown(): Promise<void> {
    await this.pending;
  }

  async forceFlush(): Promise<void> {
    await this.pending;
  }
}

async function saveSpans(rows: SpanRow[]): Promise<void> {
  if (!rows.length) return;
  const db = await getDb();
  for (const r of rows) {
    await db.query(
      `INSERT INTO spans (trace_id, span_id, parent_id, name, start_ms, duration_ms, status, status_message, attributes, events)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [r.traceId, r.spanId, r.parentId, r.name, r.startMs, r.durationMs, r.status, r.statusMessage, JSON.stringify(r.attributes), JSON.stringify(r.events)],
    );
  }
  // Retenção: só os traces mais recentes; a raiz é o último span de um trace a terminar.
  if (rows.some((r) => r.parentId === null)) {
    await db.query(
      `DELETE FROM spans WHERE trace_id IN (
         SELECT trace_id FROM spans WHERE parent_id IS NULL ORDER BY start_ms DESC OFFSET ${MAX_TRACES}
       )`,
    );
  }
}

// ---------------------------------------------------------------- leitura

export interface TraceSummary {
  traceId: string;
  name: string;
  startMs: number;
  durationMs: number;
  status: "ok" | "erro";
  spans: number;
  errors: number;
  /** null se alguma geração bem-sucedida não tem preço; 0 em modelos gratuitos. */
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  invalidCitations: number;
  models: string[];
  professors: string[];
}

export async function listTraces(limit = 50): Promise<TraceSummary[]> {
  const db = await getDb();
  const { rows } = await db.query<{
    trace_id: string; name: string; start_ms: number; duration_ms: number; status: "ok" | "erro"; spans: number; errors: number;
    cost: number | null; unpriced: number; input: number; output: number; invalid: number; models: string[] | null; professors: unknown;
  }>(
    `SELECT r.trace_id, r.name, r.start_ms, r.duration_ms, r.status,
            count(s.span_id)::int AS spans,
            count(*) FILTER (WHERE s.status = 'erro')::int AS errors,
            coalesce(sum((s.attributes->>'gen_ai.usage.cost')::float8) FILTER (WHERE s.name = 'rag.geracao'), 0) AS cost,
            count(*) FILTER (WHERE s.name = 'rag.geracao' AND s.status = 'ok' AND NOT s.attributes ? 'gen_ai.usage.cost')::int AS unpriced,
            coalesce(sum((s.attributes->>'gen_ai.usage.input_tokens')::int) FILTER (WHERE s.name = 'rag.geracao'), 0)::int AS input,
            coalesce(sum((s.attributes->>'gen_ai.usage.output_tokens')::int) FILTER (WHERE s.name = 'rag.geracao'), 0)::int AS output,
            coalesce(sum((s.attributes->>'rag.citations.invalid')::int) FILTER (WHERE s.name = 'rag.citacoes'), 0)::int AS invalid,
            array_remove(array_agg(DISTINCT s.attributes->>'gen_ai.response.model'), NULL) AS models,
            r.attributes->'rag.council.professors' AS professors
       FROM spans r JOIN spans s ON s.trace_id = r.trace_id
      WHERE r.parent_id IS NULL
      GROUP BY r.trace_id, r.name, r.start_ms, r.duration_ms, r.status, r.attributes
      ORDER BY r.start_ms DESC
      LIMIT ${Math.max(1, Math.min(MAX_TRACES, Math.floor(limit)))}`,
  );
  return rows.map((r) => ({
    traceId: r.trace_id,
    name: r.name,
    startMs: Number(r.start_ms),
    durationMs: Number(r.duration_ms),
    status: r.status,
    spans: r.spans,
    errors: r.errors,
    costUsd: r.unpriced > 0 ? null : Number(r.cost),
    inputTokens: r.input,
    outputTokens: r.output,
    invalidCitations: r.invalid,
    models: r.models ?? [],
    professors: Array.isArray(r.professors) ? (r.professors as string[]) : [],
  }));
}

export async function getTrace(traceId: string): Promise<SpanRow[]> {
  const db = await getDb();
  const { rows } = await db.query<{
    trace_id: string; span_id: string; parent_id: string | null; name: string; start_ms: number; duration_ms: number;
    status: "ok" | "erro"; status_message: string | null; attributes: Record<string, unknown>; events: SpanRow["events"];
  }>("SELECT * FROM spans WHERE trace_id = $1 ORDER BY start_ms, span_id", [traceId]);
  return rows.map((r) => ({
    traceId: r.trace_id,
    spanId: r.span_id,
    parentId: r.parent_id,
    name: r.name,
    startMs: Number(r.start_ms),
    durationMs: Number(r.duration_ms),
    status: r.status,
    statusMessage: r.status_message,
    attributes: r.attributes,
    events: r.events,
  }));
}

export interface StageStats {
  name: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  errors: number;
}

/** Tempo por etapa nos últimos `lastTraces` traces: onde vai a latência e onde aparecem erros. */
export async function stageStats(lastTraces = 200): Promise<{ traces: number; stages: StageStats[] }> {
  const db = await getDb();
  const recent = `SELECT trace_id FROM spans WHERE parent_id IS NULL ORDER BY start_ms DESC LIMIT ${Math.max(1, Math.min(MAX_TRACES, Math.floor(lastTraces)))}`;
  const { rows } = await db.query<{ name: string; count: number; p50: number; p95: number; errors: number }>(
    `SELECT name, count(*)::int AS count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
            count(*) FILTER (WHERE status = 'erro')::int AS errors
       FROM spans WHERE trace_id IN (${recent})
      GROUP BY name ORDER BY p95 DESC`,
  );
  const traces = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${recent}) t`)).rows[0]?.n ?? 0;
  return { traces, stages: rows.map((r) => ({ name: r.name, count: r.count, p50Ms: Number(r.p50), p95Ms: Number(r.p95), errors: r.errors })) };
}
