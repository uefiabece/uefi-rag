import { Fragment, useEffect, useState } from "react";
import { getEval, type EvalReport } from "../api";

const MODE_LABEL: Record<string, string> = { hybrid: "Híbrida", vector: "Vetorial", lexical: "Léxica" };
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);

export function Evaluation() {
  const [report, setReport] = useState<EvalReport | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    getEval().then(setReport);
  }, []);

  if (report === undefined) return <p className="muted italic">Carregando a avaliação…</p>;
  if (!report)
    return (
      <div className="empty-state">
        <h2>Nenhuma avaliação ainda</h2>
        <p>Rode <code>npm run eval</code> para medir recuperação e respostas no conjunto público de perguntas.</p>
      </div>
    );

  const a = report.answers;
  return (
    <>
      <p className="small italic muted" style={{ marginTop: 0, textAlign: "center" }}>
        {new Date(report.date).toLocaleString("pt-BR")} · conjunto {report.set} · {report.items.length} perguntas escritas à mão ·
        embeddings {report.embedding} · k = {report.k}
        {report.generator ? ` · respostas por ${report.generator}` : " · só recuperação (sem gerador)"}
      </p>

      {a && a.n === 0 && (
        <p className="notice" style={{ marginBottom: 28 }}>
          Nenhuma resposta foi avaliada nesta rodada: as {report.items.length} chamadas ao gerador falharam
          {report.items[0]?.answer?.error ? ` (${report.items[0].answer.error})` : ""}. A recuperação abaixo não depende do gerador.
        </p>
      )}
      {a && a.n > 0 && (
        <div className="stats">
          <div className="stat"><div className="v">{pct(a.pass)}</div><div className="l">respostas aprovadas</div></div>
          <div className="stat"><div className="v">{pct(a.factsOk)}</div><div className="l">com todos os fatos do gabarito</div></div>
          <div className="stat"><div className="v">{pct(a.citedExpected)}</div><div className="l">citam o documento esperado</div></div>
          <div className="stat"><div className="v">{pct(a.abstainedCorrectly)}</div><div className="l">recusam o que não está no acervo</div></div>
          <div className="stat"><div className="v">{a.invalidCitations}</div><div className="l">citações sem fonte</div></div>
          <div className="stat"><div className="v">{(a.medianLatencyMs / 1000).toFixed(1).replace(".", ",")} s</div><div className="l">latência mediana</div></div>
        </div>
      )}

      <h3 className="section-title"><span>Recuperação</span><span>o documento esperado está entre os k trechos devolvidos?</span></h3>
      <div style={{ padding: "6px 0 4px" }}>
        <div className="bars">
          <span />
          <span className="kicker">hit@1</span><span className="kicker">hit@3</span><span className="kicker">hit@8</span><span className="kicker">MRR</span>
          {Object.entries(report.retrieval).map(([mode, m]) => (
            <Fragment key={mode}>
              <span>{MODE_LABEL[mode] ?? mode}</span>
              {[m.hit1, m.hit3, m.hit8, m.mrr].map((v, i) => (
                <div key={i} className="bar-cell">
                  <div className="bar"><i style={{ width: `${v * 100}%` }} /></div>
                  <span>{i === 3 ? v.toFixed(2).replace(".", ",") : pct(v)}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>

      <h3 className="section-title" style={{ marginTop: 36 }}><span>Perguntas</span><span>posição do primeiro trecho do documento esperado em cada busca</span></h3>
      <div>
        <table>
          <thead>
            <tr>
              <th>Pergunta</th><th>Tipo</th>
              <th className="num">Híbr.</th><th className="num">Vet.</th><th className="num">Léx.</th>
              {a && <th>Resposta</th>}
            </tr>
          </thead>
          <tbody>
            {report.items.map((it) => (
              <Fragment key={it.id}>
                <tr className="clickable" onClick={() => setOpen(open === it.id ? null : it.id)}>
                  <td><span className="kicker">{it.id}</span> {it.pergunta}</td>
                  <td><span className="tag">{it.tipo}</span></td>
                  {(["hybrid", "vector", "lexical"] as const).map((m) => (
                    <td key={m} className="num rank">{it.fontes.length ? it.retrieval[m]?.rank ?? "✗" : "—"}</td>
                  ))}
                  {a && (
                    <td>
                      {it.answer?.error ? <span className="tag dotted">erro</span> : it.answer?.pass ? <span className="tag strong">aprovada</span> : <span className="tag inverted">reprovada</span>}
                    </td>
                  )}
                </tr>
                {open === it.id && (
                  <tr>
                    <td colSpan={a ? 6 : 5} className="item-detail">
                      {it.nota && <p style={{ marginTop: 0 }}><b>Nota:</b> {it.nota}</p>}
                      {it.fontes.length > 0 ? (
                        <div className="small"><b>Documentos esperados:</b> {it.fontes.map((f) => f.split("/").pop()).join(", ")}</div>
                      ) : (
                        <div className="small"><b>Fora do acervo:</b> a resposta certa é dizer que não há essa informação.</div>
                      )}
                      {it.fatos.length > 0 && (
                        <div className="small">
                          <b>Fatos exigidos:</b>{" "}
                          {it.fatos.map((g, i) => (
                            <span key={i} className={`tag ${it.answer?.factsFound ? (it.answer.factsFound[i] ? "strong" : "inverted") : ""}`} style={{ marginRight: 4 }}>
                              {g.join(" / ")}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="small" style={{ marginTop: 6 }}>
                        <b>Híbrida devolveu:</b> {it.retrieval.hybrid?.docs.map((d) => d.split("/").pop()).join(" · ")}
                      </div>
                      {it.answer?.text && <pre>{it.answer.text}</pre>}
                      {it.answer?.error && <pre>{it.answer.error}</pre>}
                    </td>
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
