# Desenvolvimento

## Ambiente

- Node 22 (usa `process.loadEnvFile` e `fetch` nativos).
- Ollama com `bge-m3` para embeddings (ou `EMBED_PROVIDER=openai`).
- Opcional: Docker para Postgres (`docker compose up -d`, imagem `pgvector/pgvector:pg17`, porta só em `127.0.0.1`).

O servidor roda direto do TypeScript com `tsx`; não há etapa de build no `server/`. O `web/` usa Vite.

## Testes e verificação

```bash
npm test             # vitest, server/test/*.test.ts
npm run typecheck    # server e web
```

Os testes são puros: não abrem banco, não chamam Ollama nem APIs de LLM. Cobrem:

- `core.test.ts` — limpeza de PDF, chunking, parsers do grafo (ementa, conceitos, ABNT, currículo, tabelas de PPC), busca de nós por nome/código, validação de citações, consulta de seguimento, correção da avaliação, RRF, globs.
- `council.test.ts` — integridade de `conselho.config.json` contra `corpus.config.json`, seleção de professores, prompts, contagem de `[geral]`, execução paralela e tolerância a falhas com um `Generator` falso.

Mudanças que afetam qualidade de recuperação ou de resposta também passam pela avaliação (`npm run eval`), descrita em [avaliacao.md](avaliacao.md). Os testes garantem que o código faz o que diz; a avaliação diz se isso ajuda.

## Tarefas comuns

### Adicionar um repositório ao acervo

1. Acrescente `{ "name": "...", "visibility": "publico" | "privado" }` em `corpus.config.json`.
2. Confira que o repositório tem `config/subject.json` e `content/<seção>/`.
3. `npm run ingest -- --repo <nome>` e depois `npm run graph`.
4. Se o repositório pertence à área de algum professor, acrescente-o a `repos` em `conselho.config.json` e rode `npm test`.

### Adicionar ou alterar um professor do conselho

Só `conselho.config.json`. Escolha um `grupo` existente, uma `lente` que diga *o que* a área olha (não *como* responder — as regras de citação estão no prompt), e rode `npm test`.

### Adicionar um provedor de LLM ou de embedding

Implemente `Generator` em `generate.ts` (ou `Embedder` em `embed.ts`) e acrescente o caso em `getGenerator`/`getEmbedder`. O restante do sistema não muda. Para embeddings, lembre que o índice existente terá de ser recriado (`--reset`).

### Mudar o formato do chunking ou do texto embedado

Altera os hashes de trecho, então a próxima ingestão reembeda tudo. Meça com `npm run eval -- --no-answers` antes e depois.

### Mudar o schema

Acrescente o DDL idempotente (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) ao `SCHEMA` em `db.ts`. Não há ferramenta de migração; se a mudança não puder ser idempotente, documente que exige `npm run ingest -- --reset`.

### Publicar a demo estática

```bash
npm run ingest -- --public && npm run graph
npm run eval                 # opcional: grava respostas para a aba Avaliação
npm run export               # web/public/demo/*.json, só público
npm run build                # web/dist
```

Revise o diff de `web/public/demo/` antes de versionar.

## Problemas frequentes

| Sintoma | Causa e solução |
|---|---|
| Comando de terminal trava ou falha ao abrir o banco | A API está rodando com PGlite. Pare a API ou use `DATABASE_URL`. |
| `O índice foi criado com X, mas o modelo atual é Y` | Modelo de embedding mudou. `npm run ingest -- --reset`. |
| `Ollama não respondeu em …` | Ollama fechado ou modelo não baixado: `ollama pull bge-m3`. |
| `Sem credencial da Anthropic` | Defina `ANTHROPIC_API_KEY` ou use `LLM_PROVIDER=ollama`. |
| Servidor MCP: `A API do acervo não respondeu` | Rode `npm run serve`, ou ajuste `RAG_URL`. |
| Repositório "não encontrado" na ingestão | `UEFI_ROOT`/`uefiRoot` aponta para o lugar errado, ou o nome da pasta difere do `name`. |
| Documento com `flags` na aba Acervo | Diagnóstico de extração: `sem-texto` (mais da metade das páginas vazias, provável digitalização), `texto-corrompido` (> 2% de glifos sem mapa Unicode), `truncado` (passou de `maxPdfPages`), `poucas-palavras`. O documento é indexado mesmo assim; a correção é na fonte. |
| Grafo vazio ou desatualizado | `npm run graph` não roda sozinho depois de `ingest`. |
| Interface mostra "Edição estática" localmente | `GET /api/health` falhou: a API não está rodando ou não está na porta do proxy (`web/vite.config.ts`). |
