import { readFileSync } from "node:fs";
import { search } from "./retrieve.js";
const items = readFileSync("../eval/perguntas.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.conjunto === "publico" && i.fontes.length);
for (const w of [1, 0.5, 0.3]) {
  let mrr = 0, h1 = 0, h3 = 0;
  for (const it of items) {
    const hits = await search(it.pergunta, { k: 8, publicOnly: true, lexicalWeight: w });
    const r = hits.findIndex((h) => it.fontes.some((f: string) => h.docId.startsWith(f))) + 1;
    if (r) { mrr += 1 / r; if (r === 1) h1++; if (r <= 3) h3++; }
  }
  console.log(`peso léxico ${w}: hit@1 ${(h1 / items.length * 100).toFixed(0)}%  hit@3 ${(h3 / items.length * 100).toFixed(0)}%  MRR ${(mrr / items.length).toFixed(2)}`);
}
{
  let mrr = 0, h1 = 0;
  for (const it of items) {
    const hits = await search(it.pergunta, { k: 8, publicOnly: true, mode: "lexical" });
    const r = hits.findIndex((h) => it.fontes.some((f: string) => h.docId.startsWith(f))) + 1;
    if (r) { mrr += 1 / r; if (r === 1) h1++; }
  }
  console.log(`só léxica (cobertura): hit@1 ${(h1 / items.length * 100).toFixed(0)}%  MRR ${(mrr / items.length).toFixed(2)}`);
}
