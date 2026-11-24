import { Fragment, useCallback, useEffect, useState } from "react";
import {
  formatUsd,
  getObservability,
  getTrace,
  isDemo,
  type CostSummary,
  type SpanRow,
  type StageStats,
  type TraceSummary,
} from "../api";

/** Nomes dos spans (server/src/trace.ts e chamadores) em português de gente, na ordem do pipeline. */
const STAGE: Record<string, string> = {
  "rag.resposta": "Resposta completa",
  "rag.conselho": "Conselho completo",
  "rag.conselho.professor": "Ramo de um professor",
  "rag.conselho.sintese": "Síntese",
  "rag.busca": "Busca híbrida",
  "rag.busca.vetorial": "Busca vetorial",
  "rag.embedding": "Embedding da pergunta",
  "rag.busca.lexica": "Busca léxica",
  "rag.rrf": "Fusão RRF",
  "rag.grafo": "Grafo de contexto",
  "rag.geracao": "Geração",
  "rag.citacoes": "Validação de citações",
};
const ORDER = Object.keys(STAGE);
const label = (name: string) => STAGE[name] ?? name;
const KIND: Record<string, string> = { "rag.resposta": "pergunta", "rag.conselho": "conselho", "rag.busca": "busca" };

function ms(x: number): string {
  if (x < 1) return "< 1 ms";
  if (x < 1000) return `${Math.round(x)} ms`;
  return `${(x / 1000).toFixed(1).replace(".", ",")} s`;
}

