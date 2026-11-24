import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { settings } from "./config.js";

/**
 * Spans por etapa do RAG via OpenTelemetry. Dois destinos, independentes: o banco local (tabela `spans`,
 * para a aba Observabilidade) e um coletor OTLP (Jaeger, Langfuse) se OTEL_EXPORTER_OTLP_ENDPOINT existir.
 * Sem initTracing, a API do OTel vira no-op: os testes seguem sem rede e sem banco.
 *
 * Os trechos recuperados nunca entram nos spans: o destino (Langfuse, Jaeger) é um serviço à parte e
 * o acervo privado tem direitos autorais. Pergunta e resposta só entram com OTEL_CAPTURE_CONTENT=1.
 */
const tracer = trace.getTracer("ufabc-rag");

let shutdown: (() => Promise<void>) | null = null;

/**
 * `local: false` para comandos cujo tráfego não é uso real (eval, ingestão): não poluem a aba com
 * centenas de buscas de medição. O OTLP, se configurado, recebe tudo.
 */
export async function initTracing(opts: { local?: boolean; serviceName?: string } = {}): Promise<void> {
  const local = (opts.local ?? true) && settings.tracing.local;
  if ((!settings.tracing.endpoint && !local) || shutdown) return;
  // Import dinâmico: o SDK só carrega quando há para onde exportar.
  const [{ NodeTracerProvider, BatchSpanProcessor }, { resourceFromAttributes }] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/resources"),
  ]);
  const processors = [];
  if (local) {
    const { DbSpanExporter } = await import("./traces.js");
    // Lote curto: a aba mostra o trace logo depois da resposta.
    processors.push(new BatchSpanProcessor(new DbSpanExporter(), { scheduledDelayMillis: 500 }));
  }
  if (settings.tracing.endpoint) {
    // O exportador lê OTEL_EXPORTER_OTLP_ENDPOINT e OTEL_EXPORTER_OTLP_HEADERS sozinho.
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": opts.serviceName ?? "ufabc-rag" }),
    spanProcessors: processors,
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
