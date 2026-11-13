import { useEffect, useRef, useState } from "react";
import { ask, getEval, isDemo, SECTION_LABEL, type DoneInfo, type EvalItemResult, type Health, type Source } from "../api";
import { Markdown } from "../components/Markdown";

interface Turn {
  question: string;
  sources: Source[];
  text: string;
  done: DoneInfo | null;
  error: string | null;
  streaming: boolean;
  recorded?: boolean;
}

const SUGGESTIONS = [
  { label: "Um número no PPC", text: "Quantas horas de opção limitada o BC&T exige no PPC 2023?" },
  { label: "Regra de transição", text: "Entrei em Biotecnologia em 2021. Sou obrigado a migrar para o PPC 2023?" },
  { label: "Uma disciplina em dois cursos", text: "Fenômenos Mecânicos é obrigatória na Biotecnologia? Qual o TPEI?" },
  { label: "Como funciona a matrícula", text: "As disciplinas do BC&T têm pré-requisitos?" },
  { label: "O ecossistema UÉFIabecê", text: "Qual servidor MCP do UÉFIabecê cobre Fenômenos Mecânicos?" },
  { label: "Fora do acervo", text: "Qual foi a nota de corte do SiSU para o BC&T em 2026?" },
];

/** Na demo estática, as respostas gravadas na avaliação são reproduzidas como se chegassem em stream. */
function replay(item: EvalItemResult, setTurn: (t: Turn) => void) {
  const a = item.answer!;
  const sources: Source[] = (a.sources ?? []).map((s) => ({
    n: s.n,
    kind: s.docId ? "trecho" : "grafo",
    docId: s.docId,
    repo: s.docId?.split("/")[0] ?? null,
    title: s.title,
    subject: s.subject,
    section: s.docId ? "bibliography" : "grafo",
    heading: s.heading,
    pages: s.pages,
    visibility: "publico",
    text: "",
    score: null,
  }));
  const full = a.text ?? "";
  let i = 0;
  const base: Turn = { question: item.pergunta, sources, text: "", done: null, error: null, streaming: true, recorded: true };
  setTurn(base);
  const timer = setInterval(() => {
    i = Math.min(full.length, i + 6 + Math.floor(Math.random() * 10));
    const finished = i >= full.length;
    setTurn({
      ...base,
      text: full.slice(0, i),
      streaming: !finished,
      done: finished
        ? {
            citations: a.citations ?? { valid: [], invalid: [] },
            model: a.model ?? "",
            provider: "gravado",
            stopReason: null,
            usage: null,
            latencyMs: a.latencyMs ?? 0,
            retrievalMs: 0,
          }
        : null,
    });
    if (finished) clearInterval(timer);
  }, 24);
}