export function Observability() {
  const [data, setData] = useState<{ traces: TraceSummary[]; stages: { traces: number; stages: StageStats[] }; costs: CostSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getObservability()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isDemo()) load();
  }, [load]);

  if (isDemo())
    return (
      <div className="empty-state">
        <h2>Observabilidade precisa da API</h2>
        <p>
          A edição estática não grava traces. Rode <code>npm run serve</code> e <code>npm run dev</code>: cada pergunta e cada
          conselho passam a aparecer aqui, etapa por etapa, com tempo e custo.
        </p>
      </div>
    );
  if (error) return <p className="notice">Não foi possível ler os traces: {error}</p>;
  if (!data) return <p className="muted italic">Lendo os traces…</p>;

  const { traces, stages, costs } = data;
  if (!traces.length)
    return (
      <div className="empty-state">
        <h2>Nenhum trace ainda</h2>
        <p>Faça uma pergunta ou convoque o conselho: o trace aparece aqui logo depois da resposta.</p>
        <button className="btn" onClick={load}>Atualizar</button>
      </div>
    );

  const byName = new Map(stages.stages.map((s) => [s.name, s]));
  const resposta = byName.get("rag.resposta");
  const conselho = byName.get("rag.conselho");
  const rootErrors = traces.filter((t) => t.status === "erro").length;
  // Como no servidor: uma parcela sem preço torna o total desconhecido.
  const totalCost = costs.porProvedor.some((p) => p.custoUsd === null) ? null : costs.porProvedor.reduce((s, p) => s + p.custoUsd!, 0);
  const ordered = [...stages.stages].sort((a, b) => (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99));
  const maxP95 = Math.max(...ordered.map((s) => s.p95Ms), 1);

  return (
    <>
      <p className="small italic muted" style={{ marginTop: 0, textAlign: "center" }}>
        {stages.traces} traces mais recentes · gravados no banco local, sem texto de trechos ·{" "}
        <button className="link-btn" onClick={load} disabled={loading}>{loading ? "atualizando…" : "atualizar"}</button>
      </p>

      <div className="stats">
        <div className="stat"><div className="v">{resposta ? ms(resposta.p50Ms) : "–"}</div><div className="l">resposta, mediana{resposta ? ` (p95 ${ms(resposta.p95Ms)})` : ""}</div></div>
        <div className="stat"><div className="v">{conselho ? ms(conselho.p50Ms) : "–"}</div><div className="l">conselho, mediana{conselho ? ` (p95 ${ms(conselho.p95Ms)})` : ""}</div></div>
        <div className="stat"><div className="v">{formatUsd(totalCost)}</div><div className="l">custo registrado{costs.desde ? ` desde ${new Date(costs.desde).toLocaleDateString("pt-BR")}` : ""}</div></div>
        <div className="stat"><div className="v">{rootErrors}</div><div className="l">traces com erro</div></div>
      </div>

      <h3 className="section-title"><span>Tempo por etapa</span><span>mediana e p95 nos traces recentes</span></h3>
      <div className="stage-bars">
        <span /><span className="kicker">mediana · p95</span><span className="kicker num">n</span><span className="kicker num">erros</span>
        {ordered.map((s) => (
          <Fragment key={s.name}>
            <span title={s.name}>{label(s.name)}</span>
            <div className="bar-cell">
              <div className="bar stage">
                <i className="p95" style={{ width: `${(s.p95Ms / maxP95) * 100}%` }} />
                <i className="p50" style={{ width: `${(s.p50Ms / maxP95) * 100}%` }} />
              </div>
              <span className="stage-ms">{ms(s.p50Ms)} · {ms(s.p95Ms)}</span>
            </div>
            <span className="num">{s.count}</span>
            <span className="num">{s.errors || "—"}</span>
          </Fragment>
        ))}
      </div>

      <h3 className="section-title" style={{ marginTop: 36 }}><span>Custo por provedor</span><span>preços de precos.config.json</span></h3>
      {costs.porProvedor.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Provedor · modelo</th><th className="num">Consultas</th><th className="num">Chamadas</th><th className="num">Tokens</th><th className="num">Custo</th></tr>
            </thead>
            <tbody>
              {costs.porProvedor.map((p) => (
                <tr key={`${p.provedor}:${p.modelo}`}>
                  <td><span className="kicker">{p.provedor}</span> {p.modelo}</td>
                  <td className="num">{p.consultas}</td>
                  <td className="num">{p.chamadas}</td>
                  <td className="num">{(p.inputTokens + p.outputTokens).toLocaleString("pt-BR")}</td>
                  <td className="num">{formatUsd(p.custoUsd)}{p.semPreco ? <div className="small muted">{p.semPreco} sem preço</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted italic small">Nenhuma consulta registrada.</p>
      )}

      <h3 className="section-title" style={{ marginTop: 36 }}><span>Traces recentes</span><span>clique para ver a cascata de etapas</span></h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Quando</th><th>Tipo</th><th className="num">Duração</th><th>Modelo</th>
              <th className="num">Tokens</th><th className="num">Custo</th><th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <Fragment key={t.traceId}>
                <tr className={`clickable${open === t.traceId ? " selected" : ""}`} onClick={() => setOpen(open === t.traceId ? null : t.traceId)}>
                  <td className="small">{new Date(t.startMs).toLocaleString("pt-BR")}</td>
                  <td>
                    <span className="tag">{KIND[t.name] ?? t.name}</span>
                    {t.professors.length > 0 && <div className="small muted">{t.professors.join(", ")}</div>}
                  </td>
                  <td className="num">{ms(t.durationMs)}</td>
                  <td className="small">{t.models.join(", ") || "—"}</td>
                  <td className="num">{t.inputTokens + t.outputTokens ? (t.inputTokens + t.outputTokens).toLocaleString("pt-BR") : "—"}</td>
                  <td className="num">{t.models.length ? formatUsd(t.costUsd) : "—"}</td>
                  <td>
                    {t.status === "erro" || t.errors ? <span className="tag inverted">{t.errors || 1} erro{t.errors > 1 ? "s" : ""}</span> : <span className="tag strong">ok</span>}
                    {t.invalidCitations > 0 && <span className="tag inverted" style={{ marginLeft: 4 }}>{t.invalidCitations} citação inválida</span>}
                  </td>
                </tr>
                {open === t.traceId && (
                  <tr>
                    <td colSpan={7} className="item-detail"><Waterfall traceId={t.traceId} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface Node extends SpanRow {
  depth: number;
}

/** Ordena em profundidade pelos parentId: a ordem de início sozinha mistura ramos que começam juntos. */
function flatten(spans: SpanRow[]): Node[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string | null, SpanRow[]>();
  for (const s of spans) {
    // Pai que não chegou ao banco (lote perdido) vira raiz, para o span não sumir da cascata.
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const out: Node[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of (children.get(parent) ?? []).sort((a, b) => a.startMs - b.startMs)) {
      out.push({ ...s, depth });
      walk(s.spanId, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function Waterfall({ traceId }: { traceId: string }) {
  const [spans, setSpans] = useState<SpanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    getTrace(traceId).then(setSpans).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [traceId]);

  if (error) return <p className="notice">{error}</p>;
  if (!spans) return <p className="muted italic small">Carregando a cascata…</p>;

  const nodes = flatten(spans);
  const t0 = Math.min(...spans.map((s) => s.startMs));
  const total = Math.max(...spans.map((s) => s.startMs + s.durationMs)) - t0 || 1;
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / total) * 100))}%`;
  const sel = nodes.find((n) => n.spanId === selected);

  return (
    <div>
      <div className="waterfall">
        <div className="wf-axis">
          <span>0</span><span>{ms(total / 2)}</span><span>{ms(total)}</span>
        </div>
        {nodes.map((n) => (
          <div
            key={n.spanId}
            className={`wf-row${n.spanId === selected ? " selected" : ""}`}
            onClick={() => setSelected(n.spanId === selected ? null : n.spanId)}
          >
            <span className="wf-name" style={{ paddingLeft: n.depth * 14 }} title={n.name}>
              {label(n.name)}
              {typeof n.attributes["rag.professor.id"] === "string" && n.name !== "rag.geracao" && (
                <span className="muted"> · {String(n.attributes["rag.professor.id"])}</span>
              )}
            </span>
            <div className="wf-track">
              <i
                className={n.status === "erro" ? "erro" : ""}
                style={{ left: pct(n.startMs - t0), width: `max(2px, ${pct(n.durationMs)})` }}
              />
              {n.events.map((e, i) => (
                <b key={i} title={`${e.name} em ${ms(e.offsetMs)}`} style={{ left: pct(n.startMs - t0 + e.offsetMs) }} />
              ))}
            </div>
            <span className="wf-ms">{ms(n.durationMs)}</span>
          </div>
        ))}
      </div>
      <p className="small muted italic" style={{ margin: "8px 0 0" }}>
        Traço vertical: primeiro token da geração. Clique numa etapa para ver os atributos.
      </p>
      {sel && (
        <div className="small" style={{ marginTop: 10 }}>
          <b>{label(sel.name)}</b> <code>{sel.name}</code>
          {sel.statusMessage && <div className="tag inverted" style={{ margin: "4px 0" }}>{sel.statusMessage}</div>}
          <table style={{ marginTop: 6 }}>
            <tbody>
              {Object.entries(sel.attributes).map(([k, v]) => (
                <tr key={k}>
                  <td className="mono" style={{ width: "40%" }}>{k}</td>
                  <td className="mono">{Array.isArray(v) ? v.join(", ") : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
