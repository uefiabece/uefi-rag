import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../src/config.js";
import {
  convene,
  countGeneral,
  loadCouncil,
  professorPrompt,
  renderPerspectives,
  selectProfessors,
  SYNTHESIS_ID,
  type CouncilEvent,
} from "../src/council.js";
import type { ChatTurn, Generator } from "../src/generate.js";

const config = loadCouncil();
const byId = (id: string) => config.professores.find((p) => p.id === id)!;

/** Gerador falso: responde conforme o papel no prompt de sistema, em dois pedaços, para exercitar o stream. */
function fakeGenerator(failFor?: string): Generator & { calls: { system: string; messages: ChatTurn[] }[] } {
  const calls: { system: string; messages: ChatTurn[] }[] = [];
  return {
    provider: "ollama",
    model: "falso",
    calls,
    async stream(system, messages, onText) {
      calls.push({ system, messages });
      if (failFor && system.includes(failFor)) throw new Error("caiu");
      const text = system.startsWith("Você media")
        ? "As áreas convergem em X."
        : `Pela minha área, o ponto central é Y [geral]. Outro ponto [geral].`;
      onText(text.slice(0, 10));
      onText(text.slice(10));
      return { text, model: "falso", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
}

describe("configuração do conselho", () => {
  const corpus = JSON.parse(readFileSync(path.join(ROOT, "corpus.config.json"), "utf8")) as { repos: { name: string }[] };
  const knownRepos = new Set(corpus.repos.map((r) => r.name));

  it("tem um professor por curso, com ids únicos e grupo válido", () => {
    const ids = config.professores.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(config.professores).toHaveLength(27);
    const grupos = new Set(config.grupos.map((g) => g.id));
    for (const p of config.professores) {
      expect(grupos.has(p.grupo), `${p.id}: grupo ${p.grupo}`).toBe(true);
      expect(p.lente.length, `${p.id}: lente vazia`).toBeGreaterThan(40);
      expect(p.cursos, `${p.id}: cursos`).toBeTruthy();
    }
  });

  it("só aponta para repositórios que existem no acervo, e o padrão existe", () => {
    for (const p of config.professores) for (const r of p.repos) expect(knownRepos.has(r), `${p.id} → ${r}`).toBe(true);
    for (const id of config.padrao) expect(ids(config).includes(id), id).toBe(true);
  });

  it("licenciaturas compartilhadas aparecem no professor da área", () => {
    for (const id of ["biologia", "fisica", "matematica", "quimica"]) expect(byId(id).cursos).toMatch(/Licenciatura.*LCNE/);
    expect(byId("ciencias-e-humanidades").cursos).toMatch(/BC&H.*LCH/);
    expect(config.professores.filter((p) => p.area === "Filosofia")).toHaveLength(1);
  });
});

const ids = (c: typeof config) => c.professores.map((p) => p.id);

describe("conselho de professores", () => {
  it("usa o padrão quando ninguém é escolhido e mantém a ordem da configuração", () => {
    const inConfigOrder = config.professores.map((p) => p.id).filter((id) => config.padrao.includes(id));
    expect(selectProfessors(config).map((p) => p.id)).toEqual(inConfigOrder);
    expect(selectProfessors(config, ["historia", "neurociencia"]).map((p) => p.id)).toEqual(["neurociencia", "historia"]);
  });

  it("recusa professor desconhecido e conselho de um só", () => {
    expect(() => selectProfessors(config, ["neurociencia", "astrologia"])).toThrow(/astrologia/);
    expect(() => selectProfessors(config, ["neurociencia"])).toThrow(/dois/);
  });

  it("o prompt de cada professor traz a sua lente, os colegas e a regra do [geral]", () => {
    const council = selectProfessors(config, ["neurociencia", "computacao", "historia"]);
    const prompt = professorPrompt(byId("computacao"), council, false);
    expect(prompt).toContain(byId("computacao").lente);
    expect(prompt).toContain("Neurociência, História");
    expect(prompt).toContain("representando Bacharelado em Ciência da Computação");
    expect(prompt).toContain("Você é professor de Ciência da Computação da UFABC");
    const colleagues = /Também estão no conselho: ([^.]+)\./.exec(prompt)![1]!;
    expect(colleagues).toBe("Neurociência, História");
    expect(prompt).toContain("[geral]");
    expect(prompt).toContain("O acervo não tem material da sua área");
    expect(professorPrompt(byId("neurociencia"), council, true)).toContain("cite a fonte entre colchetes");
    // No teste com um modelo local, professores sem acervo inventaram a duração dos cursos.
    expect(prompt).toContain("Fatos sobre a UFABC");
  });

  it("conta afirmações marcadas como conhecimento geral", () => {
    expect(countGeneral("Um [geral]. Dois [Geral]. Três [1].")).toBe(2);
  });

  it("entrega à síntese as perspectivas com a contagem de fontes de cada uma", () => {
    const out = renderPerspectives([
      { prof: byId("matematica"), text: "Com fonte [1].", cited: 1, general: 3, grounded: true },
      { prof: byId("historia"), text: "Sem marca nenhuma.", cited: 0, general: 0, grounded: false },
    ]);
    expect(out).toContain('area="Matemática" citacoes_do_acervo="1" afirmacoes_gerais="3"');
    // Sem acervo, a perspectiva é geral por construção, mesmo que o modelo não tenha marcado [geral].
    expect(out).toContain('area="História" origem="conhecimento geral, sem acervo"');
  });

  it("roda os professores em paralelo, identifica cada evento e fecha com a síntese", async () => {
    const events: CouncilEvent[] = [];
    const gen = fakeGenerator();
    await convene("O que é memória?", { professors: ["computacao", "historia"], generator: gen, onEvent: (e) => events.push(e) });

    expect(events[0]).toMatchObject({ type: "professores" });
    const finished = events.filter((e) => e.type === "perspectiva");
    expect(finished.map((e) => e.professor)).toEqual(expect.arrayContaining(["computacao", "historia", SYNTHESIS_ID]));
    expect(finished.at(-1)!.professor).toBe(SYNTHESIS_ID);
    const comp = finished.find((e) => e.professor === "computacao")!;
    expect(comp.type === "perspectiva" && comp.general).toBe(2);
    expect(comp.type === "perspectiva" && comp.grounded).toBe(false);

    const deltas = events.filter((e): e is Extract<CouncilEvent, { type: "delta" }> => e.type === "delta");
    expect(deltas.filter((d) => d.professor === "historia").map((d) => d.text).join("")).toContain("ponto central");

    // A síntese recebe as duas perspectivas, e só ela.
    const synthesis = gen.calls.find((c) => c.system.startsWith("Você media"))!;
    expect(synthesis.messages[0]!.content).toContain('area="Ciência da Computação"');
    expect(synthesis.messages[0]!.content).toContain('area="História"');
    expect(events.at(-1)).toMatchObject({ type: "done", inputTokens: 300, outputTokens: 150 });
  });

  it("segue sem o professor que falhou e só sintetiza com pelo menos duas perspectivas", async () => {
    const events: CouncilEvent[] = [];
    await convene("Pergunta", {
      professors: ["computacao", "historia"],
      generator: fakeGenerator("professor de Ciência da Computação"),
      onEvent: (e) => events.push(e),
    });
    const comp = events.find((e) => e.type === "perspectiva" && e.professor === "computacao");
    expect(comp).toMatchObject({ error: "caiu" });
    expect(events.some((e) => e.type === "perspectiva" && e.professor === SYNTHESIS_ID)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});
