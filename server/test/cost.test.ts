import { describe, expect, it } from "vitest";
import { costUsd, formatUsd, loadPrices, priceFor, sumCost } from "../src/cost.js";
import { convene, SYNTHESIS_ID, type CouncilEvent } from "../src/council.js";
import type { Generator } from "../src/generate.js";

const table = {
  "anthropic:claude-opus-5": { entrada: 5, saida: 25 },
  "anthropic:claude-opus-5-5": { entrada: 4, saida: 20 },
};

describe("preço por modelo", () => {
  it("Ollama e modelos :free do OpenRouter não custam nada", () => {
    expect(priceFor("ollama", "qwen2.5:7b", table)).toEqual({ entrada: 0, saida: 0 });
    expect(priceFor("openai", "nvidia/nemotron-3-ultra-550b-a55b:free", table)).toEqual({ entrada: 0, saida: 0 });
  });

  it("id mais específico que o da tabela cai no prefixo mais longo, sem confundir 5 com 5-5", () => {
    expect(priceFor("anthropic", "claude-opus-5", table)).toEqual({ entrada: 5, saida: 25 });
    expect(priceFor("anthropic", "claude-opus-5-20260401", table)).toEqual({ entrada: 5, saida: 25 });
    expect(priceFor("anthropic", "claude-opus-5-5", table)).toEqual({ entrada: 4, saida: 20 });
    expect(priceFor("anthropic", "claude-opus-5-5-20261001", table)).toEqual({ entrada: 4, saida: 20 });
  });

  it("modelo desconhecido não tem preço, em vez de sair grátis", () => {
    expect(priceFor("openai", "gpt-5", table)).toBeNull();
    // O mesmo nome noutro provedor não herda o preço.
    expect(priceFor("openai", "claude-opus-5", table)).toBeNull();
    expect(costUsd("openai", "gpt-5", { inputTokens: 1000, outputTokens: 100 }, table)).toBeNull();
  });

  it("custo = tokens × preço por milhão", () => {
    expect(costUsd("anthropic", "claude-opus-5", { inputTokens: 4000, outputTokens: 500 }, table)).toBeCloseTo(0.0325, 10);
    expect(costUsd("anthropic", "claude-opus-5", null, table)).toBeNull();
  });

  it("um total com parcela desconhecida é desconhecido", () => {
    expect(sumCost([0.01, 0.02])).toBeCloseTo(0.03, 10);
    expect(sumCost([0.01, null])).toBeNull();
    expect(sumCost([])).toBe(0);
  });

  it("formata frações de centavo com quatro casas e distingue grátis de sem preço", () => {
    expect(formatUsd(0.0325)).toBe("US$ 0,0325");
    expect(formatUsd(12.5)).toBe("US$ 12,50");
    expect(formatUsd(0)).toBe("grátis");
    expect(formatUsd(null)).toBe("sem preço");
  });

  it("precos.config.json só tem provedores conhecidos e preços não negativos", () => {
    for (const [key, p] of Object.entries(loadPrices().modelos)) {
      expect(key, key).toMatch(/^(anthropic|openai):[\w.\-/:]+$/);
      expect(p.entrada, key).toBeGreaterThanOrEqual(0);
      expect(p.saida, key).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("custo do conselho", () => {
  it("cada perspectiva traz o próprio custo, o done traz a soma e convene devolve as chamadas", async () => {
    const gen: Generator = {
      provider: "anthropic",
      model: "claude-opus-5",
      async stream(_system, _messages, onText) {
        onText("Ponto [geral].");
        return { text: "Ponto [geral].", model: "claude-opus-5", stopReason: "end_turn", usage: { inputTokens: 1000, outputTokens: 200 } };
      },
    };
    const events: CouncilEvent[] = [];
    // Professores sem repositório: não tocam o banco.
    const calls = await convene("Pergunta", { professors: ["computacao", "historia"], generator: gen, onEvent: (e) => events.push(e) });

    const perCall = (1000 * 5 + 200 * 25) / 1e6;
    expect(calls.map((c) => c.etapa).sort()).toEqual(["computacao", "historia", SYNTHESIS_ID].sort());
    for (const c of calls) expect(c.costUsd).toBeCloseTo(perCall, 10);
    const perspectivas = events.filter((e) => e.type === "perspectiva");
    for (const p of perspectivas) expect(p.type === "perspectiva" && p.costUsd).toBeCloseTo(perCall, 10);
    const done = events.at(-1)!;
    expect(done.type === "done" && done.costUsd).toBeCloseTo(3 * perCall, 10);
  });
});
