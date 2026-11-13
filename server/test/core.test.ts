import { describe, expect, it } from "vitest";
import { parseCitations, retrievalQuery } from "../src/answer.js";
import { chunkPages } from "../src/chunk.js";
import { cleanPages, looksLikeHeading, reflow } from "../src/clean.js";
import { abstained, factsFound } from "../src/eval.js";
import { layoutPage } from "../src/extract.js";
import {
  conceptKey,
  extractConcepts,
  matchNodes,
  parseBibliography,
  parseBook,
  parseCodeTable,
  parseCurriculum,
  parseEmenta,
  singular,
  type GraphNode,
} from "../src/graph.js";
import { fuse } from "../src/retrieve.js";
import { globToRegExp } from "../src/sources.js";

describe("limpeza de PDF", () => {
  it("remove cabeçalho e rodapé repetidos em todas as páginas", () => {
    const topics = ["Energia", "Matéria", "Informação", "Humanidades", "Simulação"];
    const pages = topics.map((topic, i) => ({
      page: i + 1,
      text: `Fundação Universidade Federal do ABC\nProjeto Pedagógico · ${i + 11}\n\nO eixo ${topic} reúne disciplinas.\n\nExercício 7\n\n${i + 1}`,
    }));
    const cleaned = cleanPages(pages);
    for (const [i, p] of cleaned.entries()) {
      expect(p.text).not.toContain("Fundação Universidade Federal");
      expect(p.text).not.toContain("Projeto Pedagógico");
      expect(p.text).toContain(`eixo ${topics[i]}`);
      expect(p.text).not.toMatch(/\n\d+$/);
    }
  });

  it("não confunde conteúdo de slide que só muda o número com rodapé", () => {
    const pages = [1, 2, 3, 4].map((n) => ({ page: n, text: `Exercício ${n * 3}\nCalcule a derivada de x^${n}.` }));
    for (const p of cleanPages(pages)) expect(p.text).toMatch(/^Exercício \d+/);
  });

  it("junta palavra hifenizada na quebra de linha e corrige ênclise separada", () => {
    const [p] = cleanPages([{ page: 1, text: "transfor-\nmação de energia. Considera -se o caso." }]);
    expect(p!.text).toContain("transformação");
    expect(p!.text).toContain("Considera-se");
  });

  it("reflui linhas do mesmo parágrafo, mas preserva listas e títulos", () => {
    const text = reflow("4.1 Justificativa de oferta de curso\nA dinâmica contemporânea de construção\ndo conhecimento tem reflexo.\nI - Primeiro item;\nII - Segundo item.");
    expect(text).toBe(
      "4.1 Justificativa de oferta de curso\n\nA dinâmica contemporânea de construção do conhecimento tem reflexo.\nI - Primeiro item;\nII - Segundo item.",
    );
  });

  it("reconhece títulos numerados e em maiúsculas, não frases", () => {
    expect(looksLikeHeading("8.3 Componentes curriculares para a integralização")).toBe(true);
    expect(looksLikeHeading("BIBLIOGRAFIA BÁSICA")).toBe(true);
    expect(looksLikeHeading("A dinâmica contemporânea de construção do conhecimento.")).toBe(false);
    expect(looksLikeHeading("2 créditos por semana")).toBe(false);
  });

  it("separa notas de rodapé em fonte menor e descarta referências de URL", () => {
    const item = (str: string, y: number, h = 12) => ({ str, transform: [1, 0, 0, h, 0, y], height: h, hasEOL: true });
    const body = Array.from({ length: 8 }, (_, i) => item(`Linha ${i} do corpo do texto`, 700 - i * 14));
    const text = layoutPage([...body, item("8 Disponível em https://dados.ufabc.edu.br", 60, 8), item("9 Nota explicativa relevante", 50, 8)]);
    expect(text).not.toContain("https://");
    expect(text.trim().endsWith("9 Nota explicativa relevante")).toBe(true);
  });
});

