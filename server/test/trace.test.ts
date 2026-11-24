import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { traceGeneration } from "../src/answer.js";
import type { Generator } from "../src/generate.js";
import { withSpan } from "../src/trace.js";

// Provedor em memória: exercita os spans sem OTEL_EXPORTER_OTLP_ENDPOINT e sem rede.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});
beforeEach(() => exporter.reset());

const generator: Generator = {
  provider: "openai",
  model: "falso",
  async stream(_system, _messages, onText) {
    onText("Resposta ");
    onText("[1].");
    return { text: "Resposta [1].", model: "falso-2026", stopReason: "stop", usage: { inputTokens: 120, outputTokens: 7 } };
  },
};

describe("spans", () => {
  it("geração leva as convenções gen_ai.* e marca o primeiro token uma vez", async () => {
    const deltas: string[] = [];
    await traceGeneration(generator, "rag.geracao", (onText) => generator.stream("", [], onText), (d) => deltas.push(d));
    const [span] = exporter.getFinishedSpans();
    expect(deltas).toEqual(["Resposta ", "[1]."]);
    expect(span!.name).toBe("rag.geracao");
    expect(span!.attributes).toMatchObject({
      "gen_ai.system": "openai",
      "gen_ai.request.model": "falso",
      "gen_ai.response.model": "falso-2026",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 7,
    });
    expect(span!.events.map((e) => e.name)).toEqual(["primeiro_token"]);
  });

  it("etapas aninhadas ficam no mesmo trace, e o erro marca o span sem ser engolido", async () => {
    await expect(
      withSpan("rag.resposta", {}, () => withSpan("rag.busca", {}, async () => Promise.reject(new Error("banco fora")))),
    ).rejects.toThrow("banco fora");
    const spans = exporter.getFinishedSpans();
    const busca = spans.find((s) => s.name === "rag.busca")!;
    const resposta = spans.find((s) => s.name === "rag.resposta")!;
    expect(busca.spanContext().traceId).toBe(resposta.spanContext().traceId);
    expect(busca.parentSpanContext?.spanId).toBe(resposta.spanContext().spanId);
    expect(busca.status.message).toBe("banco fora");
  });
});
