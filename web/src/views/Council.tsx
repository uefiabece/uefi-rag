import { useEffect, useRef, useState } from "react";
import { convene, getCouncil, isDemo, SECTION_LABEL, type CouncilInfo, type PerspectiveInfo, type Source } from "../api";
import { Markdown } from "../components/Markdown";

const SYNTHESIS = "sintese";

const STARTERS = [
  "O que é memória?",
  "O que significa dizer que um sistema aprende?",
  "Como sabemos que uma medida é confiável?",
  "O que é um modelo, e quando ele é bom o bastante?",
];

interface Column {
  sources: Source[];
  text: string;
  info: PerspectiveInfo | null;
}

interface Session {
  question: string;
  ids: string[];
  columns: Record<string, Column>;
  done: { latencyMs: number; inputTokens: number; outputTokens: number } | null;
  error: string | null;
  running: boolean;
}

const emptyColumn = (): Column => ({ sources: [], text: "", info: null });

export function Council({ publicOnly }: { publicOnly: boolean }) {
  const [council, setCouncil] = useState<CouncilInfo | null | undefined>(undefined);
  const [picked, setPicked] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [openSources, setOpenSources] = useState<string | null>(null);
  const [active, setActive] = useState<{ col: string; n: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getCouncil(publicOnly).then((c) => {
      setCouncil(c);
      if (c) setPicked((ids) => (ids.length ? ids : c.padrao));
    });
  }, [publicOnly]);

  if (council === undefined) return <p className="muted italic">Reunindo o conselho…</p>;
  if (council === null)
    return (
      <div className="empty-state">
        <h2>O conselho só se reúne com servidor</h2>
        <p className="muted">
          {isDemo()
            ? "Esta é a edição estática. Rode o projeto localmente para convocar os professores (veja o README)."
            : "A API não respondeu em /api/council."}
        </p>
      </div>
    );

  const byId = new Map(council.professores.map((p) => [p.id, p]));
  const running = session?.running ?? false;

  const toggle = (id: string) =>
    setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= 5 ? ids : [...ids, id]));

  const patch = (col: string, fn: (c: Column) => Partial<Column>) =>
    setSession((s) => (s ? { ...s, columns: { ...s.columns, [col]: { ...(s.columns[col] ?? emptyColumn()), ...fn(s.columns[col] ?? emptyColumn()) } } } : s));

  async function ask(question: string) {
    const q = question.trim();
    if (!q || running || picked.length < 2) return;
    const ids = council!.professores.filter((p) => picked.includes(p.id)).map((p) => p.id);
    setInput(q);
    setActive(null);
    setOpenSources(null);
    setSession({ question: q, ids, columns: Object.fromEntries([...ids, SYNTHESIS].map((id) => [id, emptyColumn()])), done: null, error: null, running: true });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await convene({ question: q, professors: ids, publicOnly }, {
        onSources: (id, sources) => patch(id, () => ({ sources })),
        onDelta: (id, text) => patch(id, (c) => ({ text: c.text + text })),
        onPerspective: (info) => patch(info.professor, () => ({ info })),
        onDone: (done) => setSession((s) => (s ? { ...s, done } : s)),
        onError: (error) => setSession((s) => (s ? { ...s, error } : s)),
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setSession((s) => (s ? { ...s, error: err instanceof Error ? err.message : String(err) } : s));
    } finally {
      setSession((s) => (s ? { ...s, running: false } : s));
    }
  }

  const synthesis = session?.columns[SYNTHESIS];

  return (
    <div>
      <p className="lede">Uma pergunta, várias áreas: cada professor explica pela própria lente, com o acervo da própria área.</p>

      <p className="kicker starts-title">
        Quem participa · {picked.length} de até 5
        {picked.length > 0 && (
          <>
            {" · "}
            <button className="link-btn" onClick={() => setPicked([])} disabled={running}>limpar</button>
            {" · "}
            <button className="link-btn" onClick={() => setPicked(council.padrao)} disabled={running}>padrão</button>
          </>
        )}
      </p>
      {council.grupos.map((g) => {
        const members = council.professores.filter((p) => p.grupo === g.id);
        if (!members.length) return null;
        return (
          <div key={g.id} className="council-group">
            <h3 className="section-title">
              <span>{g.nome}</span>
              <span>{members.filter((p) => picked.includes(p.id)).length || ""}</span>
            </h3>
            <div className="council-picker">
              {members.map((p) => {
                const on = picked.includes(p.id);
                return (
                  <button
                    key={p.id}
                    className={on ? "on" : ""}
                    onClick={() => toggle(p.id)}
                    disabled={running || (!on && picked.length >= 5)}
                    title={`${p.cursos}

Lente: ${p.lente}`}
                  >
                    <span className="area">{p.area}</span>
                    <span className="kicker">{p.documentos ? `${p.documentos} documentos no acervo` : "sem acervo"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <form
        className="composer"
        style={{ position: "static", marginTop: 20 }}
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          rows={1}
          value={input}
          placeholder="Uma questão que mereça mais de um olhar…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
        />
        {running ? (
          <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>Encerrar</button>
        ) : (
          <button className="btn solid" disabled={!input.trim() || picked.length < 2}>Convocar</button>
        )}
      </form>

      {!session && (
        <div className="council-starters">
          {STARTERS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={picked.length < 2}>{s}</button>
          ))}
        </div>
      )}

      {session && (
        <>
          <h2 className="council-question">{session.question}</h2>
          {session.error && <p className="notice">{session.error}</p>}

          <div className="council-columns" style={{ gridTemplateColumns: `repeat(${Math.min(session.ids.length, 3)}, minmax(0, 1fr))` }}>
            {session.ids.map((id) => {
              const prof = byId.get(id)!;
              const col = session.columns[id] ?? emptyColumn();
              const info = col.info;
              return (
                <article key={id} className="council-col">
                  <p className="kicker">{prof.area}</p>
                  <h3>{prof.titulo}</h3>
                  <p className="small italic muted" style={{ margin: "-6px 0 12px" }}>{prof.cursos}</p>
                  {info && !info.error && !info.grounded && (
                    <p className="tag dotted" style={{ marginBottom: 10 }}>sem acervo · toda a perspectiva é conhecimento geral</p>
                  )}
                  <div className="body">
                    {info?.error ? (
                      <p className="italic muted">{info.error}</p>
                    ) : col.text ? (
                      <Markdown
                        text={col.text}
                        sourceCount={col.sources.length}
                        active={active?.col === id ? active.n : null}
                        onCite={(n) => {
                          setActive({ col: id, n });
                          setOpenSources(id);
                        }}
                      />
                    ) : (
                      <p className="italic muted">{session.running ? "Pensando pela lente da área…" : "Sem resposta."}</p>
                    )}
                    {session.running && !info && col.text && <span className="caret" />}
                  </div>
                  <div className="meta" style={{ paddingLeft: 0 }}>
                    {info && !info.error && (
                      <>
                        {info.grounded ? (
                          <>
                            <span>{info.citations.valid.length} {info.citations.valid.length === 1 ? "citação" : "citações"} do acervo</span>
                            <span>{info.general} {info.general === 1 ? "afirmação marcada como geral" : "afirmações marcadas como gerais"}</span>
                          </>
                        ) : (
                          <span>nenhuma fonte do acervo</span>
                        )}
                        {info.citations.invalid.length > 0 && <span className="tag inverted">citação sem fonte: {info.citations.invalid.join(", ")}</span>}
                      </>
                    )}
                  </div>
                  {col.sources.length > 0 ? (
                    <div className="council-sources">
                      <button className="kicker" onClick={() => setOpenSources(openSources === id ? null : id)}>
                        {openSources === id ? "▾" : "▸"} {col.sources.length} trechos do acervo da área
                      </button>
                      {openSources === id &&
                        col.sources.map((s) => (
                          <div
                            key={s.n}
                            className={`source${active?.col === id && active.n === s.n ? " active" : ""}`}
                            onClick={() => setActive({ col: id, n: s.n })}
                          >
                            <div className="head">
                              <span className="n">{s.n}</span>
                              <span className="title">{s.title}</span>
                            </div>
                            <div className="where">
                              {s.subject} · <span className="italic">{(SECTION_LABEL[s.section] ?? s.section).toLowerCase()}</span>
                              {s.pages ? ` · ${s.pages}` : ""} {s.visibility === "privado" && <span className="tag dotted">privado</span>}
                            </div>
                            <div className="text">{s.text}</div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    null
                  )}
                </article>
              );
            })}
          </div>

          {(synthesis?.text || (session.running && session.ids.every((id) => session.columns[id]?.info))) && (
            <section className="council-synthesis">
              <p className="kicker">Síntese do conselho</p>
              <div className="body">
                {synthesis?.info?.error ? (
                  <p className="italic muted">{synthesis.info.error}</p>
                ) : synthesis?.text ? (
                  <Markdown text={synthesis.text} sourceCount={0} />
                ) : (
                  <p className="italic muted">Comparando as perspectivas…</p>
                )}
                {session.running && synthesis?.text && !synthesis.info && <span className="caret" />}
              </div>
            </section>
          )}

          {session.done && (
            <p className="small italic muted" style={{ textAlign: "center", marginTop: 20 }}>
              {(session.done.latencyMs / 1000).toFixed(1).replace(".", ",")} s ·{" "}
              {(session.done.inputTokens + session.done.outputTokens).toLocaleString("pt-BR")} tokens · {session.ids.length + 1} chamadas ao modelo
            </p>
          )}
        </>
      )}
    </div>
  );
}
