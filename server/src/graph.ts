import { loadCorpusConfig, settings, type Visibility } from "./config.js";
import { getDb } from "./db.js";
import { extractPdf, extractText } from "./extract.js";
import type { SearchFilters } from "./retrieve.js";
import { discoverSources, type SourceFile } from "./sources.js";

export type NodeType = "disciplina" | "conceito" | "livro" | "curso";
export type EdgeType = "aborda" | "bibliografia_basica" | "bibliografia_complementar" | "recomenda" | "pertence" | "compartilha";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  data: Record<string, unknown> & { visibility: Visibility; docs: string[] };
}

export interface GraphEdge {
  src: string;
  dst: string;
  type: EdgeType;
  weight: number;
  evidence: { docId: string; visibility: Visibility; detail?: string }[];
}

// ---------------------------------------------------------------- normalização

const STOPWORDS = new Set(
  "a o as os de da do das dos e em na no nas nos para por com sem sua seu suas seus um uma uns umas ao aos à às pelo pela pelos pelas entre sobre".split(" "),
);

export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Plural português para singular, o suficiente para "Funções"/"função" e "Números"/"número" caírem juntos. */
export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("oes") || word.endsWith("aes")) return word.slice(0, -3) + "ao";
  if (word.endsWith("ais")) return word.slice(0, -3) + "al";
  if (word.endsWith("eis")) return word.slice(0, -3) + "el";
  if (word.endsWith("ns")) return word.slice(0, -2) + "m";
  if (word.endsWith("res") || word.endsWith("zes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) return word.slice(0, -1);
  return word;
}

export function conceptKey(phrase: string): string {
  return fold(phrase)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map(singular)
    .join(" ");
}

export function nameKey(name: string): string {
  return fold(name).replace(/[^a-z0-9]+/g, " ").trim();
}

const CODE = /\b([A-Z]{2,4}\d{4}-\d{2})\b/;

/** Palavras de ementa que descrevem a forma do tópico, não um assunto: não viram nó no grafo. */
const GENERIC_CONCEPTS = new Set([
  "definicao", "propriedade", "aplicacao", "exemplo", "introducao", "conceito", "nocao", "generalidade",
  "suficiente", "necessaria", "condicao necessaria", "revisao", "topico", "exercicio",
]);

// ---------------------------------------------------------------- ementas

export interface Ementa {
  name: string | null;
  code: string | null;
  tpei: string | null;
  recommendation: string | null;
  syllabus: string | null;
  basic: string[];
  complementary: string[];
}

const FIELD_HEADINGS: [keyof Ementa | "skip", RegExp][] = [
  ["syllabus", /^ementa$/],
  ["basic", /^bibliografia basica$/],
  ["complementary", /^bibliografia complementar$/],
  ["recommendation", /^recomendac(ao|oes)$/],
  ["skip", /^(objetivos?( especificos| gerais)?|metodologia.*|dados do curso|conteudo programatico|cronograma|avaliacao.*|observac(ao|oes)|competencias.*|habilidades.*)$/],
];

function fieldOf(line: string): { field: keyof Ementa | "skip"; rest: string } | null {
  const m = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(\p{L}[\p{L} ]{3,39}?)\s*(?:\*\*)?\s*(?::\s*(?:\*\*)?\s*(.*))?$/u.exec(line.trim());
  if (!m) return null;
  const head = fold(m[1]!).trim();
  for (const [field, re] of FIELD_HEADINGS) if (re.test(head)) return { field, rest: (m[2] ?? "").trim() };
  return null;
}

function titleCaseName(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => sp + c.toUpperCase())
    .replace(/(?<=\s)(De|Da|Do|Das|Dos|E|À|Às|Ao|Aos)(?=\s)/g, (w) => w.toLowerCase());
}