describe("chunking", () => {
  it("usa títulos Markdown como contexto e não mistura seções", () => {
    const md = "# Ementa de Bases Matemáticas\n\n## Ementa\n\n" + "Funções reais e limites. ".repeat(20) + "\n\n## Bibliografia Básica\n\n" + "STEWART, J. Cálculo. ".repeat(15);
    const chunks = chunkPages([{ page: null, text: md }], "md", { target: 400, max: 700, min: 100, overlap: 80 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.heading).toBe("Ementa de Bases Matemáticas › Ementa");
    expect(chunks.at(-1)!.heading).toBe("Ementa de Bases Matemáticas › Bibliografia Básica");
    expect(chunks.find((c) => c.text.includes("STEWART") && c.text.includes("Funções reais"))).toBeUndefined();
  });

  it("começa um trecho novo em cada questão de prova", () => {
    const text = "Questão 1\nCalcule o limite de f.\n\nQuestão 2\nMostre que g é contínua.";
    const chunks = chunkPages([{ page: 3, text }], "pdf", { target: 1000, max: 1800, min: 10, overlap: 0 });
    expect(chunks.map((c) => c.heading)).toEqual(["Questão 1", "Questão 2"]);
    expect(chunks[1]!.pageStart).toBe(3);
  });

  it("registra o intervalo de páginas e sobrepõe o fim do trecho anterior", () => {
    const pages = [1, 2, 3].map((n) => ({ page: n, text: `Parágrafo da página ${n}. ${"Texto corrido sobre o curso. ".repeat(12)}` }));
    const chunks = chunkPages(pages, "pdf", { target: 500, max: 900, min: 100, overlap: 120 });
    expect(chunks[0]!.pageStart).toBe(1);
    expect(chunks.at(-1)!.pageEnd).toBe(3);
    const second = chunks[1]!.text;
    expect(chunks[0]!.text.endsWith(second.split("\n\n")[0]!)).toBe(true);
  });
});

describe("grafo de ementas", () => {
  const ementa = `# Ementa de Bases Matemáticas — UFABC

| Campo | Valor |
|---|---|
| Nome oficial | Bases Matemáticas |
| Código | BIS0003-15 |
| TPEI | 4-0-0-5 |

## Recomendação

Não há

## Ementa

Elementos de Linguagem e Lógica Matemática: proposições, conectivos e quantificadores. Funções: definição e propriedades. Limite e Continuidade: conceito de limite de função; Teorema do Confronto, limites laterais.

## Bibliografia Básica

BOULOS P. Pré calculo, São Paulo, Makron 2006.

LIMA, E.; CARVALHO, P. ; WAGNER, E.; MORGADO, A. A Matemática do Ensino Médio. v. 1.
Coleção do Professor de Matemática, Sociedade Brasileira de Matemática, 2003.

SCHEINERMAN, E.; Matemática discreta: uma introdução. São Paulo, SP: Thomson Learning, 2011.

## Bibliografia Complementar

GUIDORIZZI, H. L. Um curso de cálculo. Rio de Janeiro: LTC, 2001.
`;

  it("lê os campos do catálogo de disciplinas", () => {
    const e = parseEmenta(ementa)!;
    expect(e.name).toBe("Bases Matemáticas");
    expect(e.code).toBe("BIS0003-15");
    expect(e.tpei).toBe("4-0-0-5");
    expect(e.recommendation).toBe("Não há");
    expect(e.basic).toHaveLength(3);
    expect(e.complementary).toHaveLength(1);
  });

  it("extrai conceitos sem palavras de forma como 'definição'", () => {
    const concepts = extractConcepts(parseEmenta(ementa)!.syllabus!);
    expect(concepts).toContain("Proposições");
    expect(concepts).toContain("Teorema do Confronto");
    expect(concepts).toContain("Limites laterais");
    expect(concepts).not.toContain("Definição");
    expect(concepts).not.toContain("Propriedades");
  });

  it("identifica autor e título de referências ABNT irregulares", () => {
    const entries = parseBibliography(parseEmenta(ementa)!.basic.join("\n"));
    const books = entries.map(parseBook);
    expect(books.map((b) => b?.key)).toEqual(["boulos|pre calculo", "lima|matematica ensino", "scheinerman|matematica discreta"]);
    expect(books[1]!.title).toBe("A Matemática do Ensino Médio");
    expect(parseBook("GUIDORIZZI, H. L. Um curso de cálculo. Rio de Janeiro: LTC, 2001.")!.title).toBe("Um curso de cálculo");
  });

  it("singulariza plurais comuns para casar conceitos entre ementas", () => {
    expect(singular("funcoes")).toBe("funcao");
    expect(singular("numeros")).toBe("numero");
    expect(conceptKey("Funções Reais")).toBe(conceptKey("função real"));
  });

  it("lê tabelas de currículo com categoria e eixo", () => {
    const rows = parseCurriculum("## Disciplinas Obrigatórias — 84 créditos\n\n### Eixo 1 — Energia\n\n| Sigla | Disciplina | Carga |\n|---|---|---|\n| BCJ0204-15 | Fenômenos Mecânicos | 60h |");
    expect(rows).toEqual([{ code: "BCJ0204-15", name: "Fenômenos Mecânicos", category: "Disciplinas Obrigatórias", axis: "Eixo 1 — Energia" }]);
  });

  it("encontra disciplinas por nome ou código na pergunta, preferindo a mais específica", () => {
    const node = (id: string, label: string, codes?: string[]): GraphNode => ({
      id,
      type: "disciplina",
      label,
      data: { visibility: "publico", docs: [], codes },
    });
    const nodes = [node("d:1", "Funções de Uma Variável"), node("d:2", "Funções de Várias Variáveis", ["BCN0407-15"]), node("d:3", "Funções")];
    expect(matchNodes("o que cai em funcoes de varias variaveis?", nodes).map((n) => n.id)).toEqual(["d:2"]);
    expect(matchNodes("ementa de BCN0407-15", nodes).map((n) => n.id)).toEqual(["d:2"]);
  });
});

describe("tabelas de disciplinas em PDF", () => {
  it("lê os dois formatos de tabela dos documentos públicos, inclusive código partido", () => {
    const text =
      "Disciplinas obrigatórias Código Nome TPEI BCJ0204-15 Fenômenos Mecânicos 4-1-0-6 5 60 " +
      "ESTU025 - 17 Avaliação de Impactos Ambientais 2 - 2 - 0 - 4 4 48\n" +
      "SIGLA DISCIPLINA T P E I Extensão (h) BIJ0207-15 Bases Conceituais da Energia 2 0 0 4 0";
    expect(parseCodeTable(text)).toEqual([
      { code: "BCJ0204-15", name: "Fenômenos Mecânicos", tpei: "4-1-0-6", category: "Obrigatória" },
      { code: "ESTU025-17", name: "Avaliação de Impactos Ambientais", tpei: "2-2-0-4", category: "Obrigatória" },
      { code: "BIJ0207-15", name: "Bases Conceituais da Energia", tpei: "2-0-0-4", category: "Obrigatória" },
    ]);
    expect(parseCodeTable(text, "Opção limitada")[0]!.category).toBe("Opção limitada");
  });

  it("descarta o tracinho e o 'Cálculo' duplicado nos títulos", () => {
    expect(parseBook("THOMAS, G. B. – Cálculo diferencial e integral. São Paulo: Pearson, 2012.")!.title).toBe("Cálculo diferencial e integral");
  });
});

describe("respostas e avaliação", () => {
  it("valida citações, inclusive intervalos e listas", () => {
    expect(parseCitations("Diz [1] e também [2, 3] e [5–6]; mas [9] não existe.", 6)).toEqual({ valid: [1, 2, 3, 5, 6], invalid: [9] });
  });

  it("junta pergunta de seguimento curta com a anterior para buscar", () => {
    expect(retrievalQuery("e a bibliografia?", [{ role: "user", content: "Ementa de Bases Matemáticas" }])).toBe("Ementa de Bases Matemáticas\ne a bibliografia?");
    expect(retrievalQuery("pergunta nova", [])).toBe("pergunta nova");
  });

  it("confere fatos ignorando acentos, caixa e espaços", () => {
    expect(factsFound("O TPEI é 2 - 2 - 0 - 4 e o código ESZU025.", [["2-2-0-4"], ["eszu025"], ["inexistente"]])).toEqual([true, true, false]);
  });

  it("reconhece quando a resposta admite que o acervo não cobre a pergunta", () => {
    expect(abstained("As fontes fornecidas não trazem a nota de corte do SiSU.")).toBe(true);
    expect(abstained("Não encontrei essa informação no acervo.")).toBe(true);
    expect(abstained("O prazo mínimo é de 9 quadrimestres [1].")).toBe(false);
  });

  it("funde rankings por RRF, premiando quem aparece nas duas listas", () => {
    const row = (id: number) => ({ id, doc_id: `d${id}`, repo: "r", path: "p", title: "t", subject: "s", section: "x", visibility: "publico" as const, heading: null, page_start: null, page_end: null, text: "" });
    const fused = fuse([row(1), row(2), row(3)], [row(3), row(4)]);
    expect(fused[0]!.chunkId).toBe(3);
    expect(fused[0]!.vectorRank).toBe(3);
    expect(fused[0]!.lexicalRank).toBe(1);
  });
});

describe("descoberta de arquivos", () => {
  it("converte globs com ** e *", () => {
    expect(globToRegExp("content/**").test("content/exams/p1.pdf")).toBe(true);
    expect(globToRegExp("**/media/**").test("content/media/img.png")).toBe(true);
    expect(globToRegExp("**/ilide.info-*.pdf").test("content/bibliography/ilide.info-bear.pdf")).toBe(true);
    expect(globToRegExp("README.md").test("docs/README.md")).toBe(false);
  });
});
