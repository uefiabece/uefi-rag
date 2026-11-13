import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getGraph, type GraphEdge, type GraphNode } from "../api";

type NodeType = GraphNode["type"];
const TYPES: { type: NodeType; label: string }[] = [
  { type: "curso", label: "Cursos" },
  { type: "disciplina", label: "Disciplinas" },
  { type: "conceito", label: "Conceitos" },
  { type: "livro", label: "Livros" },
];

const EDGE_LABEL: Record<string, [string, string]> = {
  pertence: ["Cursos", "Disciplinas do curso"],
  aborda: ["Conceitos da ementa", "Aparece nas ementas de"],
  bibliografia_basica: ["Bibliografia básica", "Bibliografia básica de"],
  bibliografia_complementar: ["Bibliografia complementar", "Bibliografia complementar de"],
  recomenda: ["Recomendada para", "Recomendadas antes"],
  compartilha: ["Conteúdo em comum com", "Conteúdo em comum com"],
};

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: GraphNode;
  degree: number;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ── Formas: o tipo do nó se lê pelo desenho, não pela cor ───────────────────
function nodeSize(n: { node: GraphNode; degree: number }): number {
  if (n.node.type === "curso") return 11;
  if (n.node.type === "disciplina") return Math.min(9, 4 + Math.sqrt(n.degree) * 0.9);
  return 4.5;
}

function Shape({ type, x, y, r, strong }: { type: NodeType; x: number; y: number; r: number; strong?: boolean }) {
  const sw = strong ? 2.2 : 1.3;
  switch (type) {
    case "curso":
      return (
        <rect
          x={x - r * 0.75}
          y={y - r * 0.75}
          width={r * 1.5}
          height={r * 1.5}
          transform={`rotate(45 ${x} ${y})`}
          fill="var(--ink)"
          stroke="var(--ink)"
          strokeWidth={sw}
        />
      );
    case "disciplina":
      return <circle cx={x} cy={y} r={r} fill="var(--ink)" stroke={strong ? "var(--paper)" : "var(--ink)"} strokeWidth={sw} />;
    case "conceito":
      return <circle cx={x} cy={y} r={r} fill="var(--paper)" stroke="var(--ink)" strokeWidth={sw} />;
    case "livro":
      return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={sw} />;
  }
}

function edgeStyle(type: string): { strokeOpacity: number; strokeWidth: number; strokeDasharray?: string } {
  switch (type) {
    case "compartilha":
      return { strokeOpacity: 0.75, strokeWidth: 1.2, strokeDasharray: "6 4" };
    case "recomenda":
      return { strokeOpacity: 0.85, strokeWidth: 1.6 };
    case "bibliografia_basica":
    case "bibliografia_complementar":
      return { strokeOpacity: 0.35, strokeWidth: 1, strokeDasharray: "1.5 3" };
    case "pertence":
      return { strokeOpacity: 0.18, strokeWidth: 0.8 };
    default:
      return { strokeOpacity: 0.35, strokeWidth: 0.9 };
  }
}

function Swatch({ children }: { children: ReactNode }) {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
      {children}
    </svg>
  );
}

function Legend() {
  const line = (type: string) => <line x1={1} y1={9} x2={17} y2={9} stroke="var(--ink)" {...edgeStyle(type)} strokeOpacity={0.9} />;
  return (
    <div className="legend">
      <span className="kicker">Nós</span>
      {TYPES.map(({ type, label }) => (
        <span key={type}>
          <Swatch>
            <Shape type={type} x={9} y={9} r={type === "curso" ? 6 : 4.5} />
          </Swatch>
          {label}
        </span>
      ))}
      <span className="kicker" style={{ marginLeft: 8 }}>Ligações</span>
      <span><Swatch>{line("aborda")}</Swatch>ementa</span>
      <span><Swatch>{line("bibliografia_basica")}</Swatch>bibliografia</span>
      <span><Swatch>{line("recomenda")}</Swatch>recomendação</span>
      <span><Swatch>{line("compartilha")}</Swatch>conteúdo em comum</span>
    </div>
  );
}

