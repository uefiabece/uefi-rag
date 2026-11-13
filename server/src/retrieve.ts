import { settings } from "./config.js";
import { getDb, toVector } from "./db.js";
import { getEmbedder } from "./embed.js";
import { prettyTitle } from "./ingest.js";

export interface SearchFilters {
  repos?: string[];
  sections?: string[];
  publicOnly?: boolean;
}

export interface SearchOptions extends SearchFilters {
  k?: number;
  mode?: "hybrid" | "vector" | "lexical";
  /** Máximo de trechos do mesmo documento no resultado final. */
  perDoc?: number;
  /** Peso da lista léxica no RRF (a vetorial pesa 1). Ver docs/avaliacao.md para a escolha do valor. */
  lexicalWeight?: number;
}

export interface Hit {
  chunkId: number;
  docId: string;
  repo: string;
  path: string;
  title: string;
  subject: string;
  section: string;
  visibility: "publico" | "privado";
  heading: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  score: number;
  vectorRank: number | null;
  lexicalRank: number | null;
  similarity: number | null;
}

const RRF_K = 60;
export const DEFAULT_LEXICAL_WEIGHT = Number(process.env.LEXICAL_WEIGHT ?? 0.5);
const CANDIDATES = 40;

interface Row {
  id: number;
  doc_id: string;
  repo: string;
  path: string;
  title: string;
  subject: string;
  section: string;
  visibility: "publico" | "privado";
  heading: string | null;
  page_start: number | null;
  page_end: number | null;
  text: string;
  similarity?: number;
}

function filterSql(f: SearchFilters, params: unknown[]): string {
  const where: string[] = [];
  if (f.publicOnly || settings.publicOnly) where.push("d.visibility = 'publico'");
  if (f.repos?.length) {
    params.push(f.repos);
    where.push(`d.repo = ANY($${params.length})`);
  }
  if (f.sections?.length) {
    params.push(f.sections);
    where.push(`d.section = ANY($${params.length})`);
  }
  return where.length ? `AND ${where.join(" AND ")}` : "";
}

const COLUMNS = `c.id, c.doc_id, d.repo, d.path, d.title, d.subject, d.section, d.visibility,
                 c.heading, c.page_start, c.page_end, c.text`;

async function vectorSearch(query: string, f: SearchFilters): Promise<Row[]> {
  const [embedding] = await getEmbedder().embed([query]);
  const params: unknown[] = [toVector(embedding!)];
  const where = filterSql(f, params);
  const db = await getDb();
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}, 1 - (c.embedding <=> $1::vector) AS similarity
       FROM chunks c JOIN documents d ON d.id = c.doc_id
      WHERE true ${where}
      ORDER BY c.embedding <=> $1::vector
      LIMIT ${CANDIDATES}`,
    params,
  );
  return rows;
}

/**
 * Busca textual com OR entre os termos: plainto_tsquery exige todos, o que zera perguntas
 * naturais ("quais livros caem na prova de cálculo?"). O ranking por ts_rank_cd já favorece
 * quem casa mais termos e mais próximos.
 */
async function lexicalSearch(query: string, f: SearchFilters): Promise<Row[]> {
  const params: unknown[] = [query];
  const where = filterSql(f, params);
  const db = await getDb();
  const { rows } = await db.query<Row>(
    `WITH q AS (
       SELECT nullif(replace(plainto_tsquery('portuguese', f_unaccent($1))::text, '&', '|'), '')::tsquery AS tsq,
              tsvector_to_array(to_tsvector('portuguese', f_unaccent($1))) AS lexemes
     )
     SELECT ${COLUMNS},
            (SELECT count(*) FROM unnest(q.lexemes) AS t(lex) WHERE c.tsv @@ quote_literal(t.lex)::tsquery) AS coverage
       FROM chunks c JOIN documents d ON d.id = c.doc_id, q
      WHERE q.tsq IS NOT NULL AND c.tsv @@ q.tsq ${where}
      ORDER BY coverage DESC, ts_rank_cd(c.tsv, q.tsq, 32) DESC
      LIMIT ${CANDIDATES}`,
    params,
  );
  return rows;
}

function toHit(row: Row): Omit<Hit, "score" | "vectorRank" | "lexicalRank" | "similarity"> {
  return {
    chunkId: Number(row.id),
    docId: row.doc_id,
    repo: row.repo,
    path: row.path,
    // Títulos antigos no índice vieram crus do nome do arquivo; arrumar aqui evita reembedar tudo.
    title: /[A-Z]/.test(row.title) ? row.title : prettyTitle(row.title),
    subject: row.subject,
    section: row.section,
    visibility: row.visibility,
    heading: row.heading,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    text: row.text,
  };
}

/** Reciprocal Rank Fusion: soma 1/(k + posição) de cada lista; não depende de escalas comparáveis. */
export function fuse(vector: Row[], lexical: Row[], lexicalWeight = 1): Hit[] {
  const merged = new Map<number, Hit>();
  const add = (rows: Row[], kind: "vector" | "lexical") =>
    rows.forEach((row, i) => {
      const id = Number(row.id);
      const hit =
        merged.get(id) ??
        ({ ...toHit(row), score: 0, vectorRank: null, lexicalRank: null, similarity: null } satisfies Hit);
      hit.score += (kind === "lexical" ? lexicalWeight : 1) / (RRF_K + i + 1);
      if (kind === "vector") {
        hit.vectorRank = i + 1;
        hit.similarity = row.similarity ?? null;
      } else {
        hit.lexicalRank = i + 1;
      }
      merged.set(id, hit);
    });
  add(vector, "vector");
  add(lexical, "lexical");
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

export async function search(query: string, opts: SearchOptions = {}): Promise<Hit[]> {
  const { k = 8, mode = "hybrid", perDoc = 3, lexicalWeight = DEFAULT_LEXICAL_WEIGHT } = opts;
  const [vector, lexical] = await Promise.all([
    mode === "lexical" ? Promise.resolve([]) : vectorSearch(query, opts),
    mode === "vector" ? Promise.resolve([]) : lexicalSearch(query, opts),
  ]);
  const ranked = fuse(vector, lexical, lexicalWeight);
  const perDocCount = new Map<string, number>();
  const out: Hit[] = [];
  for (const hit of ranked) {
    const n = perDocCount.get(hit.docId) ?? 0;
    if (n >= perDoc) continue;
    perDocCount.set(hit.docId, n + 1);
    out.push(hit);
    if (out.length >= k) break;
  }
  return out;
}
