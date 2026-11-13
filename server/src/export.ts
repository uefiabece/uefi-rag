import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { getDb } from "./db.js";
import { loadGraph } from "./graph.js";

/**
 * Gera web/public/demo/*.json para a versão estática (GitHub Pages), que roda sem servidor.
 * Só entra o que vem de repositórios públicos: documentos, trechos, grafo e as respostas
 * gravadas na última avaliação do conjunto público. Nada do acervo privado sai daqui.
 */
export async function exportDemo(log: (line: string) => void = () => {}) {
  const out = path.join(ROOT, "web", "public", "demo");
  mkdirSync(out, { recursive: true });
  const db = await getDb();
  const write = (name: string, data: unknown) => {
    const json = JSON.stringify(data);
    writeFileSync(path.join(out, name), json);
    log(`${name.padEnd(16)} ${(json.length / 1024).toFixed(0).padStart(5)} KB`);
  };

  const embedding = (await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding'")).rows[0]?.value ?? null;
  const documents = (
    await db.query(
      `SELECT d.id, d.repo, d.path, d.section, d.subject, d.course, d.visibility, d.format, d.title,
              d.pages, d.chars, d.quality, d.ingested_at, count(c.id)::int AS chunks, coalesce(sum(c.tokens), 0)::int AS tokens
         FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id
        WHERE d.visibility = 'publico'
        GROUP BY d.id ORDER BY d.repo, d.path`,
    )
  ).rows;
  write("documents.json", { documents });

  const chunks = (
    await db.query<{ doc_id: string }>(
      `SELECT c.doc_id, c.ord, c.heading, c.page_start, c.page_end, c.text, c.tokens
         FROM chunks c JOIN documents d ON d.id = c.doc_id
        WHERE d.visibility = 'publico' ORDER BY c.doc_id, c.ord`,
    )
  ).rows;
  write("chunks.json", { chunks });

  const graph = await loadGraph(true);
  write("graph.json", graph);

  const latest = path.join(ROOT, "eval", "resultados", "latest.json");
  if (existsSync(latest)) {
    const report = JSON.parse(readFileSync(latest, "utf8")) as {
      set: string;
      items: { conjunto: string; answer: unknown }[];
    };
    if (report.set === "publico" && report.items.every((i) => i.conjunto === "publico")) write("eval.json", report);
  }

  write("health.json", {
    ok: true,
    demo: true,
    database: "estático",
    documents: documents.length,
    chunks: chunks.length,
    graphNodes: graph.nodes.length,
    embedding,
    generator: null,
    publicOnly: true,
    exportedAt: new Date().toISOString(),
  });
}
