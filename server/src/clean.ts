import type { Page } from "./extract.js";

export interface Quality {
  chars: number;
  emptyPages: number;
  removedBoilerplate: number;
  garbledRatio: number;
  flags: ("sem-texto" | "texto-corrompido" | "truncado" | "poucas-palavras")[];
}

const LIGATURES: Record<string, string> = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl" };

export function normalizeChars(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[ﬁﬂﬀﬃﬄ]/g, (c) => LIGATURES[c] ?? c)
    .replace(/­/g, "")
    .replace(/[   ]/g, " ")
    .replace(/[-]/g, "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ");
}

const PAGE_NUMBER = /^\s*(?:p[aá]g(?:ina)?\.?\s*)?\d{1,4}(?:\s*(?:de|\/)\s*\d{1,4})?\s*$/i;

/**
 * Chave de cabeçalho/rodapé. Uma linha conta como repetida se for idêntica entre páginas, ou se o
 * único número que muda acompanhar a página com deslocamento fixo ("PPC BC&T 2023 · 25" na página 26).
 * Só normalizar dígitos apagaria conteúdo de slides, em que "Exercício 3" ocupa a borda da página.
 */
function boilerplateKey(line: string, page: number | null): string {
  const text = line.toLowerCase().replace(/\s+/g, " ").trim();
  const numbers = text.match(/\d+/g);
  if (!numbers || page === null) return text;
  const offset = Number(numbers[numbers.length - 1]) - page;
  const lastAt = text.lastIndexOf(numbers[numbers.length - 1]!);
  return `${text.slice(0, lastAt)}#${offset}${text.slice(lastAt + numbers[numbers.length - 1]!.length)}`;
}

/**
 * Remove cabeçalhos e rodapés repetidos: linhas nas bordas da página que aparecem em pelo menos
 * metade das páginas. Em PDFs institucionais isso tira "Ministério da Educação / Fundação
 * Universidade Federal do ABC" de cada página antes do chunking.
 */
function stripBoilerplate(pages: Page[]): { pages: Page[]; removed: number } {
  if (pages.length < 4) return { pages, removed: 0 };
  const EDGE = 3;
  const counts = new Map<string, number>();
  const keysOf = (p: Page) => {
    const lines = p.text.split("\n").filter((l) => l.trim());
    const edge = [...lines.slice(0, EDGE), ...lines.slice(-EDGE)];
    return new Set(edge.flatMap((l) => [boilerplateKey(l, null), boilerplateKey(l, p.page)]).filter((k) => k.length > 2));
  };
  for (const p of pages) for (const key of keysOf(p)) counts.set(key, (counts.get(key) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  const repeated = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));

  let removed = 0;
  const out = pages.map((p) => {
    const lines = p.text.split("\n");
    const nonEmpty = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    const edge = new Set([...nonEmpty.slice(0, EDGE), ...nonEmpty.slice(-EDGE)]);
    const kept = lines.filter((line, i) => {
      const boiler = repeated.has(boilerplateKey(line, null)) || repeated.has(boilerplateKey(line, p.page));
      if (edge.has(i) && (boiler || PAGE_NUMBER.test(line))) {
        removed++;
        return false;
      }
      return true;
    });
    return { ...p, text: kept.join("\n") };
  });
  return { pages: out, removed };
}

const NUMBERED_HEADING = /^\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+\p{Lu}[^.;:]{2,80}$/u;

/** Linha que parece título de seção: numerada ("4.1 Justificativa") ou curta e toda em maiúsculas. */
export function looksLikeHeading(line: string): boolean {
  if (line.length > 90 || /[.,;:]$/.test(line)) return false;
  if (NUMBERED_HEADING.test(line)) return true;
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toUpperCase() && /\p{L}{3,}/u.test(line);
}

const LIST_START = /^\s*(?:[•●▪◦‣\-–*]\s|\(?[a-z]\)\s|\(?\d{1,2}[).]\s|[IVXLC]{1,5}\s*[-–.)]\s|#{1,6}\s|\|)/;

/** Junta linhas quebradas pelo layout do PDF dentro de um parágrafo, preservando listas e títulos. */
export function reflow(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
      const paras: string[] = [];
      let out = "";
      let prev = "";
      for (const line of lines) {
        if (looksLikeHeading(line)) {
          if (out) paras.push(out);
          paras.push(line);
          out = prev = "";
          continue;
        }
        if (!out) {
          out = prev = line;
          continue;
        }
        const breakHere = LIST_START.test(line) || /[:;]$/.test(prev) || (prev.length < 60 && /[.!?]$/.test(prev));
        if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
        else out += (breakHere ? "\n" : " ") + line;
        prev = line;
      }
      if (out) paras.push(out);
      return paras.join("\n\n");
    })
    .join("\n\n");
}

export function cleanPages(raw: Page[]): Page[] {
  const isPdf = raw.some((p) => p.page !== null);
  const normalized = raw.map((p) => ({ ...p, text: normalizeChars(p.text) }));
  const { pages } = isPdf ? stripBoilerplate(normalized) : { pages: normalized };
  return pages.map((p) => {
    let text = p.text
      .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
      .replace(/(\p{L}) -(se|lo|la|los|las|lhe|lhes|me|te|nos)\b/gu, "$1-$2")
      .replace(/[ ]{2,}/g, " ")
      .replace(/ +\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
    if (isPdf) text = reflow(text);
    return { ...p, text: text.trim() };
  });
}

/** Conta caracteres de substituição e glifos de fontes sem mapa Unicode, típicos de PDF mal exportado. */
function garbled(text: string): number {
  const bad = text.match(/[�\u0000-\u0008\u000E-\u001F]|[\u0080-\u009F]/g);
  return bad ? bad.length : 0;
}

export function assessQuality(raw: Page[], pages: Page[], total: number | null, maxPages: number): Quality {
  const chars = pages.reduce((n, p) => n + p.text.length, 0);
  const emptyPages = pages.filter((p) => p.text.replace(/\s/g, "").length < 30).length;
  const rawChars = raw.reduce((n, p) => n + p.text.length, 0) || 1;
  const garbledRatio = raw.reduce((n, p) => n + garbled(p.text), 0) / rawChars;
  const removedBoilerplate = raw.reduce((n, p) => n + p.text.length, 0) - chars;
  const words = pages.reduce((n, p) => n + (p.text.match(/\p{L}{3,}/gu)?.length ?? 0), 0);

  const flags: Quality["flags"] = [];
  if (pages.length && emptyPages / pages.length > 0.5) flags.push("sem-texto");
  if (garbledRatio > 0.02) flags.push("texto-corrompido");
  if (total !== null && total > maxPages) flags.push("truncado");
  if (words < 20 && !flags.includes("sem-texto")) flags.push("poucas-palavras");
  return { chars, emptyPages, removedBoilerplate: Math.max(0, removedBoilerplate), garbledRatio, flags };
}
