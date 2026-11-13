import { Fragment, type ReactNode } from "react";

/**
 * Markdown mínimo para respostas do modelo: parágrafos, listas, títulos, **negrito** e `código`,
 * com [n] virando botão de citação. Sem dependência e sem HTML cru: nada do texto vira markup.
 */
export function Markdown({
  text,
  sourceCount,
  active,
  onCite,
}: {
  text: string;
  sourceCount: number;
  active?: number | null;
  onCite?: (n: number) => void;
}) {
  const inline = (s: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+(?:\s*[,;–-]\s*\d+)*\])/g;
    let last = 0;
    let i = 0;
    for (const m of s.matchAll(re)) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) out.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith("`")) out.push(<code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
      else {
        const inner = tok.slice(1, -1);
        const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(inner);
        const nums = range
          ? Array.from({ length: Math.min(20, Number(range[2]) - Number(range[1]) + 1) }, (_, k) => Number(range[1]) + k)
          : inner.split(/[,;]/).map((x) => Number(x.trim()));
        for (const n of nums) {
          const ok = n >= 1 && n <= sourceCount;
          out.push(
            <button
              key={`${key}-${i++}`}
              className={`cite${ok ? "" : " bad"}${active === n ? " active" : ""}`}
              title={ok ? `Fonte ${n}` : "Citação sem fonte correspondente"}
              onClick={() => ok && onCite?.(n)}
            >
              {n}
            </button>,
          );
        }
      }
      last = m.index + tok.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };

  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, b) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={b}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ""), `${b}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={b}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""), `${b}-${j}`)}</li>
              ))}
            </ol>
          );
        }
        const h = /^#{1,4}\s+(.+)$/.exec(lines[0]!);
        if (h && lines.length === 1) return <h3 key={b}>{inline(h[1]!, `${b}`)}</h3>;
        return (
          <p key={b}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#{1,4}\s+/, ""), `${b}-${j}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
