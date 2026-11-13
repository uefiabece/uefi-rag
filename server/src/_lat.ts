import { search } from "./retrieve.js";
import { getEmbedder } from "./embed.js";
const q = "Quantas horas de disciplinas de opção limitada o aluno do BC&T precisa cursar no PPC 2023?";
await getEmbedder().embed(["aquecer"]);
for (const mode of ["vector", "lexical", "hybrid"] as const) {
  const t = Date.now(); await search(q, { mode, k: 8 }); console.log(mode, Date.now() - t, "ms");
}
let t = Date.now(); await getEmbedder().embed([q]); console.log("embed só", Date.now() - t, "ms");