function tableValue(text: string, ...labels: string[]): string | null {
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    // Planos de ensino em PDF põem o valor na linha seguinte: "Nome da disciplina:" / "INTRODUÇÃO ÀS ENGENHARIAS".
    const bare = /^\s*([\p{L} ]{3,30}):\s*$/u.exec(line);
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (bare && next && labels.includes(fold(bare[1]!).trim())) return titleCaseName(next.trim());
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2 && labels.includes(fold(cells[0]!))) return cells[1]!.replace(/[*_`]/g, "").trim();
    const kv = /^\s*(?:\*\*)?([\p{L} ]{3,20})(?:\*\*)?\s*:\s*(.+)$/u.exec(line);
    if (kv && labels.includes(fold(kv[1]!).trim())) return kv[2]!.trim();
  }
  return null;
}

/** Lê uma ementa no formato do Catálogo de Disciplinas da UFABC, em Markdown ou texto extraído de PDF. */
export function parseEmenta(text: string): Ementa | null {
  const sections = new Map<keyof Ementa | "skip", string[]>();
  let current: keyof Ementa | "skip" | null = null;
  for (const line of text.split("\n")) {
    const f = line.trim().length <= 60 || /^#|^\*\*/.test(line.trim()) ? fieldOf(line) : null;
    if (f) {
      current = f.field;
      if (!sections.has(current)) sections.set(current, []);
      if (f.rest) sections.get(current)!.push(f.rest);
      continue;
    }
    if (/^#{1,6}\s/.test(line) || /^-{3,}$/.test(line.trim())) {
      if (/^#{1,6}\s/.test(line)) current = null;
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }
  const joined = (k: keyof Ementa) => sections.get(k)?.join("\n").trim() || null;
  const syllabus = joined("syllabus");
  const basicText = joined("basic");
  if (!syllabus && !basicText) return null;

  const code = tableValue(text, "codigo", "sigla da disciplina", "codigo da disciplina") ?? CODE.exec(text)?.[1] ?? null;
  return {
    name: tableValue(text, "nome oficial", "nome", "disciplina", "nome da disciplina"),
    code: code && CODE.test(code) ? CODE.exec(code)![1]! : null,
    tpei: tableValue(text, "tpei", "t-p-e-i", "tpi"),
    recommendation: joined("recommendation"),
    syllabus: syllabus?.replace(/\s+/g, " ") ?? null,
    basic: parseBibliography(basicText ?? ""),
    complementary: parseBibliography(joined("complementary") ?? ""),
  };
}

// ---------------------------------------------------------------- conceitos

/**
 * A ementa da UFABC é uma lista de tópicos: "Funções Reais: função escada, função módulo, ...".
 * Cada segmento separado por ponto vira um conceito; o que vem depois de dois-pontos são subtópicos.
 */
export function extractConcepts(syllabus: string): string[] {
  const out: string[] = [];
  const clean = (s: string) =>
    s
      .replace(/\([^)]*\)/g, "")
      .replace(/^[\s\-–•*]+|[\s.,;:]+$/g, "")
      .replace(/^(?:introdu[cç][aã]o (?:a|à|ao|às|aos)|no[cç][oõ]es (?:de|sobre)|conceitos? de|elementos de|estudo d[aoe]s?)\s+/i, "")
      .trim();
  for (const segment of syllabus.split(/(?<=[^A-Z])[.;]\s+|\n+/)) {
    const [head, tail] = segment.split(/:\s+/, 2) as [string, string | undefined];
    const parts = tail ? [head, ...tail.split(/,\s*|\s+e\s+(?=\p{L})/u)] : head.split(/,\s*/);
    for (const p of parts.map(clean)) {
      const words = p.split(/\s+/).filter(Boolean);
      if (words.length < 1 || words.length > 6 || p.length < 4 || p.length > 70) continue;
      if (!/\p{L}{3,}/u.test(p) || /^\d/.test(p)) continue;
      if (!conceptKey(p) || GENERIC_CONCEPTS.has(conceptKey(p))) continue;
      out.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  return [...new Map(out.map((c) => [conceptKey(c), c])).values()];
}

// ---------------------------------------------------------------- bibliografia

export interface Book {
  key: string;
  author: string;
  title: string;
  year: string | null;
  raw: string;
}

const ENTRY_START = /^[A-ZÀ-Ý][A-ZÀ-Ý'\-]+(?:\s+[A-ZÀ-Ý][A-ZÀ-Ý'\-]+)*(?:,|\s+[A-Z]\.)/;

function isAuthorSegment(seg: string): boolean {
  const words = seg.replace(/[;,&]/g, " ").split(/\s+/).filter((w) => w.replace(/[.\-']/g, "").length >= 2);
  if (!words.length) return true;
  if (/^(et al|org|orgs|ed|eds|coord)\.?$/i.test(seg.trim())) return true;
  return words.every((w) => w === w.toUpperCase() || /^(et|al|e|de|da|do|dos|das|van|von)$/.test(w));
}

export function parseBook(raw: string): Book | null {
  const entry = raw.replace(/\s+/g, " ").trim();
  if (entry.length < 10) return null;
  const segments = entry.split(/[.;]\s+/);
  const authorParts: string[] = [];
  let title: string | null = null;
  for (const seg of segments) {
    if (!title && isAuthorSegment(seg)) {
      authorParts.push(seg);
      continue;
    }
    title = seg;
    break;
  }
  if (!title || !authorParts.length) return null;
  const surname = /^([A-ZÀ-Ý][A-ZÀ-Ý'\-]+(?:\s+[A-ZÀ-Ý][A-ZÀ-Ý'\-]+)*)/.exec(authorParts[0]!.replace(/^[;,\s]+/, ""))?.[1];
  if (!surname) return null;
  const cleanTitle = title
    .split(/:\s|,\s/)[0]!
    .replace(/[*_]/g, "")
    .replace(/^[\s\-–—]+/, "")
    // Inicial solta do autor ("GUIDORIZZI, H. L. Um curso…"); A, E e O ficam, porque são artigos.
    .replace(/^(?:[B-DF-NP-Z]\.?\s+)+(?=\p{Lu})/u, "")
    .trim()
    .slice(0, 90);
  // Duas palavras bastam para casar edições e grafias diferentes ("Cálculo a uma variável, vol. I").
  const titleWords = conceptKey(cleanTitle).split(" ").filter((w) => w.length > 1).slice(0, 2);
  if (!titleWords.length) return null;
  const years = entry.match(/\b(1[89]\d\d|20\d\d)\b/g);
  return {
    key: `${fold(surname).replace(/[^a-z]/g, "")}|${titleWords.join(" ")}`,
    author: surname.charAt(0) + surname.slice(1).toLowerCase(),
    title: cleanTitle,
    year: years ? years[years.length - 1]! : null,
    raw: entry,
  };
}

export function parseBibliography(text: string): string[] {
  const entries: string[] = [];
  for (const line of text.split("\n")) {
    const l = line.replace(/^[\s\-•*]+|\d+\.\s+/g, "").trim();
    if (!l) {
      entries.push("");
      continue;
    }
    if (ENTRY_START.test(l) || !entries.length || entries[entries.length - 1] === "") entries.push(l);
    else entries[entries.length - 1] += " " + l;
  }
  return entries.filter((e) => e.length > 10);
}

// ---------------------------------------------------------------- currículo

export interface CurriculumRow {
  code: string;
  name: string;
  category: string | null;
  axis: string | null;
}

/** Tabelas Markdown "| BCJ0204-15 | Fenômenos Mecânicos | 60h |", com o título de seção como categoria/eixo. */
export function parseCurriculum(markdown: string): CurriculumRow[] {
  const rows: CurriculumRow[] = [];
  let category: string | null = null;
  let axis: string | null = null;
  for (const line of markdown.split("\n")) {
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h2) {
      category = h2[1]!.split(/\s+[—–-]\s+/)[0]!.trim();
      axis = null;
    }
    if (h3) axis = h3[1]!.trim();
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const code = CODE.exec(cells[1] ?? "")?.[1];
    const name = cells[2]?.replace(/[*_`]/g, "").trim();
    if (code && name && /\p{L}{3,}/u.test(name)) rows.push({ code, name, category, axis });
  }
  return rows;
}

