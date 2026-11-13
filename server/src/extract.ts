import { readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";
import { cleanPages, assessQuality, type Quality } from "./clean.js";

export interface Page {
  /** Número da página no PDF (1-based); null para texto puro. */
  page: number | null;
  text: string;
}

export interface Extracted {
  pages: Page[];
  totalPages: number | null;
  quality: Quality;
}

interface LayoutItem {
  str: string;
  transform: number[];
  height: number;
  hasEOL: boolean;
}

/**
 * Remonta linhas e parágrafos a partir das posições dos fragmentos de texto.
 * O pdf.js entrega pedaços soltos; a quebra de parágrafo vem do salto vertical maior que uma entrelinha.
 */
export function layoutPage(items: LayoutItem[]): string {
  const lines: { y: number; h: number; text: string }[] = [];
  let current: { y: number; h: number; text: string } | null = null;
  for (const item of items) {
    const y = item.transform[5] ?? 0;
    const h = Math.abs(item.height || item.transform[3] || 10);
    if (!current || Math.abs(y - current.y) > h * 0.5) {
      if (current) lines.push(current);
      current = { y, h, text: item.str };
    } else {
      const needsSpace = current.text && !/\s$/.test(current.text) && item.str && !/^\s/.test(item.str);
      current.text += (needsSpace ? " " : "") + item.str;
    }
    if (item.hasEOL && current) {
      lines.push(current);
      current = null;
    }
  }
  if (current) lines.push(current);

  // Notas de rodapé vêm em fonte menor e interrompem a frase do corpo do texto quando o
  // parágrafo atravessa a página; vão para o fim da página como parágrafo próprio.
  const heights = lines.filter((l) => l.text.trim()).map((l) => l.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  const isNote = (l: { h: number; text: string }) => heights.length >= 8 && l.h < median * 0.82 && l.text.trim().length > 3;

  const out: string[] = [];
  const notes: string[] = [];
  let prev: { y: number; h: number } | undefined;
  for (const line of lines) {
    if (!line.text.trim()) continue;
    if (isNote(line)) {
      // Referências de rodapé ("Disponível em http…", "Acesso em…") não respondem pergunta nenhuma.
      if (!/https?:\/\/|acesso em|dispon[ií]vel em/i.test(line.text)) notes.push(line.text.trim());
      continue;
    }
    if (prev && out.length && prev.y - line.y > Math.max(prev.h, line.h) * 1.8) out.push("");
    out.push(line.text.trimEnd());
    prev = line;
  }
  if (notes.length) out.push("", ...notes);
  return out.join("\n");
}

export async function extractPdf(absPath: string, maxPages: number): Promise<Extracted> {
  // verbosity 0: o pdf.js avisa de cada fonte TrueType incompleta, comum em PDF institucional.
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(absPath)), { verbosity: 0 });
  const total = pdf.numPages;
  const raw: Page[] = [];
  for (let n = 1; n <= Math.min(total, maxPages); n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items = content.items.filter((it) => "str" in it) as LayoutItem[];
    raw.push({ page: n, text: layoutPage(items) });
    page.cleanup();
  }
  await pdf.cleanup();
  const pages = cleanPages(raw);
  return { pages, totalPages: total, quality: assessQuality(raw, pages, total, maxPages) };
}

export function extractText(absPath: string): Extracted {
  const text = readFileSync(absPath, "utf8").replace(/^﻿/, "");
  const pages = cleanPages([{ page: null, text }]);
  return { pages, totalPages: null, quality: assessQuality(pages, pages, null, Infinity) };
}
