import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { traceGeneration } from "../src/answer.js";
import { convene } from "../src/council.js";
import type { Generator } from "../src/generate.js";
import { withSpan } from "../src/trace.js";
import { spanToRow } from "../src/traces.js";

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

  it("conselho vira um trace só: um ramo por professor em paralelo e a síntese depois", async () => {
    // Professores sem repositório não tocam o banco; o atraso deixa os ramos visivelmente sobrepostos.
    const slow: Generator = {
      provider: "ollama",
      model: "falso",
      async stream(system, _messages, onText) {
        await new Promise((r) => setTimeout(r, 20));
        if (system.includes("professor de História")) throw new Error("caiu");
        const text = system.startsWith("Você media") ? "Convergem." : "Ponto [geral].";
        onText(text);
        return { text, model: "falso", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    await convene("Pergunta", { professors: ["computacao", "economia", "historia"], generator: slow, onEvent: () => {} });
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "rag.conselho")!;
    const childrenOf = (id: string) => spans.filter((s) => s.parentSpanContext?.spanId === id);
    const branches = childrenOf(root.spanContext().spanId).filter((s) => s.name === "rag.conselho.professor");

    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(branches.map((b) => b.attributes["rag.professor.id"]).sort()).toEqual(["computacao", "economia", "historia"]);
    for (const b of branches) expect(childrenOf(b.spanContext().spanId).map((s) => s.name)).toContain("rag.geracao");
    const t = (hr: [number, number]) => hr[0] * 1e3 + hr[1] / 1e6;
    const lastStart = Math.max(...branches.map((b) => t(b.startTime)));
    const firstEnd = Math.min(...branches.map((b) => t(b.endTime)));
    expect(lastStart).toBeLessThan(firstEnd);

    // O professor que falhou fica marcado no próprio ramo; o conselho segue e sintetiza com os outros dois.
    const historia = branches.find((b) => b.attributes["rag.professor.id"] === "historia")!;
    expect(historia.status.message).toBe("caiu");
    const sintese = childrenOf(root.spanContext().spanId).find((s) => s.name === "rag.conselho.sintese")!;
    // Tolerância de 1 ms: o relógio dos spans não tem resolução abaixo disso entre spans diferentes.
    expect(t(sintese.startTime)).toBeGreaterThanOrEqual(Math.max(...branches.map((b) => t(b.endTime))) - 1);
    expect(root.attributes).toMatchObject({ "rag.council.perspectives": 2, "rag.council.failed": 1, "gen_ai.usage.input_tokens": 30 });
  });

  it("span vira linha da tabela: pai, duração, status, atributos e eventos relativos ao início", async () => {
    await withSpan("rag.resposta", { "rag.k": 8 }, () =>
      withSpan("rag.geracao", { "gen_ai.request.model": "falso" }, async (span) => {
        await new Promise((r) => setTimeout(r, 15));
        span.addEvent("primeiro_token");
        throw new Error("caiu");
      }),
    ).catch(() => {});
    const spans = exporter.getFinishedSpans();
    const root = spanToRow(spans.find((s) => s.name === "rag.resposta")!);
    const gen = spanToRow(spans.find((s) => s.name === "rag.geracao")!);

    expect(root.parentId).toBeNull();
    expect(gen.parentId).toBe(root.spanId);
    expect(gen.traceId).toBe(root.traceId);
    expect(gen).toMatchObject({ status: "erro", statusMessage: "caiu", attributes: { "gen_ai.request.model": "falso" } });
    expect(root.attributes).toEqual({ "rag.k": 8 });
    expect(gen.durationMs).toBeGreaterThanOrEqual(10);
    expect(gen.startMs).toBeGreaterThanOrEqual(root.startMs);
    expect(gen.events.map((e) => e.name)).toContain("primeiro_token");
    const first = gen.events.find((e) => e.name === "primeiro_token")!;
    expect(first.offsetMs).toBeGreaterThanOrEqual(10);
    expect(first.offsetMs).toBeLessThanOrEqual(gen.durationMs);
    // Linha serializável: vai para jsonb.
    expect(JSON.parse(JSON.stringify(gen))).toEqual(gen);
  });
});