export interface CodeTableRow {
  code: string;
  name: string;
  tpei: string;
  category: string | null;
}

/**
 * Tabelas de disciplinas em PDF, que viram texto corrido depois da extração. Dois formatos aparecem
 * nos documentos públicos da UFABC:
 *   "BCJ0204-15 Fenômenos Mecânicos 4-1-0-6 5 60"            (PPC, listas da Biotecnologia)
 *   "BIJ0207-15 Bases Conceituais da Energia 2 0 0 4 0"        (lista de opção limitada do BC&T)
 * O código às vezes vem partido ("ESTU025 - 17"); o TPEI fecha o nome.
 */
export function parseCodeTable(text: string, defaultCategory: string | null = null): CodeTableRow[] {
  const rows: CodeTableRow[] = [];
  const re =
    /\b([A-Z]{2,5}\d{3,4})\s*-\s*(\d{2})\s+(\p{Lu}[^\n]{2,90}?)\s+(?:(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})|(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \d{1,3})(?=\s|$)/gu;
  for (const m of text.matchAll(re)) {
    const name = m[3]!.replace(/\s+/g, " ").trim();
    if (CODE.test(name) || name.length < 3) continue;
    const tpei = (m[4] ? [m[4], m[5], m[6], m[7]] : [m[8], m[9], m[10], m[11]]).join("-");
    const before = text.slice(Math.max(0, m.index - 3000), m.index);
    const cues = [...before.matchAll(/obrigat[óo]ri[ao]s?|op[çc][ãa]o limitada|disciplinas livres/gi)];
    const cue = cues.at(-1)?.[0].toLowerCase();
    const category = defaultCategory ?? (cue ? (cue.startsWith("obrigat") ? "Obrigatória" : cue.startsWith("op") ? "Opção limitada" : "Livre") : null);
    rows.push({ code: `${m[1]}-${m[2]}`, name, tpei, category });
  }
  return [...new Map(rows.map((r) => [r.code, r])).values()];
}

