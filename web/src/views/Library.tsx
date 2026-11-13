import { useEffect, useMemo, useState } from "react";
import { getChunks, getDocuments, SECTION_LABEL, type ChunkRow, type DocumentRow } from "../api";

const FLAG_LABEL: Record<string, string> = {
  "sem-texto": "sem texto (digitalizado?)",
  "texto-corrompido": "texto corrompido",
  truncado: "truncado",
  "poucas-palavras": "poucas palavras",
};

export function Library() {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [filter, setFilter] = useState("");
  const [section, setSection] = useState("");
  const [selected, setSelected] = useState<DocumentRow | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);

  useEffect(() => {
    getDocuments().then(setDocs).catch(() => setDocs([]));
  }, []);

  useEffect(() => {
    if (selected) getChunks(selected.id).then(setChunks);
  }, [selected]);

  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    return (docs ?? []).filter(
      (d) => (!section || d.section === section) && (!q || `${d.title} ${d.subject} ${d.path}`.toLowerCase().includes(q)),
    );
  }, [docs, filter, section]);

  const totals = useMemo(
    () => ({
      docs: docs?.length ?? 0,
      chunks: docs?.reduce((n, d) => n + d.chunks, 0) ?? 0,
      tokens: docs?.reduce((n, d) => n + d.tokens, 0) ?? 0,
      flagged: docs?.filter((d) => d.quality.flags.length).length ?? 0,
      private: docs?.filter((d) => d.visibility === "privado").length ?? 0,
    }),
    [docs],
  );

  if (!docs) return <p className="muted italic">Carregando o acervo…</p>;
  const sections = [...new Set(docs.map((d) => d.section))].sort();

  return (
    <>
      <div className="stats">
        <div className="stat"><div className="v">{totals.docs}</div><div className="l">documentos</div></div>
        <div className="stat"><div className="v">{totals.chunks.toLocaleString("pt-BR")}</div><div className="l">trechos indexados</div></div>
        <div className="stat"><div className="v">{(totals.tokens / 1000).toFixed(0)} mil</div><div className="l">tokens (estimados)</div></div>
        <div className="stat"><div className="v">{totals.flagged}</div><div className="l">com problema de extração</div></div>
        {totals.private > 0 && <div className="stat"><div className="v">{totals.private}</div><div className="l">de repositórios privados</div></div>}
      </div>
      <div className="columns">
        <section className="main-col">
          <div className="filters">
            <input className="field" placeholder="Filtrar por título, disciplina ou caminho" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
            <select className="field" value={section} onChange={(e) => setSection(e.target.value)}>
              <option value="">Todos os tipos</option>
              {sections.map((s) => <option key={s} value={s}>{SECTION_LABEL[s] ?? s}</option>)}
            </select>
          </div>
          <div>
            <table>
              <thead>
                <tr><th>Documento</th><th>Tipo</th><th className="num">Págs.</th><th className="num">Trechos</th></tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className={`clickable${selected?.id === d.id ? " selected" : ""}`} onClick={() => setSelected(d)}>
                    <td>
                      <div className="doc-title">{d.title}</div>
                      <div className="small muted italic">{d.subject}</div>
                      <div className="tags">
                        {d.visibility === "privado" && <span className="tag dotted">privado</span>}
                        {d.quality.flags.map((f) => <span key={f} className="tag strong">{FLAG_LABEL[f] ?? f}</span>)}
                      </div>
                    </td>
                    <td>{SECTION_LABEL[d.section] ?? d.section}<div className="small muted">{d.format}</div></td>
                    <td className="num">{d.pages ?? "–"}</td>
                    <td className="num">{d.chunks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <aside>
          {!selected ? (
            <>
              <h3 className="section-title"><span>Trechos</span></h3>
              <p className="small italic muted">
                Escolha um documento para ver como ele foi limpo e dividido: cada trecho guarda o título de seção mais próximo e o
                intervalo de páginas, que viram a citação na resposta.
              </p>
            </>
          ) : (
            <>
              <h3 className="section-title"><span>Trechos · {chunks.length}</span></h3>
              <h2 style={{ font: "700 22px/1.2 var(--display)", margin: "0 0 4px" }}>{selected.title}</h2>
              <div className="small muted mono">{selected.repo}/{selected.path}</div>
              <div className="small muted" style={{ margin: "6px 0 10px" }}>
                {selected.chars.toLocaleString("pt-BR")} caracteres · {selected.quality.removedBoilerplate.toLocaleString("pt-BR")} removidos como
                cabeçalho/rodapé · {selected.quality.emptyPages} páginas vazias
              </div>
              {chunks.map((c) => (
                <div className="chunk" key={c.ord}>
                  <div className="h">
                    <span className="mono">#{c.ord}</span>
                    {c.page_start && <span>p. {c.page_start}{c.page_end !== c.page_start ? `–${c.page_end}` : ""}</span>}
                    {c.heading && <span>§ {c.heading}</span>}
                    <span style={{ marginLeft: "auto" }}>{c.tokens} tok</span>
                  </div>
                  <pre>{c.text}</pre>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
