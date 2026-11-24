import { parseArgs } from "node:util";
import { getDb } from "./db.js";
import { flushTracing, initTracing } from "./trace.js";

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
    prof: { type: "string" },
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
      if (report.discoveredRepos.length) console.log(`Descobertos automaticamente (privado): ${report.discoveredRepos.join(", ")}`);
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
    case "council": {
      const { convene, loadCouncil, SYNTHESIS_ID } = await import("./council.js");
      const names = new Map(loadCouncil().professores.map((p) => [p.id, p.titulo]));
      names.set(SYNTHESIS_ID, "Síntese do conselho");
      // Os professores escrevem em paralelo; no terminal, cada perspectiva sai inteira quando termina.
      const buffers = new Map<string, string>();
      await convene(positionals.join(" "), {
        professors: values.prof ? values.prof.split(",") : undefined,
        publicOnly: values.public,
        onEvent: (e) => {
          if (e.type === "sources") console.log(`· ${names.get(e.professor)}: ${e.sources.length} trechos do acervo da área`);
          if (e.type === "delta") buffers.set(e.professor, (buffers.get(e.professor) ?? "") + e.text);
          if (e.type === "perspectiva") {
            const stats = e.error ? `erro: ${e.error}` : `${e.citations.valid.length} citações · ${e.general} [geral] · ${e.latencyMs} ms`;
            console.log(`\n── ${names.get(e.professor)} (${stats})\n\n${buffers.get(e.professor) ?? ""}`);
          }
          if (e.type === "done") console.log(`\n— ${e.latencyMs} ms · ${e.inputTokens + e.outputTokens} tokens`);
        },
      });
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
      console.log("Comandos: ingest [--reset] [--force] [--repo X] | search <consulta> | ask <pergunta> | council <pergunta> [--prof a,b] | graph | eval | export");
  }
}

initTracing()
  .then(main)
  .then(async () => (await getDb()).close())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(flushTracing);