// ---------------------------------------------------------------- construção

class GraphBuilder {
  nodes = new Map<string, GraphNode>();
  edges = new Map<string, GraphEdge>();

  node(type: NodeType, key: string, label: string, file: SourceFile, data: Record<string, unknown> = {}): GraphNode {
    const id = `${type}:${key}`;
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, type, label, data: { visibility: file.visibility, docs: [] } };
      this.nodes.set(id, node);
    }
    if (file.visibility === "publico") node.data.visibility = "publico";
    if (!node.data.docs.includes(file.id)) node.data.docs.push(file.id);
    for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined && node.data[k] === undefined) node.data[k] = v;
    return node;
  }

  edge(src: GraphNode, dst: GraphNode, type: EdgeType, file: SourceFile, detail?: string, weight = 1) {
    if (src.id === dst.id) return;
    const id = `${src.id}→${dst.id}→${type}`;
    const edge = this.edges.get(id) ?? { src: src.id, dst: dst.id, type, weight: 0, evidence: [] };
    if (!edge.evidence.some((e) => e.docId === file.id)) {
      edge.evidence.push({ docId: file.id, visibility: file.visibility, detail });
      edge.weight += weight;
    }
    this.edges.set(id, edge);
  }

  discipline(name: string, code: string | null, file: SourceFile, data: Record<string, unknown> = {}) {
    // Mesma disciplina aparece com nomes levemente diferentes; o código, quando há, é a chave mais estável.
    const byCode = code ? [...this.nodes.values()].find((n) => n.type === "disciplina" && (n.data.codes as string[] | undefined)?.includes(code)) : undefined;
    const node = byCode ?? this.node("disciplina", nameKey(name), name, file, data);
    if (byCode) this.node("disciplina", byCode.id.slice("disciplina:".length), byCode.label, file, data);
    if (code) {
      const codes = (node.data.codes as string[] | undefined) ?? [];
      if (!codes.includes(code)) node.data.codes = [...codes, code];
    }
    return node;
  }

  /** Disciplinas ligadas por conceitos ou livros em comum: é daí que sai "o que estudar junto". */
  deriveShared() {
    const byDiscipline = new Map<string, Set<string>>();
    for (const e of this.edges.values()) {
      if (e.type !== "aborda" && e.type !== "bibliografia_basica" && e.type !== "bibliografia_complementar") continue;
      if (!byDiscipline.has(e.src)) byDiscipline.set(e.src, new Set());
      byDiscipline.get(e.src)!.add(e.dst);
    }
    const ids = [...byDiscipline.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byDiscipline.get(ids[i]!)!;
        const shared = [...byDiscipline.get(ids[j]!)!].filter((x) => a.has(x));
        if (shared.length < 2) continue;
        const src = this.nodes.get(ids[i]!)!;
        const dst = this.nodes.get(ids[j]!)!;
        const visibility: Visibility = src.data.visibility === "publico" && dst.data.visibility === "publico" ? "publico" : "privado";
        this.edges.set(`${src.id}→${dst.id}→compartilha`, {
          src: src.id,
          dst: dst.id,
          type: "compartilha",
          weight: shared.length,
          evidence: [{ docId: "", visibility, detail: shared.map((id) => this.nodes.get(id)!.label).join("; ") }],
        });
      }
    }
  }
}

async function readSource(file: SourceFile, maxPages: number): Promise<string> {
  const extracted = file.format === "pdf" ? await extractPdf(file.absPath, maxPages) : extractText(file.absPath);
  return extracted.pages.map((p) => p.text).join("\n\n");
}

export interface GraphStats {
  disciplinas: number;
  conceitos: number;
  livros: number;
  cursos: number;
  arestas: number;
  ementas: number;
}

