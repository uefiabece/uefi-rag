import { parseArgs } from "node:util";
import { getDb } from "./db.js";

const [command, ...rest] = process.argv.slice(2);

const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    reset: { type: "boolean" },
    force: { type: "boolean" },
    repo: { type: "string" },
    section: { type: "string" },
    k: { type: "string" },
    mode: { type: "string" },
    public: { type: "boolean" },
    set: { type: "string" },
    limit: { type: "string" },
    "no-answers": { type: "boolean" },
    label: { type: "string" },
  },
});

const filters = {
  repos: values.repo ? values.repo.split(",") : undefined,
  sections: values.section ? values.section.split(",") : undefined,
  publicOnly: values.public,
};

async function main() {
  switch (command) {
    case "ingest": {
      const { ingest } = await import("./ingest.js");
      const report = await ingest({
        reset: values.reset,
        force: values.force,
        repo: values.repo,
        publicOnly: values.public,
        log: console.log,
      });
      console.log(
        `\n${report.ingested} indexados, ${report.unchanged} sem mudança, ${report.removed} removidos, ` +
          `${report.failed.length} com erro · ${report.chunks} trechos (${report.embedded} embeddings novos, ` +
          `${report.reusedEmbeddings} reaproveitados) · ${report.seconds}s`,
      );
      if (report.missingRepos.length) console.log(`Repositórios não encontrados: ${report.missingRepos.join(", ")}`);
      if (report.flagged.length) {
        console.log("\nDocumentos com problema de extração:");
        for (const f of report.flagged) console.log(`  ${f.flags.join(", ").padEnd(28)} ${f.id}`);
      }
      for (const f of report.failed) console.log(`  ✗ ${f.id}: ${f.error}`);
      break;
    }
    case "search": {
      const { search } = await import("./retrieve.js");
      const query = positionals.join(" ");
      const hits = await search(query, {
        ...filters,
        k: Number(values.k ?? 8),
        mode: (values.mode as "hybrid" | "vector" | "lexical") ?? "hybrid",
      });
      for (const [i, h] of hits.entries()) {
        const pages = h.pageStart ? ` p.${h.pageStart}${h.pageEnd !== h.pageStart ? `–${h.pageEnd}` : ""}` : "";
        console.log(
          `\n${i + 1}. ${h.subject} · ${h.title}${pages}  [vet ${h.vectorRank ?? "–"} / lex ${h.lexicalRank ?? "–"}]` +
            `\n   ${h.docId}${h.heading ? `\n   § ${h.heading}` : ""}\n   ${h.text.slice(0, 220).replace(/\s+/g, " ")}…`,
        );
      }
      break;
    }
    case "ask": {
      const { answer } = await import("./answer.js");
      const question = positionals.join(" ");
      const result = await answer(question, [], filters, {
        onSources: (sources) => {
          console.log("Fontes:");
          for (const s of sources) console.log(`  [${s.n}] ${s.subject} · ${s.title}${s.pages ? ` (${s.pages})` : ""}`);
          console.log();
        },
        onText: (t) => process.stdout.write(t),
      });
      console.log(`\n\n— ${result.model} · ${result.latencyMs} ms · citações: ${result.citations.valid.join(", ") || "nenhuma"}`);
      if (result.citations.invalid.length) console.log(`  citações sem fonte: ${result.citations.invalid.join(", ")}`);
      break;
    }
    case "graph": {
      const { buildGraph } = await import("./graph.js");
      const stats = await buildGraph(console.log);
      console.log(stats);
      break;
    }
    case "eval": {
      const { runEval } = await import("./eval.js");
      await runEval({
        set: (values.set as "publico" | "privado" | "todos") ?? "publico",
        limit: values.limit ? Number(values.limit) : undefined,
        answers: !values["no-answers"],
        label: values.label,
        log: console.log,
      });
      break;
    }
    case "export": {
      const { exportDemo } = await import("./export.js");
      await exportDemo(console.log);
      break;
    }
    default:
      console.log("Comandos: ingest [--reset] [--force] [--repo X] | search <consulta> | ask <pergunta> | graph | eval | export");
  }
}

main()
  .then(async () => (await getDb()).close())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