export function Ask({
  publicOnly,
  health,
  onPublicOnly,
}: {
  publicOnly: boolean;
  health: Health;
  onPublicOnly: (v: boolean) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [active, setActive] = useState<{ turn: number; n: number } | null>(null);
  const [recorded, setRecorded] = useState<EvalItemResult[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const demo = isDemo();

  useEffect(() => {
    if (demo) getEval().then((r) => setRecorded(r?.items.filter((i) => i.answer?.text) ?? []));
  }, [demo]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length]);

  const busy = turns.at(-1)?.streaming ?? false;
  const shownTurn = active?.turn ?? turns.length - 1;
  const shown = turns[shownTurn];

  const update = (idx: number, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((ts) => ts.map((t, i) => (i === idx ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)));

  async function submit(question: string) {
    const q = question.trim();
    if (!q || busy || demo) return;
    setInput("");
    setActive(null);
    const idx = turns.length;
    const history = turns
      .filter((t) => t.done && !t.recorded)
      .flatMap((t) => [
        { role: "user" as const, content: t.question },
        { role: "assistant" as const, content: t.text },
      ]);
    setTurns((ts) => [...ts, { question: q, sources: [], text: "", done: null, error: null, streaming: true }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await ask({ question: q, history, publicOnly }, {
        onSources: (sources) => update(idx, { sources }),
        onDelta: (d) => update(idx, (t) => ({ text: t.text + d })),
        onDone: (done) => update(idx, { done }),
        onError: (error) => update(idx, { error }),
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) update(idx, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      update(idx, { streaming: false });
    }
  }

  const playRecorded = (item: EvalItemResult) => {
    const idx = turns.length;
    setActive(null);
    setTurns((ts) => [...ts, { question: item.pergunta, sources: [], text: "", done: null, error: null, streaming: true }]);
    replay(item, (t) => setTurns((ts) => ts.map((x, i) => (i === idx ? t : x))));
  };

  return (
    <div className="columns">
      <section className="main-col">
        {turns.length === 0 && (
          <div>
            <p className="lede">Pergunte ao acervo; a resposta mostra de que página tirou cada afirmação.</p>
            {demo ? (
              recorded.length ? (
                <>
                  <p className="kicker starts-title">Respostas gravadas na última avaliação</p>
                  <div className="starts">
                    {recorded.slice(0, 10).map((r) => (
                      <button key={r.id} onClick={() => playRecorded(r)}>
                        <span className="kicker">{r.tipo}</span>
                        {r.pergunta}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="notice" style={{ marginTop: 32 }}>
                  Esta é a edição estática, sem servidor: para perguntar, rode o projeto localmente (veja o README). O grafo,
                  o acervo e a avaliação continuam navegáveis nas outras seções.
                </p>
              )
            ) : (
              <>
                <p className="kicker starts-title">Pontos de partida</p>
                <div className="starts">
                  {SUGGESTIONS.map((s) => (
                    <button key={s.text} onClick={() => submit(s.text)}>
                      <span className="kicker">{s.label}</span>
                      {s.text}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div className="thread">
          {turns.map((t, i) => (
            <div
              key={i}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
              onClick={() => setActive((a) => (a?.turn === i ? a : { turn: i, n: 0 }))}
            >
              <div className="q">{t.question}</div>
              <div className="a">
                <p className="kicker">
                  {t.error
                    ? "Falhou"
                    : t.streaming
                      ? t.sources.length
                        ? "Escrevendo"
                        : "Consultando o acervo"
                      : t.recorded
                        ? "Resposta gravada"
                        : "Resposta"}
                </p>
                <div className="body">
                  {t.error ? (
                    <p className="italic muted">{t.error}</p>
                  ) : t.text ? (
                    <Markdown
                      text={t.text}
                      sourceCount={t.sources.length}
                      active={active?.turn === i ? active.n : null}
                      onCite={(n) => setActive({ turn: i, n })}
                    />
                  ) : (
                    <p className="italic muted">
                      {t.sources.length ? `${t.sources.length} trechos encontrados…` : "Buscando nos documentos…"}
                    </p>
                  )}
                  {t.streaming && t.text && <span className="caret" />}
                </div>
                {t.done && (
                  <div className="meta">
                    {t.done.model && <span>{t.done.model}</span>}
                    {t.done.latencyMs > 0 && <span>{(t.done.latencyMs / 1000).toFixed(1)} s</span>}
                    {t.done.retrievalMs > 0 && <span>busca em {t.done.retrievalMs} ms</span>}
                    {t.done.usage && (
                      <span>{(t.done.usage.inputTokens + t.done.usage.outputTokens).toLocaleString("pt-BR")} tokens</span>
                    )}
                    <span>{t.done.citations.valid.length} fontes citadas</span>
                    {t.done.citations.invalid.length > 0 && (
                      <span className="tag inverted">citação sem fonte: {t.done.citations.invalid.join(", ")}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {!demo && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            <textarea
              rows={1}
              value={input}
              placeholder="O que você quer saber sobre um curso, uma disciplina ou uma prova?"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
            />
            {busy ? (
              <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
                Parar
              </button>
            ) : (
              <button className="btn solid" disabled={!input.trim()}>
                Perguntar
              </button>
            )}
          </form>
        )}
      </section>

      <aside>
        <h3 className="section-title">
          <span>Fontes{shown ? ` · ${shown.sources.length}` : ""}</span>
        </h3>
        {!shown?.sources.length && (
          <p className="small italic muted">
            Os trechos recuperados aparecem aqui antes da resposta começar. Clique num número da resposta para abrir o trecho.
          </p>
        )}
        {shown?.sources.map((s) => {
          const isActive = active?.turn === shownTurn && active.n === s.n;
          const cited = !shown.done || shown.done.citations.valid.includes(s.n);
          return (
            <div
              key={s.n}
              className={`source${isActive ? " active" : ""}${cited ? "" : " uncited"}`}
              onClick={() => setActive(isActive ? null : { turn: shownTurn, n: s.n })}
            >
              <div className="head">
                <span className="n">{s.n}</span>
                <span className="title">{s.title}</span>
              </div>
              <div className="where">
                {s.subject} · <span className="italic">{(SECTION_LABEL[s.section] ?? s.section).toLowerCase()}</span>
                {s.pages ? ` · ${s.pages}` : ""} {s.visibility === "privado" && <span className="tag dotted">privado</span>}
              </div>
              {s.heading && <div className="where">§ {s.heading}</div>}
              {s.text && <div className="text">{s.text}</div>}
            </div>
          );
        })}

        <h3 className="section-title" style={{ marginTop: 28 }}>
          <span>Edição</span>
        </h3>
        <p className="small muted" style={{ margin: 0 }}>
          {health.demo ? "Estática, sem servidor" : `Gerador: ${health.generator}`}
          <br />
          Embeddings: {health.embedding ?? "—"}
        </p>
        {!health.demo && !health.publicOnly && (
          <label className="check" style={{ marginTop: 10, padding: 0 }}>
            <input type="checkbox" checked={publicOnly} onChange={() => onPublicOnly(!publicOnly)} />
            Responder só com repositórios públicos
          </label>
        )}
      </aside>
    </div>
  );
}
