"""
Cliente do ufabc-rag para os servidores MCP UÉFIabecê (Python, sem dependências).

Os servidores de disciplina hoje buscam com uma regex sobre content/ (ContentLoader.search).
Com este cliente, a mesma ferramenta passa a usar a busca híbrida do acervo inteiro e cai de
volta na regex se a API não estiver rodando. Veja integrations/python/README.md.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

RAG_URL = os.environ.get("RAG_URL", "http://127.0.0.1:8787")


class RagUnavailable(RuntimeError):
    """A API do acervo não respondeu; quem chama decide se cai na busca local."""


def search(
    query: str,
    k: int = 6,
    repo: str | None = None,
    section: str | None = None,
    timeout: float = 15.0,
) -> list[dict]:
    """
    Busca trechos no acervo. Cada resultado traz docId, subject, title, section, heading,
    pageStart, pageEnd, text e score.

    Args:
        query: pergunta ou termos em português.
        k: quantos trechos devolver (1 a 30).
        repo: restringe a um repositório, ex.: "uefi-uefimcp-bm".
        section: restringe a um tipo: syllabus, exams, exercises, notes, bibliography, flashcards.
    """
    params = {"q": query, "k": str(k)}
    if repo:
        params["repo"] = repo
    if section:
        params["section"] = section
    url = f"{RAG_URL}/api/search?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            return json.load(res)["hits"]
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
        raise RagUnavailable(f"ufabc-rag não respondeu em {RAG_URL}: {err}") from err


def format_hits(hits: list[dict]) -> str:
    """Texto pronto para devolver numa ferramenta MCP, com a origem de cada trecho."""
    if not hits:
        return "Nada encontrado no acervo."
    blocks = []
    for i, h in enumerate(hits, 1):
        pages = ""
        if h.get("pageStart"):
            pages = f", p. {h['pageStart']}"
            if h.get("pageEnd") and h["pageEnd"] != h["pageStart"]:
                pages += f"–{h['pageEnd']}"
        heading = f" · {h['heading']}" if h.get("heading") else ""
        blocks.append(f"[{i}] {h['subject']} · {h['title']}{pages}{heading}\n({h['docId']})\n{h['text']}")
    return "\n\n---\n\n".join(blocks)


if __name__ == "__main__":
    import sys

    print(format_hits(search(" ".join(sys.argv[1:]) or "prazo de integralização do BC&T", k=3)))
