# Interfaces

## API HTTP

Servida por `server/src/api.ts` (Fastify) em `http://127.0.0.1:$PORT` (padrão 8787). Entradas inválidas respondem `400` com `{ "error": <zod flatten> }`. `PUBLIC_ONLY=1` restringe todas as rotas ao acervo público, independentemente dos parâmetros.

### `GET /api/health`

```json
{
  "ok": true,
  "database": "pglite",
  "documents": 0,
  "chunks": 0,
  "graphNodes": 0,
  "embedding": "bge-m3:1024",
  "generator": "anthropic:claude-opus-5",
  "publicOnly": false
}
```

### `GET /api/search`

Busca sem geração. É a rota usada pelo servidor MCP e pela integração Python.

| Parâmetro | Tipo | Padrão | |
|---|---|---|---|
| `q` | string (≥ 2) | — | consulta |
| `k` | 1–30 | 8 | trechos devolvidos |
| `repo` | lista separada por vírgula | — | filtra repositórios |
| `section` | lista separada por vírgula | — | `syllabus`, `exams`, `exercises`, `notes`, `bibliography`, `flashcards`, `ecossistema`, `outros` |
| `mode` | `hybrid` \| `vector` \| `lexical` | `hybrid` | |
| `public` | `0` \| `1` | — | só públicos |

Resposta: `{ query, tookMs, hits: Hit[] }`, com

```ts
interface Hit {
  chunkId: number; docId: string; repo: string; path: string;
  title: string; subject: string; section: string; visibility: "publico" | "privado";
  heading: string | null; pageStart: number | null; pageEnd: number | null; text: string;
  score: number;               // RRF
  vectorRank: number | null;   // posição na lista vetorial (1-based)
  lexicalRank: number | null;  // posição na lista léxica
  similarity: number | null;   // cosseno, se veio da vetorial
}
```

### `GET /api/documents?public=1`

`{ documents: [...] }` com as colunas de `documents` mais `chunks` e `tokens` agregados.

### `GET /api/documents/:id/chunks`

`{ chunks: [{ ord, heading, page_start, page_end, text, tokens }] }`. O `:id` é o `docId` codificado para URL.

### `GET /api/graph?public=1`

`{ nodes: GraphNode[], edges: GraphEdge[] }`. Com filtro público, só nós públicos e arestas com evidência pública.

### `GET /api/eval/latest`

Último relatório de avaliação pública (`eval/resultados/latest.json`), ou `404`.

### `POST /api/ask` — SSE

```json
{
  "question": "o estágio é obrigatório na biotecnologia?",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "repos": ["uefi-uefimcp-biotec"],
  "sections": ["bibliography"],
  "publicOnly": false
}
```

`question` 2–2000 caracteres; `history` até 20 mensagens (as 6 últimas vão ao modelo). Resposta `text/event-stream`:

| Evento | Dados | Quando |
|---|---|---|
| `sources` | `Source[]` | uma vez, antes do primeiro token |
| `delta` | `{ text }` | a cada pedaço gerado |
| `done` | `{ citations: { valid, invalid }, model, provider, stopReason, usage, latencyMs, retrievalMs, costUsd }` | fim normal; `costUsd` é `null` quando o modelo não tem preço |
| `error` | `{ message }` | falha depois de iniciado o stream |

```ts
interface Source {
  n: number; kind: "trecho" | "grafo";
  docId: string | null; repo: string | null;
  title: string; subject: string; section: string; heading: string | null;
  pages: string | null;        // "p. 12" ou "p. 12–14"
  visibility: "publico" | "privado"; text: string; score: number | null;
}
```

Fechar a conexão cancela a geração.

### `GET /api/council?public=1`

`{ padrao, grupos, professores }`, onde cada professor traz os campos de `conselho.config.json` mais `documentos` (quantos documentos indexados seus repositórios têm).

### `POST /api/council` — SSE

```json
{ "question": "o que é memória?", "professors": ["neurociencia", "computacao", "historia"], "publicOnly": false }
```

`professors`: 2 a 5 ids (omitido = `padrao`). Id desconhecido ou quantidade inválida → `400` antes do stream.

