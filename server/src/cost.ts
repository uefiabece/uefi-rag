import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { getDb } from "./db.js";
import type { GenerationResult } from "./generate.js";

/**
 * Custo das chamadas ao gerador, a partir dos tokens que o provedor devolve e de precos.config.json.
 * Modelo sem preço conhecido custa `null`, nunca zero: um total que soma "desconhecido" como grátis engana.
 */
export interface Price {
  entrada: number;
  saida: number;
}

interface PricesConfig {
  moeda: string;
  modelos: Record<string, Price>;
}

let prices: PricesConfig | null = null;
export function loadPrices(): PricesConfig {
  return (prices ??= JSON.parse(readFileSync(path.join(ROOT, "precos.config.json"), "utf8")) as PricesConfig);
}

const FREE: Price = { entrada: 0, saida: 0 };

export function priceFor(provider: string, model: string, table = loadPrices().modelos): Price | null {
  // Ollama roda na máquina; modelos ":free" do OpenRouter não cobram (só têm limite de requisições).
  if (provider === "ollama" || model.endsWith(":free")) return FREE;
  const exact = table[`${provider}:${model}`];
  if (exact) return exact;
  // O provedor pode devolver um id mais específico que o pedido (sufixo de data, por exemplo).
  // O prefixo mais longo vence, para claude-opus-5-5 não cair no preço de claude-opus-5.
  const prefix = `${provider}:`;
  const match = Object.keys(table)
    .filter((k) => k.startsWith(prefix) && model.startsWith(`${k.slice(prefix.length)}-`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? table[match]! : null;
}

export function costUsd(provider: string, model: string, usage: GenerationResult["usage"], table?: Record<string, Price>): number | null {
  if (!usage) return null;
  const p = priceFor(provider, model, table);
  if (!p) return null;
  return (usage.inputTokens * p.entrada + usage.outputTokens * p.saida) / 1e6;
}

/** Soma custos; se alguma parcela é desconhecida, o total também é. */
export function sumCost(costs: (number | null)[]): number | null {
  return costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + c!, 0);
}

/** "US$ 0,0123", "grátis" ou "sem preço". Custos de uma consulta ficam em frações de centavo: 4 casas. */
export function formatUsd(x: number | null): string {
  if (x === null) return "sem preço";
  if (x === 0) return "grátis";
  return `US$ ${x.toLocaleString("pt-BR", { minimumFractionDigits: x < 1 ? 4 : 2, maximumFractionDigits: x < 1 ? 4 : 2 })}`;
}

// ---------------------------------------------------------------- registro

export interface GenerationRecord {
  /** Professor do conselho, "sintese", ou null numa resposta comum. */
  etapa: string | null;
  provider: string;
  model: string;
  usage: GenerationResult["usage"];
  costUsd: number | null;
  latencyMs: number;
}

/** Grava as chamadas de uma consulta. Só metadados: nada de pergunta, resposta ou trecho. */
export async function recordQuery(tipo: "resposta" | "conselho", calls: GenerationRecord[]): Promise<string> {
  const consulta = randomUUID();
  const db = await getDb();
  for (const c of calls) {
    await db.query(
      `INSERT INTO geracoes (consulta, tipo, etapa, provedor, modelo, input_tokens, output_tokens, custo_usd, latencia_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [consulta, tipo, c.etapa, c.provider, c.model, c.usage?.inputTokens ?? null, c.usage?.outputTokens ?? null, c.costUsd, c.latencyMs],
    );
  }
  return consulta;
}

export interface CostSummary {
  moeda: string;
  desde: string | null;
  porProvedor: {
    provedor: string;
    modelo: string;
    consultas: number;
    chamadas: number;
    inputTokens: number;
    outputTokens: number;
    custoUsd: number | null;
    /** Chamadas sem preço conhecido: o custo do grupo fica null. */
    semPreco: number;
  }[];
  porTipo: { tipo: string; consultas: number; custoMedioUsd: number | null; custoTotalUsd: number | null }[];
  ultimas: { consulta: string; tipo: string; criadoEm: string; chamadas: number; custoUsd: number | null; modelos: string[] }[];
}

export async function costSummary(limit = 20): Promise<CostSummary> {
  const db = await getDb();
  // count(custo_usd) < count(*) quer dizer que alguma chamada não tem preço: o grupo vira null.
  const porProvedor = await db.query<{
    provedor: string; modelo: string; consultas: number; chamadas: number; input: number; output: number; custo: number | null; sem_preco: number;
  }>(
    `SELECT provedor, modelo, count(DISTINCT consulta)::int AS consultas, count(*)::int AS chamadas,
            coalesce(sum(input_tokens), 0)::int AS input, coalesce(sum(output_tokens), 0)::int AS output,
            CASE WHEN count(custo_usd) = count(*) THEN sum(custo_usd) END AS custo,
            (count(*) - count(custo_usd))::int AS sem_preco
       FROM geracoes GROUP BY provedor, modelo ORDER BY sum(coalesce(custo_usd, 0)) DESC, chamadas DESC`,
  );
  const porConsulta = `SELECT consulta, tipo, min(criado_em) AS criado_em, count(*)::int AS chamadas,
                              CASE WHEN count(custo_usd) = count(*) THEN sum(custo_usd) END AS custo,
                              array_agg(DISTINCT provedor || ':' || modelo) AS modelos
                         FROM geracoes GROUP BY consulta, tipo`;
  const porTipo = await db.query<{ tipo: string; consultas: number; medio: number | null; total: number | null }>(
    `SELECT tipo, count(*)::int AS consultas,
            CASE WHEN count(custo) = count(*) THEN avg(custo) END AS medio,
            CASE WHEN count(custo) = count(*) THEN sum(custo) END AS total
       FROM (${porConsulta}) q GROUP BY tipo ORDER BY tipo`,
  );
  const ultimas = await db.query<{ consulta: string; tipo: string; criado_em: Date | string; chamadas: number; custo: number | null; modelos: string[] }>(
    `${porConsulta} ORDER BY criado_em DESC LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`,
  );
  const desde = (await db.query<{ desde: Date | string | null }>("SELECT min(criado_em) AS desde FROM geracoes")).rows[0]?.desde ?? null;
  const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  return {
    moeda: loadPrices().moeda,
    desde: desde ? new Date(desde).toISOString() : null,
    porProvedor: porProvedor.rows.map((r) => ({
      provedor: r.provedor,
      modelo: r.modelo,
      consultas: r.consultas,
      chamadas: r.chamadas,
      inputTokens: r.input,
      outputTokens: r.output,
      custoUsd: num(r.custo),
      semPreco: r.sem_preco,
    })),
    porTipo: porTipo.rows.map((r) => ({ tipo: r.tipo, consultas: r.consultas, custoMedioUsd: num(r.medio), custoTotalUsd: num(r.total) })),
    ultimas: ultimas.rows.map((r) => ({
      consulta: r.consulta,
      tipo: r.tipo,
      criadoEm: new Date(r.criado_em).toISOString(),
      chamadas: r.chamadas,
      custoUsd: num(r.custo),
      modelos: r.modelos,
    })),
  };
}
