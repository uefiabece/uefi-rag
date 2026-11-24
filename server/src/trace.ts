import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { settings } from "./config.js";

/**
 * Spans por etapa do RAG via OpenTelemetry. Sem OTEL_EXPORTER_OTLP_ENDPOINT nada é registrado e a
 * API do OTel vira no-op: testes e uso local seguem sem rede e sem custo.
 *
 * Os trechos recuperados nunca entram nos spans: o destino (Langfuse, Jaeger) é um serviço à parte e
 * o acervo privado tem direitos autorais. Pergunta e resposta só entram com OTEL_CAPTURE_CONTENT=1.
 */
const tracer = trace.getTracer("ufabc-rag");

let shutdown: (() => Promise<void>) | null = null;

export async function initTracing(serviceName = "ufabc-rag"): Promise<void> {
  if (!settings.tracing.endpoint || shutdown) return;
  // Import dinâmico: o SDK só carrega quando há para onde exportar.
  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  // O exportador lê OTEL_EXPORTER_OTLP_ENDPOINT e OTEL_EXPORTER_OTLP_HEADERS sozinho.
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": serviceName }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  shutdown = () => provider.shutdown();
}

/** Envia os spans pendentes; os comandos de terminal saem antes do lote do BatchSpanProcessor. */
export async function flushTracing(): Promise<void> {
  await shutdown?.();
  shutdown = null;
}

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Etapas síncronas e baratas (RRF, validação de citações) também viram span, para o trace mostrar o pipeline inteiro. */
export function withSpanSync<T>(name: string, attributes: Attributes, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      return fn(span);
    } finally {
      span.end();
    }
  });
}

export function contentAttributes(attrs: Record<string, string>): Attributes {
  return settings.tracing.captureContent ? attrs : {};
}
