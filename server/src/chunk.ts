import { looksLikeHeading } from "./clean.js";
import type { Page } from "./extract.js";

export interface Chunk {
  ord: number;
  heading: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  tokens: number;
}

export interface ChunkOptions {
  target: number;
  max: number;
  min: number;
  overlap: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { target: 1100, max: 1800, min: 250, overlap: 200 };

interface Block {
  text: string;
  page: number | null;
  heading: string | null;
  /** Começa uma unidade nova (título de seção ou enunciado de questão): não misturar com o anterior. */
  boundary: boolean;
}

const QUESTION = /^(?:\*\*)?(?:quest[aã]o|exerc[ií]cio|problema|q\.?)\s*\d+/i;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function titleCase(s: string): string {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (letters !== letters.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, sp, c: string) => sp + c.toUpperCase());
}

function toBlocks(pages: Page[], markdown: boolean): Block[] {
  const blocks: Block[] = [];
  const stack: string[] = [];
  let pdfHeading: string | null = null;
  let question: string | null = null;

  const headingNow = () => {
    const base = markdown ? stack.filter(Boolean).join(" › ") || null : pdfHeading;
    return question ? (base ? `${base} › ${question}` : question) : base;
  };

  for (const page of pages) {
    for (const rawPara of page.text.split(/\n{2,}/)) {
      const para = rawPara.trim();
      if (!para) continue;
      const md = markdown ? /^(#{1,6})\s+(.+)$/.exec(para.split("\n")[0]!) : null;
      if (md) {
        const level = md[1]!.length;
        stack.length = level - 1;
        stack[level - 1] = md[2]!.replace(/[*_`]/g, "").trim();
        question = null;
        const rest = para.split("\n").slice(1).join("\n").trim();
        blocks.push({ text: rest, page: page.page, heading: headingNow(), boundary: level <= 3 });
        continue;
      }
      if (!markdown && looksLikeHeading(para)) {
        pdfHeading = titleCase(para);
        question = null;
        blocks.push({ text: "", page: page.page, heading: headingNow(), boundary: true });
        continue;
      }
      if (QUESTION.test(para)) {
        question = para.match(QUESTION)![0].replace(/\*/g, "").trim();
        blocks.push({ text: para, page: page.page, heading: headingNow(), boundary: true });
        continue;
      }
      blocks.push({ text: para, page: page.page, heading: headingNow(), boundary: false });
    }
  }
  return blocks;
}

function splitSentences(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [text];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > max) {
      out.push(buf.trim());
      buf = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function tail(text: string, size: number): string {
  if (text.length <= size) return text;
  const cut = text.slice(-size);
  const start = cut.search(/(?<=[.!?]\s)\p{Lu}/u);
  const piece = start > 0 ? cut.slice(start) : cut.slice(cut.indexOf(" ") + 1);
  return piece.replace(/^[\s.,;:!?)\]]+/, "");
}

export function chunkPages(pages: Page[], format: "pdf" | "md" | "txt", opts: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  const blocks = toBlocks(pages, format === "md");
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let heading: string | null = null;
  let pageStart: number | null = null;
  let pageEnd: number | null = null;
  let size = 0;

  const flush = (carryOverlap: boolean) => {
    const text = parts.join("\n\n").trim();
    if (text) {
      chunks.push({ ord: chunks.length, heading, pageStart, pageEnd, text, tokens: estimateTokens(text) });
    }
    const carry = carryOverlap && text ? tail(text, opts.overlap) : "";
    parts = carry ? [carry] : [];
    size = carry.length;
    pageStart = carry ? pageEnd : null;
  };

  for (const block of blocks) {
    const pieces = block.text.length > opts.max ? splitSentences(block.text, opts.target) : [block.text];
    if (block.boundary && size >= opts.min) flush(false);
    if (block.boundary || parts.length === 0) heading = block.heading;
    for (const piece of pieces) {
      if (!piece) continue;
      if (size > 0 && size + piece.length > opts.target) {
        flush(true);
        heading = block.heading;
      }
      parts.push(piece);
      size += piece.length + 2;
      pageStart ??= block.page;
      pageEnd = block.page;
    }
  }
  flush(false);
  return chunks;
}
