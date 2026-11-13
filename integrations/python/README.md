# Integração com os servidores MCP UÉFIabecê

Há dois jeitos de um servidor MCP usar o acervo. Nos dois, a API precisa estar rodando (`npm run serve`).

## 1. Servidor MCP próprio do acervo

`npm run mcp` sobe um servidor MCP (stdio) com três ferramentas: `buscar_acervo`, `contexto_disciplina` e `listar_documentos`. Ele pode ser registrado no Claude Desktop ou no Claude Code ao lado dos servidores de disciplina:

```json
{
  "mcpServers": {
    "ufabc-rag": {
      "command": "npx",
      "args": ["tsx", "E:/caminho/para/ufabc-rag/server/src/mcp.ts"],
      "env": { "RAG_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

## 2. Dentro de um servidor de disciplina (Python)

Os servidores derivados de `uefi-uefimcp` buscam com `ContentLoader.search`, que faz uma regex sobre o `content/` do próprio repositório. Copie `uefi_rag_client.py` para `src/resources/` e troque o corpo de `search` por uma chamada ao acervo, mantendo a regex como recuo:

```python
# src/resources/loader.py
from . import uefi_rag_client as rag

class ContentLoader:
    ...
    def search(self, query: str, section: str | None = None) -> list[dict]:
        try:
            hits = rag.search(query, k=8, repo=self.repo_name, section=section)
            return [
                {"uri": f"content://{h['path'].removeprefix('content/')}", "path": h["docId"], "snippet": h["text"]}
                for h in hits
            ]
        except rag.RagUnavailable:
            return self._regex_search(query, section)  # a implementação atual, renomeada
```

`repo_name` é o nome da pasta do repositório (por exemplo, `uefi-uefimcp-bm`). Passe `repo=None` para buscar no acervo inteiro: útil no servidor do BC&T, que responde sobre todas as disciplinas do curso.

O formato devolvido é o mesmo que `handle_search_content` já espera, então nenhuma ferramenta precisa mudar.