export async function buildGraph(log: (line: string) => void = () => {}): Promise<GraphStats> {
  const config = loadCorpusConfig();
  const { files } = discoverSources(config);
  const g = new GraphBuilder();
  let ementas = 0;

  for (const file of files) {
    // PPCs antigos (2015, 2018) repetiriam disciplinas com códigos já substituídos.
    const table = file.format === "pdf" && /ppc_20(2\d)|limitadas/i.test(file.path);
    const candidate = table || file.section === "syllabus" || (file.format === "md" && /curriculo|ementa|grade/i.test(file.path));
    if (!candidate) continue;
    const text = await readSource(file, config.maxPdfPages);

    if (table) {
      const coded = parseCodeTable(text, /limitadas/i.test(file.path) ? "Opção limitada" : null);
      if (coded.length) {
        const course = g.node("curso", nameKey(file.course ?? file.subject), file.course ?? file.subject, file);
        for (const row of coded) {
          const d = g.discipline(row.name, row.code, file, { tpei: row.tpei });
          g.edge(d, course, "pertence", file, row.category ?? undefined);
        }
        log(`tabela      ${coded.length.toString().padStart(3)} disciplinas  ${file.id}`);
      }
      if (file.section !== "syllabus") continue;
    }

    const rows = parseCurriculum(text);
    if (rows.length) {
      const course = g.node("curso", nameKey(file.course ?? file.subject), file.course ?? file.subject, file);
      for (const row of rows) {
        const d = g.discipline(row.name, row.code, file);
        g.edge(d, course, "pertence", file, [row.category, row.axis].filter(Boolean).join(" · "));
      }
      log(`currículo   ${rows.length.toString().padStart(3)} disciplinas  ${file.id}`);
    }

    const ementa = parseEmenta(text);
    if (!ementa) continue;
    ementas++;
    const name = ementa.name ?? file.subject;
    const d = g.discipline(name, ementa.code, file, { tpei: ementa.tpei, ementa: ementa.syllabus });
    const concepts = ementa.syllabus ? extractConcepts(ementa.syllabus) : [];
    for (const c of concepts) g.edge(d, g.node("conceito", conceptKey(c), c, file), "aborda", file);
    for (const [list, type] of [
      [ementa.basic, "bibliografia_basica"],
      [ementa.complementary, "bibliografia_complementar"],
    ] as const) {
      for (const raw of list) {
        const book = parseBook(raw);
        if (!book) continue;
        g.edge(d, g.node("livro", book.key, `${book.author} · ${book.title}`, file, { ref: book.raw, year: book.year }), type, file);
      }
    }
    if (ementa.recommendation && !/n[aã]o h[aá]|nenhuma/i.test(ementa.recommendation)) {
      for (const rec of ementa.recommendation.split(/[;,\n]|\s+e\s+(?=\p{Lu})/u).map((s) => s.replace(/[.*]/g, "").trim())) {
        if (rec.length < 4) continue;
        const target = g.discipline(rec.replace(CODE, "").trim() || rec, CODE.exec(rec)?.[1] ?? null, file);
        g.edge(target, d, "recomenda", file);
      }
    }
    log(`ementa      ${concepts.length.toString().padStart(3)} conceitos, ${ementa.basic.length + ementa.complementary.length} referências  ${file.id}`);
  }
  g.deriveShared();

  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.exec("DELETE FROM graph_edges; DELETE FROM graph_nodes;");
    for (const n of g.nodes.values()) {
      await tx.query("INSERT INTO graph_nodes (id, type, label, data) VALUES ($1,$2,$3,$4)", [n.id, n.type, n.label, JSON.stringify(n.data)]);
    }
    for (const e of g.edges.values()) {
      await tx.query("INSERT INTO graph_edges (src, dst, type, weight, evidence) VALUES ($1,$2,$3,$4,$5)", [
        e.src,
        e.dst,
        e.type,
        e.weight,
        JSON.stringify(e.evidence),
      ]);
    }
  });
  cache = undefined;

  const count = (t: NodeType) => [...g.nodes.values()].filter((n) => n.type === t).length;
  return {
    disciplinas: count("disciplina"),
    conceitos: count("conceito"),
    livros: count("livro"),
    cursos: count("curso"),
    arestas: g.edges.size,
    ementas,
  };
}

// ---------------------------------------------------------------- consulta

let cache: Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> | undefined;

