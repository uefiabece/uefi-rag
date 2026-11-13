import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chunkPages } from "./chunk.js";
import type { Quality } from "./clean.js";
import { loadCorpusConfig } from "./config.js";
import { ensureEmbeddingSpace, getDb, resetIndex, toVector } from "./db.js";
import { contextualize, getEmbedder } from "./embed.js";
import { extractPdf, extractText, type Extracted } from "./extract.js";
import { discoverSources, type SourceFile } from "./sources.js";

export interface IngestOptions {
  reset?: boolean;
  force?: boolean;
  repo?: string;
  /** Só repositórios públicos: útil para montar a demo sem esperar pelo acervo inteiro. */
  publicOnly?: boolean;
  log?: (line: string) => void;
}

export interface IngestReport {
  scanned: number;
  ingested: number;
  unchanged: number;
  removed: number;
  failed: { id: string; error: string }[];
  flagged: { id: string; flags: Quality["flags"] }[];
  chunks: number;
  embedded: number;
  reusedEmbeddings: number;
  missingRepos: string[];
  seconds: number;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function titleFor(file: SourceFile, extracted: Extracted): string {
  if (file.format === "md") {
    const h1 = /^#\s+(.+)$/m.exec(extracted.pages[0]?.text ?? "");
    if (h1) return h1[1]!.replace(/[*_`]/g, "").trim();
  }
  return prettyTitle(path.basename(file.path, path.extname(file.path)));
}

const ACRONYMS = new Set(["ppc", "bct", "bm", "fvv", "pd", "ufabc", "mcp", "tcc", "est", "in", "ie"]);

/** "ppc_2023" → "PPC 2023"; "orientacoes_curricularizacao_extensao" → "Orientacoes curricularizacao extensao". */
export function prettyTitle(name: string): string {
  const words = name.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().split(" ");
  return words
    .map((w, i) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export async function ingest(opts: IngestOptions = {}): Promise<IngestReport> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const config = loadCorpusConfig();
  const { repos, files: all } = discoverSources(config);
  const files = all.filter((f) => (!opts.repo || f.repo === opts.repo) && (!opts.publicOnly || f.visibility === "publico"));

  const db = await getDb();
  const embedder = getEmbedder();
  if (opts.reset) {
    log("Apagando índice anterior…");
    await resetIndex(db);
  }
  await ensureEmbeddingSpace(db, embedder.model, await embedder.dim());

  const known = new Map(
    (await db.query<{ id: string; sha256: string }>("SELECT id, sha256 FROM documents")).rows.map((r) => [r.id, r.sha256]),
  );

  const report: IngestReport = {
    scanned: files.length,
    ingested: 0,
    unchanged: 0,
    removed: 0,
    failed: [],
    flagged: [],
    chunks: 0,
    embedded: 0,
    reusedEmbeddings: 0,
    missingRepos: repos.filter((r) => !r.found).map((r) => r.name),
    seconds: 0,
  };

  for (const [i, file] of files.entries()) {
    const prefix = `[${i + 1}/${files.length}] ${file.id}`;
    try {
      const bytes = readFileSync(file.absPath);
      const hash = sha256(bytes);
      if (!opts.force && known.get(file.id) === hash) {
        report.unchanged++;
        continue;
      }

      const extracted = file.format === "pdf" ? await extractPdf(file.absPath, config.maxPdfPages) : extractText(file.absPath);
      const title = titleFor(file, extracted);
      const chunks = chunkPages(extracted.pages, file.format);
      if (extracted.quality.flags.length) report.flagged.push({ id: file.id, flags: extracted.quality.flags });

      // Reaproveita embeddings de trechos que não mudaram: editar uma lista não reembeda o PDF inteiro.
      const previous = new Map(
        (
          await db.query<{ text_hash: string; embedding: string }>(
            "SELECT text_hash, embedding::text AS embedding FROM chunks WHERE doc_id = $1",
            [file.id],
          )
        ).rows.map((r) => [r.text_hash, r.embedding]),
      );

      const meta = { subject: file.subject, title, section: file.section };
      const prepared = chunks.map((c) => {
        const input = contextualize(meta, c.heading, c.text);
        return { ...c, input, hash: sha256(`${embedder.model}\n${input}`) };
      });
      const vectors = new Map<string, string>();
      const todo = prepared.filter((c) => {
        const reused = previous.get(c.hash);
        if (reused) vectors.set(c.hash, reused);
        return !reused;
      });
      report.reusedEmbeddings += prepared.length - todo.length;
      for (let b = 0; b < todo.length; b += 16) {
        const batch = todo.slice(b, b + 16);
        const embedded = await embedder.embed(batch.map((c) => c.input));
        batch.forEach((c, j) => vectors.set(c.hash, toVector(embedded[j]!)));
        report.embedded += batch.length;
      }

      await db.transaction(async (tx) => {
        await tx.query("DELETE FROM documents WHERE id = $1", [file.id]);
        await tx.query(
          `INSERT INTO documents (id, repo, path, section, subject, course, visibility, format, title, sha256, pages, chars, quality)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            file.id,
            file.repo,
            file.path,
            file.section,
            file.subject,
            file.course,
            file.visibility,
            file.format,
            title,
            hash,
            extracted.totalPages,
            extracted.quality.chars,
            JSON.stringify(extracted.quality),
          ],
        );
        for (const c of prepared) {
          await tx.query(
            `INSERT INTO chunks (doc_id, ord, heading, page_start, page_end, text, text_hash, tokens, embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`,
            [file.id, c.ord, c.heading, c.pageStart, c.pageEnd, c.text, c.hash, c.tokens, vectors.get(c.hash)],
          );
        }
      });
      report.ingested++;
      report.chunks += prepared.length;
      const flags = extracted.quality.flags.length ? `  ⚠ ${extracted.quality.flags.join(", ")}` : "";
      log(`${prefix}  ${prepared.length} trechos${flags}`);
    } catch (err) {
      report.failed.push({ id: file.id, error: err instanceof Error ? err.message : String(err) });
      log(`${prefix}  ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Arquivos apagados dos repositórios saem do índice (só dentro do escopo desta execução).
  const present = new Set(files.map((f) => f.id));
  const inScope = new Set(files.map((f) => f.repo));
  const scope =
    opts.repo || opts.publicOnly ? [...known.keys()].filter((id) => inScope.has(id.slice(0, id.indexOf("/")))) : [...known.keys()];
  for (const id of scope) {
    if (!present.has(id)) {
      await db.query("DELETE FROM documents WHERE id = $1", [id]);
      report.removed++;
    }
  }

  report.seconds = Math.round((Date.now() - started) / 100) / 10;
  return report;
}
