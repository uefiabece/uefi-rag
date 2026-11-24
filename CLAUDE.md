# CLAUDE.md

Guia para agentes trabalhando neste repositório. A visão de produto está no [README.md](README.md); a referência técnica está em [docs/](docs/README.md).

## O que é

RAG sobre os repositórios UÉFIabecê (material de cursos da UFABC). Monorepo npm com dois workspaces:

- `server/` — Node 22 + TypeScript (ESM, executado com `tsx`, sem build). Ingestão, busca híbrida, geração, grafo, conselho de professores, API Fastify, servidor MCP, avaliação.
- `web/` — React 19 + Vite. Abas Perguntar, Conselho, Grafo, Acervo, Avaliação. Funciona contra a API ou, sem servidor, contra os JSON estáticos de `web/public/demo/`.

Todo o código, comentários, prompts, mensagens de erro e documentação são **em português**. Mantenha assim.

## Comandos

Rode da raiz (os scripts delegam para os workspaces):

```bash
npm test                 # vitest em server/test (não precisa de banco, Ollama nem chave)
npm run typecheck        # tsc --noEmit nos dois workspaces
npm run serve            # API em 127.0.0.1:8787
npm run dev              # Vite em :5173, com proxy de /api para a API
npm run ingest [-- --public|--repo X|--force|--reset]
npm run graph            # reconstrói o grafo (precisa rodar depois de ingest)
npm run search -- "consulta" [--mode vector|lexical|hybrid] [--k 8]
npm run ask -- "pergunta"
npm run council -- "pergunta" --prof a,b,c
npm run eval [-- --no-answers] [-- --set privado]
npm run export           # gera web/public/demo/*.json (só público)
```

Antes de terminar uma mudança: `npm test` e `npm run typecheck`.

## Restrições que não são óbvias

- **PGlite aceita um processo por vez** (`data/pglite`). Com a API rodando, `ingest`, `graph`, `eval`, `search`, `ask`, `council` e `export` no terminal falham. Pare a API antes, ou use Postgres via `docker compose` + `DATABASE_URL`. Por isso o servidor MCP (`mcp.ts`) é um cliente HTTP da API, nunca abre o banco.
- **Público × privado é uma fronteira de segurança.** Repositórios `privado` em `corpus.config.json` contêm material com direitos autorais. Pastas que entram por `discover` são sempre `privado`; só uma entrada explícita em `repos` torna algo público — não mude esse padrão. Nada privado pode chegar a `web/public/demo/`, a `eval/resultados/` (fora de `privado/`) ou a qualquer arquivo versionado. Todo SQL novo que lista documentos/trechos/grafo precisa respeitar `publicOnly` e `settings.publicOnly` (veja `filterSql` em `retrieve.ts` e `loadGraph` em `graph.ts`).
- **Espaço de embedding fixo.** `meta.embedding = "<modelo>:<dim>"` trava o índice. Trocar `EMBED_MODEL`/`EMBED_PROVIDER` exige `npm run ingest -- --reset`. O hash de cada trecho inclui o modelo e o texto contextualizado (`contextualize` em `embed.ts`); mudar esse formato invalida o reaproveitamento de embeddings e força reembedar tudo.
- **Schema sem migrações versionadas.** `db.ts` roda `CREATE ... IF NOT EXISTS` a cada abertura. Mudança de coluna em tabela existente não é aplicada sozinha: inclua o `ALTER` idempotente no `SCHEMA` ou documente que é preciso `--reset`.
- **Citações `[n]` são contrato.** O servidor valida com `parseCitations` (aceita `[1][3]`, `[1, 3]`, `[2–4]`); a interface marca em vermelho números inválidos. No conselho, `[geral]` marca conhecimento fora do acervo e é contado por `countGeneral`. Ao mexer em prompts (`SYSTEM_PROMPT`, `professorPrompt`, `SYNTHESIS_PROMPT`) preserve esses formatos e rode `npm run eval`.
- **Mudanças na busca se medem.** Peso léxico, `RRF_K`, `CANDIDATES`, `perDoc`, chunking: rode `npm run eval -- --no-answers` antes e depois e registre o efeito em `docs/avaliacao.md`. Não ajuste parâmetros olhando só o conjunto que os mede.
- **Spans não levam conteúdo do acervo.** O destino do OpenTelemetry (Langfuse, Jaeger) é externo: nunca ponha texto de trecho num atributo, troque `docId` privado por `"privado"` e passe pergunta/resposta só por `contentAttributes` (opt-in com `OTEL_CAPTURE_CONTENT=1`).
- **`conselho.config.json` só pode citar repositórios declarados em `repos` de `corpus.config.json`** — há teste para isso, e ele não enxerga os descobertos por `discover` (o teste não lê `uefiRoot`). Um `uefi-uefimcp-*` privado entra no acervo sem editar nada; para ligá-lo a um professor, declare-o em `repos` e cite-o no conselho, sem código.
- **Contrato SSE.** Eventos de `/api/ask` (`sources`, `delta`, `done`, `error`) e de `/api/council` (`professores`, `sources`, `delta`, `perspectiva`, `done`, `error`) são consumidos por `web/src/api.ts`. Mudou um lado, mude o outro. Tipos do servidor e do cliente são duplicados à mão (não há pacote compartilhado).
- **Grafo é por regras, sem LLM.** Os parsers em `graph.ts` são testados contra exemplos reais em `server/test/core.test.ts`; ao ajustar um parser, acrescente o caso que motivou a mudança.

## Convenções de código

- ESM com imports terminando em `.js` (mesmo para arquivos `.ts`).
- Validação de entrada HTTP com `zod`. Erros com mensagem acionável em português ("Rode X", "Defina Y no .env").
- Comentários explicam o *porquê* (decisão, caso de borda real), não o *quê*. Siga a densidade existente.
- Configuração vem de `server/src/config.ts` (`settings`, `loadCorpusConfig`); não leia `process.env` espalhado, exceto onde já é feito (chaves de API, `LEXICAL_WEIGHT`, `RAG_URL`).
- Provedores (embedding e geração) ficam atrás das interfaces `Embedder` e `Generator`; o resto do código não sabe qual está em uso.
- `server/src/_lat.ts` e `_sweep.ts` são scripts descartáveis de medição (prefixo `_`), não fazem parte da aplicação.
- Testes não tocam rede nem banco: use funções puras ou injete um `Generator` falso (veja `council.test.ts`).

## Onde está cada coisa

| Precisa mexer em… | Arquivo |
|---|---|
| Quais arquivos entram, seção, disciplina | `server/src/sources.ts`, `corpus.config.json` |
| Extração/limpeza de PDF | `extract.ts`, `clean.ts` |
| Tamanho e corte dos trechos | `chunk.ts` (`DEFAULT_CHUNKING`) |
| Ranking | `retrieve.ts` |
| Prompt e validação de citações | `answer.ts` |
| Professores, lentes, síntese | `council.ts`, `conselho.config.json` |
| Provedores de LLM | `generate.ts`, `embed.ts` |
| Rotas HTTP | `api.ts` |
| Ferramentas MCP | `mcp.ts` |
| Spans por etapa (OpenTelemetry) | `trace.ts`; spans em `retrieve.ts` e `answer.ts` |
| Cliente web e modo demo | `web/src/api.ts` |
