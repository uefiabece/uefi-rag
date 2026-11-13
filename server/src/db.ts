import { mkdirSync } from "node:fs";
import { settings } from "./config.js";

/** O mínimo que o resto do código precisa de um Postgres: PGlite e node-postgres expõem a mesma forma. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Pick<Db, "query" | "exec">) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}

let instance: Promise<Db> | undefined;

export function getDb(): Promise<Db> {
  instance ??= settings.databaseUrl ? openPostgres(settings.databaseUrl) : openPglite();
  return instance;
}

async function openPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { unaccent } = await import("@electric-sql/pglite/contrib/unaccent");
  mkdirSync(settings.pgliteDir, { recursive: true });
  const pg = await PGlite.create(settings.pgliteDir, { extensions: { vector, unaccent } });
  const db: Db = {
    kind: "pglite",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pg.query<T>(sql, params)).rows }),
    exec: async (sql) => void (await pg.exec(sql)),
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await tx.query<T>(sql, params)).rows }),
          exec: async (sql: string) => void (await tx.exec(sql)),
        }),
      ),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });
  const db: Db = {
    kind: "postgres",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
    exec: async (sql) => void (await pool.query(sql)),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
          exec: async (sql: string) => void (await client.query(sql)),
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  await migrate(db);
  return db;
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() não é IMMUTABLE; o invólucro permite usá-lo em coluna gerada e índice.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

CREATE TABLE IF NOT EXISTS meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          text PRIMARY KEY,            -- <repo>/<caminho relativo>
  repo        text NOT NULL,
  path        text NOT NULL,
  section     text NOT NULL,               -- syllabus, exams, exercises, notes, bibliography, flashcards, ecossistema
  subject     text NOT NULL,
  course      text,
  visibility  text NOT NULL CHECK (visibility IN ('publico', 'privado')),
  format      text NOT NULL,               -- pdf, md, txt
  title       text NOT NULL,
  sha256      text NOT NULL,
  pages       int,
  chars       int NOT NULL,
  quality     jsonb NOT NULL DEFAULT '{}',
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id          bigserial PRIMARY KEY,
  doc_id      text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         int NOT NULL,
  heading     text,
  page_start  int,
  page_end    int,
  text        text NOT NULL,
  text_hash   text NOT NULL,
  tokens      int NOT NULL,
  embedding   vector NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('portuguese', f_unaccent(coalesce(heading, ''))), 'A') ||
                setweight(to_tsvector('portuguese', f_unaccent(text)), 'B')
              ) STORED
);
CREATE INDEX IF NOT EXISTS chunks_doc_idx ON chunks (doc_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id     text PRIMARY KEY,                 -- disciplina:<chave>, conceito:<chave>, livro:<chave>, curso:<chave>
  type   text NOT NULL,
  label  text NOT NULL,
  data   jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS graph_edges (
  src       text NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  dst       text NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  type      text NOT NULL,
  weight    real NOT NULL DEFAULT 1,
  evidence  jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (src, dst, type)
);
`;

async function migrate(db: Db) {
  await db.exec(SCHEMA);
}

/**
 * O índice HNSW precisa de dimensão fixa, que só se conhece ao escolher o modelo de embedding.
 * Trocar de modelo exige reindexar: misturar espaços vetoriais devolveria vizinhos sem sentido.
 */
export async function ensureEmbeddingSpace(db: Db, model: string, dim: number) {
  const { rows } = await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding'");
  const wanted = `${model}:${dim}`;
  if (rows[0] && rows[0].value !== wanted) {
    throw new Error(
      `O índice foi criado com ${rows[0].value}, mas o modelo atual é ${wanted}. Rode "npm run ingest -- --reset" para reindexar.`,
    );
  }
  if (!rows[0]) {
    await db.query("INSERT INTO meta (key, value) VALUES ('embedding', $1)", [wanted]);
    await db.exec(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${dim})`);
    await db.exec("CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)");
  }
}

export async function resetIndex(db: Db) {
  await db.exec(`
    DROP INDEX IF EXISTS chunks_embedding_idx;
    TRUNCATE chunks, documents RESTART IDENTITY CASCADE;
    ALTER TABLE chunks ALTER COLUMN embedding TYPE vector;
    DELETE FROM meta WHERE key = 'embedding';
  `);
}

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