export async function loadGraph(publicOnly = false): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  cache ??= (async () => {
    const db = await getDb();
    const nodes = (await db.query<GraphNode>("SELECT id, type, label, data FROM graph_nodes")).rows;
    const edges = (await db.query<GraphEdge>("SELECT src, dst, type, weight, evidence FROM graph_edges")).rows;
    return { nodes, edges };
  })();
  const graph = await cache;
  if (!publicOnly && !settings.publicOnly) return graph;
  const nodes = graph.nodes.filter((n) => n.data.visibility === "publico");
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges
    .map((e) => ({ ...e, evidence: e.evidence.filter((ev) => ev.visibility === "publico") }))
    .filter((e) => ids.has(e.src) && ids.has(e.dst) && e.evidence.length);
  return { nodes, edges };
}

export function matchNodes(query: string, nodes: GraphNode[]): GraphNode[] {
  const q = ` ${nameKey(query)} `;
  const qConcept = ` ${conceptKey(query)} `;
  const codes = new Set(query.match(new RegExp(CODE.source, "g")) ?? []);
  const hits = nodes.filter((n) => {
    if (n.type === "disciplina") {
      if ((n.data.codes as string[] | undefined)?.some((c) => codes.has(c))) return true;
      const key = nameKey(n.label);
      return key.length >= 6 && q.includes(` ${key} `);
    }
    if (n.type === "conceito") {
      const key = conceptKey(n.label);
      return key.length >= 5 && qConcept.includes(` ${key} `);
    }
    return false;
  });
  // A disciplina mais específica vence: "Funções de Várias Variáveis" esconde "Funções".
  return hits.filter((n) => !hits.some((o) => o !== n && o.type === n.type && nameKey(o.label).includes(nameKey(n.label))));
}

/** Fatos do grafo sobre as disciplinas e conceitos citados na pergunta, como uma fonte a mais para o modelo. */
export async function graphContext(query: string, filters: SearchFilters = {}): Promise<string | null> {
  const { nodes, edges } = await loadGraph(filters.publicOnly);
  if (!nodes.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const matched = matchNodes(query, nodes).slice(0, 3);
  if (!matched.length) return null;

  const lines: string[] = [];
  const labels = (ids: string[]) => ids.map((id) => byId.get(id)?.label).filter(Boolean).join("; ");
  for (const n of matched) {
    const out = edges.filter((e) => e.src === n.id);
    const inc = edges.filter((e) => e.dst === n.id);
    if (n.type === "disciplina") {
      const codes = (n.data.codes as string[] | undefined)?.join(", ");
      lines.push(`Disciplina: ${n.label}${codes ? ` (${codes})` : ""}${n.data.tpei ? `, TPEI ${n.data.tpei}` : ""}`);
      const courses = out.filter((e) => e.type === "pertence");
      if (courses.length) lines.push(`  Cursos: ${courses.map((e) => `${byId.get(e.dst)?.label}${e.evidence[0]?.detail ? ` (${e.evidence[0].detail})` : ""}`).join("; ")}`);
      const rec = inc.filter((e) => e.type === "recomenda");
      if (rec.length) lines.push(`  Recomendadas antes: ${labels(rec.map((e) => e.src))}`);
      const next = out.filter((e) => e.type === "recomenda");
      if (next.length) lines.push(`  É recomendada para: ${labels(next.map((e) => e.dst))}`);
      const concepts = out.filter((e) => e.type === "aborda");
      if (concepts.length) lines.push(`  Conceitos da ementa: ${labels(concepts.map((e) => e.dst))}`);
      for (const [type, label] of [
        ["bibliografia_basica", "Bibliografia básica"],
        ["bibliografia_complementar", "Bibliografia complementar"],
      ] as const) {
        const books = out.filter((e) => e.type === type);
        if (books.length) lines.push(`  ${label}: ${labels(books.map((e) => e.dst))}`);
      }
      const shared = [...out, ...inc].filter((e) => e.type === "compartilha").sort((a, b) => b.weight - a.weight).slice(0, 5);
      for (const e of shared) {
        const other = byId.get(e.src === n.id ? e.dst : e.src);
        lines.push(`  Em comum com ${other?.label}: ${e.evidence[0]?.detail}`);
      }
    } else {
      const disciplines = inc.filter((e) => e.type === "aborda").map((e) => e.src);
      lines.push(`Conceito: ${n.label} — aparece nas ementas de: ${labels(disciplines) || "nenhuma disciplina indexada"}`);
    }
  }
  const text = lines.join("\n");
  return text.length > 3000 ? `${text.slice(0, 3000)}…` : text;
}
