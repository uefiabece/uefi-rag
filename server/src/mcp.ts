/**
 * Servidor MCP (stdio) que expõe o acervo para qualquer cliente MCP: Claude Desktop, Claude Code
 * ou os próprios servidores UÉFIabecê. É um cliente fino da API HTTP: o índice fica num processo só
 * (o PGlite não aceita dois processos no mesmo diretório) e a resposta é escrita pelo LLM do cliente.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { settings } from "./config.js";
import type { GraphEdge, GraphNode } from "./graph.js";
import { matchNodes } from "./graph.js";
import type { Hit } from "./retrieve.js";

const BASE = process.env.RAG_URL ?? `http://127.0.0.1:${settings.port}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`).catch(() => {
    throw new Error(`A API do acervo não respondeu em ${BASE}. Rode "npm run serve" no ufabc-rag.`);
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function formatHits(hits: Hit[]): string {
  if (!hits.length) return "Nada encontrado no acervo para essa consulta.";
  return hits
    .map((h, i) => {
      const pages = h.pageStart ? `, p. ${h.pageStart}${h.pageEnd && h.pageEnd !== h.pageStart ? `–${h.pageEnd}` : ""}` : "";
      return `[${i + 1}] ${h.subject} · ${h.title}${pages}${h.heading ? ` · ${h.heading}` : ""}\n(${h.docId})\n${h.text}`;
    })
    .join("\n\n---\n\n");
}

const server = new McpServer({ name: "ufabc-rag", version: "0.1.0" });

server.registerTool(
  "buscar_acervo",
  {
    title: "Buscar no acervo UÉFIabecê",
    description:
      "Busca híbrida (semântica + palavras) em ementas, PPCs, provas antigas, listas e notas de cursos da UFABC. " +
      "Devolve trechos com disciplina, documento e página, para citar na resposta.",
    inputSchema: {
      consulta: z.string().min(2).describe("Pergunta ou termos, em português"),
      k: z.number().int().min(1).max(20).default(6).describe("Quantos trechos devolver"),
      repositorio: z.string().optional().describe("Restringe a um repositório, ex.: uefi-uefimcp-bm"),
      secao: z
        .enum(["syllabus", "exams", "exercises", "notes", "bibliography", "flashcards", "ecossistema"])
        .optional()
        .describe("Restringe a um tipo de material"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ consulta, k, repositorio, secao }) => {
    const params = new URLSearchParams({ q: consulta, k: String(k) });
    if (repositorio) params.set("repo", repositorio);
    if (secao) params.set("section", secao);
    const { hits } = await get<{ hits: Hit[] }>(`/api/search?${params}`);
    return text(formatHits(hits));
  },
);

server.registerTool(
  "contexto_disciplina",
  {
    title: "Contexto de uma disciplina no grafo",
    description:
      "Mostra o que o grafo extraído das ementas sabe sobre uma disciplina ou conceito: cursos, recomendações, " +
      "conceitos da ementa, bibliografia e disciplinas com conteúdo em comum.",
    inputSchema: { nome: z.string().min(3).describe("Nome ou código da disciplina, ou um conceito") },
    annotations: { readOnlyHint: true },
  },
  async ({ nome }) => {
    const { nodes, edges } = await get<{ nodes: GraphNode[]; edges: GraphEdge[] }>("/api/graph");
    const matched = matchNodes(nome, nodes);
    if (!matched.length) return text(`"${nome}" não aparece no grafo. Tente o nome oficial ou o código (ex.: BIS0003-15).`);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const lines: string[] = [];
    for (const n of matched.slice(0, 3)) {
      lines.push(`## ${n.label} (${n.type})`);
      for (const e of edges.filter((e) => e.src === n.id || e.dst === n.id)) {
        const other = byId.get(e.src === n.id ? e.dst : e.src);
        const dir = e.src === n.id ? "→" : "←";
        lines.push(`- ${e.type} ${dir} ${other?.label ?? "?"}${e.evidence[0]?.detail ? ` (${e.evidence[0].detail})` : ""}`);
      }
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "listar_documentos",
  {
    title: "Listar documentos indexados",
    description: "Lista os documentos do acervo, com disciplina, tipo de material e problemas de extração.",
    inputSchema: { repositorio: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ repositorio }) => {
    const { documents } = await get<{
      documents: { id: string; repo: string; subject: string; section: string; chunks: number; quality: { flags: string[] } }[];
    }>("/api/documents");
    const rows = documents
      .filter((d) => !repositorio || d.repo === repositorio)
      .map((d) => `${d.subject} · ${d.section} · ${d.chunks} trechos${d.quality.flags.length ? ` · ⚠ ${d.quality.flags.join(", ")}` : ""}\n  ${d.id}`);
    return text(rows.join("\n") || "Nenhum documento.");
  },
);

server.registerTool(
  "conselho_de_professores",
  {
    title: "Material para um conselho de professores",
    description:
      "Prepara a mesma pergunta para professores de cursos diferentes da UFABC (um por curso: engenharias, exatas, " +
      "humanas, licenciaturas e os interdisciplinares de ingresso): para cada um, a lente da área e os trechos do acervo " +
      "daquela área. Use para explicar uma questão por várias perspectivas; o que não tiver trecho deve ser apresentado " +
      "como conhecimento geral, sem citação. Sem 'professores', usa o conselho padrão.",
    inputSchema: {
      pergunta: z.string().min(2),
      professores: z
        .array(z.string())
        .min(2)
        .max(5)
        .optional()
        .describe("ids, ex.: neurociencia, computacao, historia, eng-energia, politicas-publicas"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ pergunta, professores }) => {
    const council = await get<{ padrao: string[]; professores: { id: string; titulo: string; area: string; repos: string[]; lente: string; documentos: number }[] }>(
      "/api/council",
    );
    const wanted = professores?.length ? professores : council.padrao;
    const blocks: string[] = [];
    for (const p of council.professores.filter((x) => wanted.includes(x.id))) {
      let material = "Sem material desta área no acervo: tudo o que este professor disser é conhecimento geral.";
      if (p.repos.length && p.documentos > 0) {
        const params = new URLSearchParams({ q: pergunta, k: "5", repo: p.repos.join(",") });
        const { hits } = await get<{ hits: Hit[] }>(`/api/search?${params}`);
        if (hits.length) material = formatHits(hits);
      }
      blocks.push(`# ${p.titulo}\nLente: ${p.lente}\n\n${material}`);
    }
    if (!blocks.length) return text(`Nenhum professor encontrado entre: ${wanted.join(", ")}.`);
    return text(blocks.join("\n\n═════\n\n"));
  },
);

await server.connect(new StdioServerTransport());
