import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getHealth, type Health } from "./api";
import { Ask } from "./views/Ask";
import { Evaluation } from "./views/Evaluation";
import { Graph } from "./views/Graph";
import { Library } from "./views/Library";
import "./styles.css";

const TABS = [
  { id: "perguntar", label: "Perguntar" },
  { id: "grafo", label: "Grafo" },
  { id: "acervo", label: "Acervo" },
  { id: "avaliacao", label: "Avaliação" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function initialTab(): Tab {
  const hash = location.hash.slice(1);
  return (TABS.find((t) => t.id === hash)?.id ?? "perguntar") as Tab;
}

function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [health, setHealth] = useState<Health | null>(null);
  const [publicOnly, setPublicOnly] = useState(false);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    const onHash = () => setTab(initialTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (t: Tab) => {
    history.replaceState(null, "", `#${t}`);
    setTab(t);
  };

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-inner">
          <p className="kicker">Ementas, projetos pedagógicos e provas da UFABC</p>
          <h1>Acervo UFABC</h1>
          <div className="rule kicker">
            <span>{today}</span>
            <span className="italic">Cada resposta cita a página de onde veio</span>
            <span>
              {health
                ? health.demo
                  ? `Edição estática · ${health.documents} documentos`
                  : `${health.documents} documentos · ${health.chunks.toLocaleString("pt-BR")} trechos`
                : "…"}
            </span>
          </div>
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main>
        {!health ? (
          <p className="muted italic">Abrindo o acervo…</p>
        ) : tab === "perguntar" ? (
          <Ask publicOnly={publicOnly} health={health} onPublicOnly={setPublicOnly} />
        ) : tab === "grafo" ? (
          <Graph />
        ) : tab === "acervo" ? (
          <Library />
        ) : (
          <Evaluation />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