| Evento | Dados |
|---|---|
| `professores` | `{ professores: [{ id, area, titulo }] }` — primeiro evento |
| `sources` | `{ professor, sources: Source[] }` — um por professor |
| `delta` | `{ professor, text }` — intercalados entre professores; `professor = "sintese"` para a síntese |
| `perspectiva` | `{ professor, citations, general, grounded, model, latencyMs, outputTokens, costUsd, error? }` — fim de cada professor e da síntese |
| `done` | `{ latencyMs, inputTokens, outputTokens, costUsd }` — `costUsd` soma as chamadas que deram certo; `null` se alguma não tem preço |
| `error` | `{ message }` |

### `GET /api/custos?limit=20`

Custo agregado das consultas registradas (tabela `geracoes`): `{ moeda, desde, porProvedor[], porTipo[], ultimas[] }`. `porProvedor` agrupa por provedor e modelo, com consultas, chamadas, tokens, `custoUsd` e `semPreco` (chamadas sem preço; com alguma, `custoUsd` do grupo é `null`). `porTipo` dá média e total por `resposta`/`conselho`. Só metadados: nenhuma pergunta, resposta ou trecho é gravado.

### `GET /api/traces?limit=50`

Traces gravados localmente, mais recentes primeiro (até 500): `{ traces: [{ traceId, name, startMs, durationMs, status, spans, errors, costUsd, inputTokens, outputTokens, invalidCitations, models, professors }] }`. `costUsd` soma o `gen_ai.usage.cost` das gerações; é `null` se alguma geração bem-sucedida não tem preço.

### `GET /api/traces/etapas?ultimos=200`

Tempo por etapa nos últimos traces: `{ traces, stages: [{ name, count, p50Ms, p95Ms, errors }] }`.

### `GET /api/traces/:id`

Os spans de um trace (`id` com 32 caracteres hexadecimais): `{ traceId, spans: [{ spanId, parentId, name, startMs, durationMs, status, statusMessage, attributes, events: [{ name, offsetMs }] }] }`. 404 se o trace já saiu da retenção.

## Servidor MCP

`npm run mcp` (`server/src/mcp.ts`, stdio). Cliente fino da API: a API precisa estar rodando em `RAG_URL`.

| Ferramenta | Entrada | Faz |
|---|---|---|
| `buscar_acervo` | `consulta`, `k` (1–20, padrão 6), `repositorio?`, `secao?` | `/api/search`, devolve trechos formatados com disciplina, documento, página e `docId` |
| `contexto_disciplina` | `nome` (nome, código ou conceito) | vizinhança do nó no grafo: cursos, recomendações, conceitos, bibliografia, disciplinas relacionadas |
| `listar_documentos` | `repositorio?` | documentos indexados com disciplina, seção, nº de trechos e flags de extração |
| `conselho_de_professores` | `pergunta`, `professores?` (2–5 ids; omitido = padrão) | entrega a lente e os trechos de cada área para o LLM do cliente fazer o papel de conselho (não chama o gerador do servidor) |

Registro no Claude Desktop/Code: veja [integrations/python/README.md](../integrations/python/README.md#1-servidor-mcp-próprio-do-acervo).

## Linha de comando

`server/src/cli.ts`, chamado pelos scripts npm da raiz. Argumentos depois de `--`.

| Comando | Opções |
|---|---|
| `ingest` | `--reset` (apaga o índice), `--force` (ignora SHA-256), `--repo <nome>`, `--public` |
| `graph` | — |
| `search <consulta>` | `--k`, `--mode`, `--repo a,b`, `--section a,b`, `--public` |
| `ask <pergunta>` | `--repo`, `--section`, `--public` |
| `council <pergunta>` | `--prof a,b,c`, `--public` |
| `custos` | `--limit N` (últimas consultas, padrão 10) |
| `eval` | `--set publico\|privado\|todos`, `--limit N`, `--no-answers`, `--label X` |
| `export` | — |

Todos abrem o banco diretamente: com PGlite, a API precisa estar parada.