export function Graph() {
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [types, setTypes] = useState<Set<NodeType>>(new Set(["disciplina", "conceito", "livro", "curso"]));
  const [connectedOnly, setConnectedOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  // Zoom semântico (como no ontology-internal): `scale` afasta ou aproxima as posições;
  // formas e traços mantêm o tamanho na tela e o texto cresce só um pouco.
  const [zoom, setZoom] = useState({ scale: 1, panX: 0, panY: 0 });
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    getGraph().then(setData).catch(() => setData({ nodes: [], edges: [] }));
  }, []);

  // O SVG usa o tamanho real do palco como viewBox: uma unidade é um pixel, então tamanhos de
  // fonte e de forma valem o que dizem, em qualquer largura de tela.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of data?.edges ?? []) {
      d.set(e.src, (d.get(e.src) ?? 0) + 1);
      d.set(e.dst, (d.get(e.dst) ?? 0) + 1);
    }
    return d;
  }, [data]);

  const layout = useMemo(() => {
    if (!data) return null;
    const keep = data.nodes.filter(
      (n) => types.has(n.type) && (!connectedOnly || n.type !== "disciplina" || (degree.get(n.id) ?? 0) > 1),
    );
    const ids = new Set(keep.map((n) => n.id));
    const nodes: SimNode[] = keep.map((n) => ({ id: n.id, node: n, degree: degree.get(n.id) ?? 0 }));
    const links = data.edges
      .filter((e) => ids.has(e.src) && ids.has(e.dst))
      .map((e) => ({ source: e.src, target: e.dst, edge: e }));
    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink(links)
          .id((d) => (d as SimNode).id)
          .distance((l) => ((l as { edge: GraphEdge }).edge.type === "pertence" ? 110 : 60))
          .strength(0.35),
      )
      .force(
        "charge",
        forceManyBody().strength((d) => ((d as SimNode).node.type === "curso" ? -2500 : -60 - Math.min(500, (d as SimNode).degree * 8))),
      )
      .force("collide", forceCollide(14).iterations(2))
      .force("x", forceX(0).strength(0.035))
      .force("y", forceY(0).strength(0.045))
      .stop();
    sim.tick(320);
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    return { nodes, links: links as unknown as { source: SimNode; target: SimNode; edge: GraphEdge }[], bounds };
  }, [data, types, connectedOnly, degree]);

  // Filtros novos voltam ao enquadramento inicial.
  useEffect(() => {
    setZoom({ scale: 1, panX: 0, panY: 0 });
    setSelected(null);
  }, [layout]);

  // Escala base que faz o layout caber no palco; o zoom do usuário multiplica por cima.
  const fit = useMemo(() => {
    if (!layout || !layout.nodes.length) return { k: 1, cx: 0, cy: 0 };
    const { minX, maxX, minY, maxY } = layout.bounds;
    const pad = 70;
    const k = Math.min((size.w - 2 * pad) / Math.max(1, maxX - minX), (size.h - 2 * pad - 30) / Math.max(1, maxY - minY), 1.6);
    return { k, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }, [layout, size]);

  const originY = size.h / 2 + 15;
  const sx = (x: number) => size.w / 2 + (x - fit.cx) * fit.k * zoom.scale + zoom.panX;
  const sy = (y: number) => originY + (y - fit.cy) * fit.k * zoom.scale + zoom.panY;

  const svgPoint = (clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: size.w / 2, y: originY };
  };

  // Roda com { passive: false } para poder impedir a rolagem da página; o ponto sob o cursor fica fixo.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = svgPoint(e.clientX, e.clientY);
      setZoom((z) => {
        const scale = Math.max(0.3, Math.min(10, z.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
        const f = scale / z.scale;
        const cx = size.w / 2;
        return { scale, panX: p.x - cx - (p.x - cx - z.panX) * f, panY: p.y - originY - (p.y - originY - z.panY) * f };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const p = svgPoint(e.clientX, e.clientY);
      const dx = p.x - dragRef.current.x;
      const dy = p.y - dragRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) movedRef.current = true;
      dragRef.current = p;
      setZoom((z) => ({ ...z, panX: z.panX + dx, panY: z.panY + dy }));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  const zoomCenter = (factor: number) =>
    setZoom((z) => {
      const scale = Math.max(0.3, Math.min(10, z.scale * factor));
      const f = scale / z.scale;
      return { scale, panX: z.panX * f, panY: z.panY * f };
    });

  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (q.length < 2 || !layout) return new Set<string>();
    return new Set(
      layout.nodes
        .filter((n) => fold(n.node.label).includes(q) || n.node.data.codes?.some((c) => fold(c).includes(q)))
        .map((n) => n.id),
    );
  }, [query, layout]);

  const neighbors = useMemo(() => {
    const s = new Set<string>();
    if (!selected || !data) return s;
    for (const e of data.edges) {
      if (e.src === selected) s.add(e.dst);
      if (e.dst === selected) s.add(e.src);
    }
    return s;
  }, [selected, data]);

  const dimmed = (id: string) => (selected ? id !== selected && !neighbors.has(id) : matches.size > 0 && !matches.has(id));

  // O texto acompanha o zoom devagar: legível de longe, sem virar manchete de perto.
  const fontPx = Math.max(10, Math.min(16, 11.5 * Math.pow(zoom.scale, 0.35)));

  /**
   * Rótulos por prioridade, sem sobreposição. Cada rótulo ocupa uma caixa na tela e só entra se
   * não colidir com os já colocados. Afastar esconde os menos importantes; aproximar abre espaço
   * e eles reaparecem. O selecionado, seus vizinhos e os achados da busca vêm primeiro.
   */
  const labels = useMemo(() => {
    const out = new Map<string, { x: number; y: number; text: string; anchor: "middle" | "start" | "end" }>();
    if (!layout) return out;
    const prio = (n: SimNode) =>
      (n.id === selected ? 1e6 : 0) +
      (neighbors.has(n.id) ? 1e5 : 0) +
      (matches.has(n.id) ? 1e5 : 0) +
      (n.node.type === "curso" ? 1e4 : 0) +
      (n.node.type === "disciplina" ? 100 : 0) +
      n.degree;
    // Os nós visíveis entram primeiro como obstáculos: um rótulo não cobre o desenho de outro nó.
    type Box = { x0: number; y0: number; x1: number; y1: number };
    const hits = (box: Box, list: Box[]) => list.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
    const placed: Box[] = [];
    const obstacles: Box[] = layout.nodes
      .filter((n) => !dimmed(n.id))
      .map((n) => {
        const x = sx(n.x ?? 0);
        const y = sy(n.y ?? 0);
        const r = nodeSize(n) + 1;
        return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
      });
    for (const n of [...layout.nodes].sort((a, b) => prio(b) - prio(a))) {
      if (dimmed(n.id)) continue;
      const x = sx(n.x ?? 0);
      const y = sy(n.y ?? 0);
      if (x < -60 || x > size.w + 60 || y < -20 || y > size.h + 20) continue;
      const text = truncate(n.node.label, n.id === selected ? 64 : 34);
      const w = text.length * fontPx * 0.5;
      const h = fontPx * 1.15;
      const r = nodeSize(n) + 3;
      const hub = n.node.type === "curso" || n.degree >= 8 || n.id === selected;
      // Abaixo, acima, à direita, à esquerda: a primeira posição livre vence.
      const candidates = [
        { cx: x, top: y + r, anchor: "middle" as const },
        { cx: x, top: y - r - h, anchor: "middle" as const },
        { cx: x + r + w / 2, top: y - h / 2, anchor: "start" as const },
        { cx: x - r - w / 2, top: y - h / 2, anchor: "end" as const },
      ];
      for (const c of candidates) {
        const box = { x0: c.cx - w / 2 - 3, y0: c.top, x1: c.cx + w / 2 + 3, y1: c.top + h };
        // Hubs (cursos, nós muito ligados, o selecionado) só desviam de outros rótulos: cercados de
        // vizinhos, nunca achariam espaço livre, e são justamente os nomes que orientam a leitura.
        if (hits(box, placed) || (!hub && hits(box, obstacles))) continue;
        placed.push(box);
        const tx = c.anchor === "middle" ? c.cx : c.anchor === "start" ? c.cx - w / 2 : c.cx + w / 2;
        out.set(n.id, { x: tx, y: c.top + fontPx * 0.88, text, anchor: c.anchor });
        break;
      }
    }
    return out;
    // sx, sy e dimmed derivam de zoom, fit, size, selected, neighbors e matches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, zoom, fit, size, selected, neighbors, matches, fontPx]);

  const byId = useMemo(() => new Map(data?.nodes.map((n) => [n.id, n]) ?? []), [data]);
  const sel = selected ? byId.get(selected) : null;

  if (!data) return <p className="muted italic">Desenhando o grafo…</p>;
  if (!data.nodes.length)
    return (
      <div className="empty-state">
        <h2>Grafo vazio</h2>
        <p className="muted">
          Rode <code>npm run graph</code> para extrair disciplinas, conceitos e livros das ementas do acervo.
        </p>
      </div>
    );

  const relations = sel
    ? Object.entries(
        data.edges
          .filter((e) => e.src === sel.id || e.dst === sel.id)
          .reduce<Record<string, { id: string; detail?: string; weight: number }[]>>((acc, e) => {
            const out = e.src === sel.id;
            (acc[`${e.type}:${out ? 0 : 1}`] ??= []).push({ id: out ? e.dst : e.src, detail: e.evidence[0]?.detail, weight: e.weight });
            return acc;
          }, {}),
      )
    : [];

  const count = (t: NodeType) => data.nodes.filter((n) => n.type === t).length;
  const zoomed = zoom.scale !== 1 || zoom.panX !== 0 || zoom.panY !== 0;

  return (
    <div className="graph-wrap">
      <div>
        <div className="graph-stage" ref={stageRef}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${size.w} ${size.h}`}
            style={{ cursor: dragging ? "grabbing" : "grab" }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              dragRef.current = svgPoint(e.clientX, e.clientY);
              movedRef.current = false;
              setDragging(true);
            }}
            onClick={() => !movedRef.current && setSelected(null)}
            onDoubleClick={() => setZoom({ scale: 1, panX: 0, panY: 0 })}
          >
            {layout?.links.map((l, i) => {
              const lit = l.source.id === selected || l.target.id === selected;
              const style = edgeStyle(l.edge.type);
              const opacity = selected
                ? lit
                  ? Math.max(0.6, style.strokeOpacity)
                  : 0.04
                : matches.size
                  ? style.strokeOpacity * 0.4
                  : style.strokeOpacity;
              return (
                <line
                  key={i}
                  x1={sx(l.source.x ?? 0)}
                  y1={sy(l.source.y ?? 0)}
                  x2={sx(l.target.x ?? 0)}
                  y2={sy(l.target.y ?? 0)}
                  stroke="var(--ink)"
                  {...style}
                  strokeOpacity={opacity}
                />
              );
            })}
            {layout?.nodes.map((n) => (
              <g
                key={n.id}
                opacity={dimmed(n.id) ? 0.1 : 1}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!movedRef.current) setSelected((s) => (s === n.id ? null : n.id));
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <title>{`${n.node.label} (${n.node.type})`}</title>
                <Shape type={n.node.type} x={sx(n.x ?? 0)} y={sy(n.y ?? 0)} r={nodeSize(n)} strong={n.id === selected} />
              </g>
            ))}
            {[...labels.entries()].map(([id, l]) => (
              <text
                key={id}
                x={l.x}
                y={l.y}
                textAnchor={l.anchor}
                fontSize={fontPx}
                fontWeight={id === selected ? 600 : 400}
                fill="var(--ink)"
                stroke="var(--paper)"
                strokeWidth={3.5}
                style={{ paintOrder: "stroke", pointerEvents: "none" }}
              >
                {l.text}
              </text>
            ))}
          </svg>

          <div className="graph-filters">
            <input
              className="field"
              placeholder="Buscar disciplina, código ou conceito"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {TYPES.map(({ type, label }) => (
              <label key={type} className="check">
                <input
                  type="checkbox"
                  checked={types.has(type)}
                  onChange={() =>
                    setTypes((s) => {
                      const next = new Set(s);
                      if (next.has(type)) next.delete(type);
                      else next.add(type);
                      return next;
                    })
                  }
                />
                {label}
              </label>
            ))}
            <label className="check" title="Esconde disciplinas com uma única ligação">
              <input type="checkbox" checked={connectedOnly} onChange={() => setConnectedOnly((v) => !v)} />
              só disciplinas conectadas
            </label>
          </div>

          <div className="zoom-ctrl">
            <button onClick={() => zoomCenter(1 / 1.25)} title="Afastar (rolar para baixo)">−</button>
            <span>{Math.round(zoom.scale * 100)}%</span>
            <button onClick={() => zoomCenter(1.25)} title="Aproximar (rolar para cima)">+</button>
            {zoomed && (
              <button onClick={() => setZoom({ scale: 1, panX: 0, panY: 0 })} title="Restaurar (duplo clique)">⌂</button>
            )}
          </div>
        </div>
        <Legend />
      </div>

      <aside className="node-panel">
        {!sel ? (
          <>
            <h3 className="section-title">
              <span>Grafo de contexto</span>
            </h3>
            <p className="small" style={{ marginTop: 0 }}>
              Extraído por regras, sem modelo de linguagem, das ementas no formato do Catálogo de Disciplinas, das tabelas de
              currículo e das tabelas de disciplinas dos PPCs.
            </p>
            <p className="small muted">
              {count("disciplina")} disciplinas · {count("conceito")} conceitos · {count("livro")} livros · {count("curso")} cursos ·{" "}
              {data.edges.length} ligações
            </p>
            <p className="small italic muted">
              Role para aproximar: as distâncias crescem e mais rótulos cabem. Clique num nó para ver de onde ele vem e o que ele liga.
            </p>
          </>
        ) : (
          <>
            <p className="kicker" style={{ margin: 0 }}>{sel.type}</p>
            <h2>{sel.label}</h2>
            <div className="small muted">
              {sel.data.codes?.join(", ")}
              {sel.data.tpei ? ` · TPEI ${sel.data.tpei}` : ""}
              {sel.data.year ? ` · ${sel.data.year}` : ""}
            </div>
            {sel.data.ref && <p className="ementa">{sel.data.ref}</p>}
            {sel.data.ementa && <p className="ementa">{sel.data.ementa}</p>}
            {relations.map(([key, items]) => {
              const [type, dir] = key.split(":");
              return (
                <div className="rel" key={key}>
                  <h3 className="section-title">
                    <span>{EDGE_LABEL[type!]?.[Number(dir)] ?? type}</span>
                    <span>{items.length}</span>
                  </h3>
                  <ul>
                    {items
                      .sort((a, b) => b.weight - a.weight)
                      .map((it) => (
                        <li key={it.id}>
                          <button onClick={() => setSelected(it.id)}>{byId.get(it.id)?.label ?? it.id}</button>
                          {it.detail && <span className="detail"> · {it.detail}</span>}
                        </li>
                      ))}
                  </ul>
                </div>
              );
            })}
            <p className="small italic muted" style={{ marginTop: 18 }}>
              Fonte: {sel.data.docs.map((d) => d.split("/").pop()).join(", ")}
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
