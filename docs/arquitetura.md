# Arquitetura

## Visão geral

```
┌──────────────── server/ (Node + TS, tsx) ────────────────┐        ┌──── web/ (React + Vite) ────┐
│                                                          │        │                              │
│  sources → extract → clean → chunk → embed → ingest ──┐  │        │  Perguntar  Conselho  Grafo  │
│                                                       ▼  │  HTTP  │  Acervo     Avaliação        │
│                                    Postgres + pgvector   │◄──────►│                              │
│  graph (regras) ─────────────────► (PGlite ou Docker)    │  SSE   │  sem API → web/public/demo/  │
│                                                       ▲  │        └──────────────────────────────┘
│  retrieve ◄── answer / council ◄── api.ts (Fastify) ──┘  │
│                                        ▲                 │
│                                   mcp.ts (stdio, cliente HTTP da API)
│  eval.ts · export.ts · cli.ts                            │
└──────────────────────────────────────────────────────────┘
```

Um único processo abre o banco (a API, ou um comando de terminal). Tudo o que precisa do índice enquanto a API roda — o servidor MCP, a integração Python, a interface — passa pela API HTTP.

## Ingestão

`npm run ingest` → `ingest.ts`.

1. **Descoberta** (`sources.ts`). Os repositórios são os declarados em `repos` mais as pastas de `uefiRoot` que casam `discover` (`resolveRepos`; descobertos são sempre `privado`). Em cada um, percorre só as pastas fixas dos globs de `include` (padrão `content/**`, então `.venv`, `src` etc. nem são lidos) e fica com os arquivos que casam `include`, têm extensão em `extensions` e não casam `exclude`. Cada arquivo vira um `SourceFile`:
   - `id` = `<repo>/<caminho relativo>` (chave primária em todo o sistema);
   - `section` = a pasta logo abaixo de `content/` (`syllabus`, `exams`, `exercises`, `notes`, `bibliography`, `flashcards`), `ecossistema` para repositórios `kind: "ecossistema"`, ou `outros`;
   - `subject`/`course` vêm de `config/subject.json` do repositório (`subject_name`, `course_name`), com o nome do repositório como recuo.
2. **Extração** (`extract.ts`). PDF via `unpdf` (pdf.js): o texto de cada página é remontado a partir da posição e do tamanho dos fragmentos, o que separa parágrafos pelo espaçamento e manda notas de rodapé (fonte menor) para o fim da página. Limite de `maxPdfPages` páginas. `.md` e `.txt` viram uma "página" só.
3. **Limpeza** (`clean.ts`). Normaliza caracteres, remove cabeçalhos e rodapés repetidos (idênticos entre páginas, ou cujo único número acompanha o número da página), junta hifenização, reflui linhas de um mesmo parágrafo preservando listas e títulos. Produz o diagnóstico `Quality` (`flags`, `emptyPages`, `removedBoilerplate`, `garbledRatio`), gravado em `documents.quality`.
4. **Chunking** (`chunk.ts`). Corta por títulos Markdown, títulos numerados de PDF e enunciados de questão; dentro disso, por tamanho (`DEFAULT_CHUNKING`: alvo 1100, máximo 1800, mínimo 250 tokens estimados, sobreposição 200). Cada trecho guarda `heading` e `page_start`/`page_end`.
5. **Embedding** (`embed.ts`). O texto embedado é `"<disciplina> › <documento> › <título>\n\n<trecho>"` (`contextualize`). Lotes de 16.
6. **Gravação**. Uma transação por documento: apaga o documento antigo (cascata nos trechos) e insere de novo.

### Incrementalidade

- Arquivo com o mesmo SHA-256 e a mesma visibilidade do que está no banco é pulado (a menos que `--force`). Mudar a visibilidade de um repositório regrava os documentos dele, reaproveitando os embeddings.
- Dentro de um arquivo alterado, cada trecho tem `text_hash = sha256(modelo + "\n" + texto contextualizado)`. Trechos cujo hash já existia reaproveitam o vetor antigo.
- Documentos que sumiram dos repositórios são removidos — só dentro do escopo da execução (com `--repo` ou `--public`, só os repositórios abrangidos).
- A ingestão é retomável: cada documento é gravado ao terminar, então interromper e rodar de novo continua de onde parou.

### Tempo

O custo é dominado pelo embedding: cada trecho é uma passagem pelo modelo (com Ollama, em CPU se não houver GPU). O tempo cresce com a quantidade de texto extraído — um livro de 400 páginas rende centenas de trechos, um Markdown curto rende um ou dois —, não com o número de arquivos nem com a visibilidade do repositório. `--public` e `--repo` são filtros de escopo: o arquivo passa pelo mesmo pipeline. Se uma execução com `--public` termina antes, é só porque os repositórios públicos têm menos texto naquele momento.

## Grafo de contexto

`npm run graph` → `graph.ts`. Relê os arquivos (não o banco) e aplica parsers determinísticos:

| Fonte | Parser | Produz |
|---|---|---|
| Ementas no formato do Catálogo de Disciplinas (seção `syllabus`) | `parseEmenta` | disciplina (código, TPEI, ementa), conceitos, livros, recomendações |
| Tabelas de currículo em Markdown | `parseCurriculum` | disciplina → curso, com categoria e eixo |
| Tabelas de disciplinas nos PPCs 202x e listas de opção limitada (PDF) | `parseCodeTable` | disciplina → curso |

Tipos de nó: `disciplina`, `conceito`, `livro`, `curso` (id `<tipo>:<chave normalizada>`). Tipos de aresta: `aborda`, `bibliografia_basica`, `bibliografia_complementar`, `recomenda`, `pertence`, `compartilha` (derivada: disciplinas com conceitos ou livros em comum). Cada nó e aresta carrega `evidence` com o documento de origem e sua visibilidade, o que permite filtrar o grafo para o público.

O grafo é reconstruído do zero a cada execução e precisa ser refeito depois de ingestões que mudem ementas ou currículos.

## Resposta (`/api/ask`)

`answer.ts`:

1. `retrievalQuery`: pergunta de seguimento curta (< 80 caracteres) é concatenada à pergunta anterior do usuário para a busca.
2. Em paralelo: `search` (k = 8) e `graphContext` (até 3 nós do grafo citados na pergunta, texto limitado a 3000 caracteres).
3. `toSources`: trechos numerados de 1 a n; o contexto do grafo, se houver, entra como fonte n + 1.
4. Prompt: `SYSTEM_PROMPT` + últimas 6 mensagens do histórico + mensagem com `<fontes>` (cada uma como `<fonte n=… disciplina=… documento=… tipo=… secao=… paginas=…>`) e `<pergunta>`.
5. Streaming pelo `Generator` configurado. As fontes são emitidas antes do primeiro token.
6. `parseCitations` separa citações válidas (1 ≤ n ≤ número de fontes) e inválidas.

## Busca (`retrieve.ts`)

- **Vetorial**: distância cosseno no índice HNSW, 40 candidatos.
- **Léxica**: `tsvector` em português sobre `f_unaccent(heading)` (peso A) e `f_unaccent(text)` (peso B). A consulta é um OR entre os lexemas da pergunta, ordenado primeiro pela **cobertura** (quantos lexemas distintos o trecho contém) e depois por `ts_rank_cd`. 40 candidatos.
- **Fusão**: Reciprocal Rank Fusion com `k = 60`; a lista léxica pesa `LEXICAL_WEIGHT` (padrão 0,5), a vetorial pesa 1.
- **Diversidade**: no máximo `perDoc` trechos por documento (3 na resposta, 2 no conselho).
- Filtros: `repos`, `sections`, `publicOnly` (que também é forçado por `PUBLIC_ONLY=1`).

O porquê de cada escolha está em [avaliacao.md](avaliacao.md).

## Conselho de professores (`/api/council`)

`council.ts`:

1. `selectProfessors`: de 2 a 5 ids de `conselho.config.json` (ou `padrao`), sempre na ordem da configuração.
2. Para cada professor, em paralelo: busca restrita a `repos` do professor (k = 5, `perDoc` = 2); professor sem repositório não recebe fontes. Gera com `professorPrompt` (lente da área, nomes dos colegas, regra de citar `[n]` e marcar `[geral]`).
3. Cada perspectiva termina com um evento `perspectiva` contendo citações, contagem de `[geral]` e `grounded` (se recebeu fontes). Falha de um professor não derruba os outros.
4. Com pelo menos duas perspectivas não vazias, a síntese (`SYNTHESIS_PROMPT`, id `sintese`) é gerada a partir delas, sem acesso às fontes e proibida de trazer fatos novos.

Custo: N + 1 chamadas ao modelo.

## Geração (`generate.ts`)

Interface `Generator.stream(system, messages, onText, signal)`. Implementações:

| Provedor | Modelo padrão | Observações |
|---|---|---|
| `anthropic` | `claude-opus-5` | SDK oficial, `thinking: adaptive`, `max_tokens` 16000, fallback do lado do servidor em caso de recusa |
| `openai` | `gpt-5` | Chat Completions em streaming |
| `ollama` | `qwen2.5:7b` | `/api/chat`, `num_ctx` 16384, temperatura 0,2 |

Embeddings (`embed.ts`): `ollama` (padrão `bge-m3`) ou `openai` (padrão `text-embedding-3-small`).

## Rastreamento (`trace.ts`)

Cada resposta vira um trace OpenTelemetry com um span por etapa:

```
rag.resposta                 k, retrieval_ms
├─ rag.busca                 mode, k, public_only
│  ├─ rag.busca.vetorial     candidates, similarity.top
│  │  └─ rag.embedding       embed.model
│  ├─ rag.busca.lexica       candidates
│  └─ rag.rrf                rrf.k, lexical_weight, fused, hits, hits.both_lists, hits.docs
├─ rag.grafo                 graph.found, graph.chars
├─ rag.geracao               gen_ai.system, gen_ai.request.model, gen_ai.usage.*, evento primeiro_token
└─ rag.citacoes              citations.valid, citations.invalid
```

O conselho é um trace só, com um ramo por professor. Os ramos começam juntos e se sobrepõem na linha do tempo, e a síntese só começa quando o último termina:

```
rag.conselho                 council.professors, perspectives, failed, gen_ai.usage.*
├─ rag.conselho.professor    professor.id, professor.area, professor.grounded   ┐
│  ├─ rag.busca …            (só se o professor tem repositórios)               │ em paralelo
│  ├─ rag.geracao            gen_ai.*, professor.id                             │
│  └─ rag.citacoes           citations.valid, invalid, general ([geral])        │
├─ rag.conselho.professor …                                                     ┘
└─ rag.conselho.sintese      council.perspectives
   └─ rag.geracao
```

Professor que falha marca o próprio ramo como erro e o conselho segue sem ele, como no fluxo sem tracing.

Dois destinos independentes:

- **Banco local** (`traces.ts`, tabela `spans`), ligado por padrão (`TRACES_LOCAL=0` desliga). É o que alimenta a aba **Observabilidade**. A API grava tudo; no CLI, só `ask` e `council`, porque `eval` e ingestão gravariam centenas de traces de medição. Ficam os `MAX_TRACES` (500) mais recentes.
- **Coletor OTLP** (Jaeger, Langfuse), quando `OTEL_EXPORTER_OTLP_ENDPOINT` existe. Recebe tudo, inclusive o `eval`.

Sem `initTracing()` (nos testes) não há SDK registrado e a API do OTel é no-op. O CLI faz `flushTracing()` antes de fechar o banco, senão o lote pendente se perde ou é gravado num banco fechado.

A aba Observabilidade lê `GET /api/traces` (resumo por trace: duração, modelo, tokens, custo somado dos `gen_ai.usage.cost`, citações inválidas, erros), `GET /api/traces/etapas` (p50/p95 e erros por nome de span) e `GET /api/traces/:id` (os spans de um trace, desenhados em cascata pela árvore de `parentId`, com o evento `primeiro_token` marcado). Custo por provedor vem de `/api/custos`. Na edição estática a aba só mostra um aviso: não há traces sem API.

Os atributos `gen_ai.*` seguem as convenções semânticas de GenAI do OpenTelemetry, que o Langfuse reconhece como geração (modelo, tokens). Destinos testados pelo formato OTLP/HTTP:

| Destino | Configuração |
|---|---|
| Jaeger local | `docker compose --profile traces up -d jaeger`; `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`; interface em `http://127.0.0.1:16686` |
| Langfuse | `OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel` e `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64 de pk:sk>` |

Privacidade: o destino é um serviço à parte. O texto dos trechos nunca entra nos spans, e `hits.docs` troca o `docId` de documento privado por `"privado"`, porque o nome do arquivo já identifica material com direitos autorais. Pergunta e resposta só entram com `OTEL_CAPTURE_CONTENT=1`, já que a resposta pode citar trechos privados.

## Custo (`cost.ts`)

Cada chamada ao gerador tem custo calculado a partir dos tokens que o provedor devolve e de `precos.config.json`, com o modelo que **respondeu** (o fallback da Anthropic pode trocar de modelo). O custo aparece:

- no evento `done` de `/api/ask` e em cada `perspectiva` e no `done` do conselho (`costUsd`), e na interface ao lado dos tokens;
- nos spans: `gen_ai.usage.cost` em cada `rag.geracao` e o total em `rag.resposta`/`rag.conselho`, campo que o Langfuse lê como custo;
- no relatório de avaliação (`totalCostUsd`, `costPerAnswerUsd`) e no cartão "custo por resposta" da aba Avaliação;
- na tabela `geracoes`, uma linha por chamada, agrupada por `consulta`. A API e os comandos `ask`/`council` gravam; o `eval` não grava, para não misturar medição com uso. `GET /api/custos` e `npm run custos` agregam por provedor/modelo e por tipo.

Desconhecido não vira zero: modelo sem preço tem custo `null`, e qualquer soma com uma parcela `null` também é `null`. O conselho soma só as chamadas que deram certo.

## Modelo de dados

Definido em `server/src/db.ts` e aplicado (idempotente) a cada abertura do banco.

| Tabela | Chave | Conteúdo |
|---|---|---|
| `meta` | `key` | `embedding` = `"<modelo>:<dimensão>"` do índice atual |
| `documents` | `id` (`<repo>/<caminho>`) | repo, path, section, subject, course, visibility, format, title, sha256, pages, chars, quality (jsonb), ingested_at |
| `chunks` | `id` (bigserial) | doc_id → documents (cascata), ord, heading, page_start, page_end, text, text_hash, tokens, embedding `vector(d)`, tsv (gerada) |
| `graph_nodes` | `id` | type, label, data (jsonb, inclui visibilidade e códigos) |
| `graph_edges` | (src, dst, type) | weight, evidence (jsonb: documento, visibilidade, detalhe) |
| `spans` | (trace_id, span_id) | parent_id (null na raiz), name, start_ms, duration_ms, status (`ok`/`erro`), status_message, attributes (jsonb), events (jsonb). Mesmos atributos do OTLP, sem texto de trecho; só os 500 traces mais recentes |
| `geracoes` | `id` (bigserial) | consulta, tipo (`resposta`/`conselho`), etapa (professor ou `sintese`), provedor, modelo, input_tokens, output_tokens, custo_usd (null sem preço), latencia_ms, criado_em. Só metadados, sem texto |

Índices: GIN em `chunks.tsv`, HNSW (`vector_cosine_ops`) em `chunks.embedding` criado quando a dimensão é conhecida, B-tree em `chunks.doc_id`, `geracoes.consulta` e `geracoes.criado_em`; parcial em `spans.start_ms` só para raízes (a lista de traces).

`f_unaccent` é um invólucro `IMMUTABLE` de `unaccent`, necessário para usá-lo na coluna gerada.

A camada `Db` expõe `query`, `exec`, `transaction` e `close` com a mesma forma para PGlite (WASM, em `data/pglite`) e `pg` (Postgres real via `DATABASE_URL`). O schema é o mesmo nos dois.

## Interface web

`web/src/api.ts` tenta `GET api/health`; se falhar, entra em **modo demo** e lê `demo/*.json` (gerados por `npm run export`). No modo demo, Acervo, Grafo e Avaliação funcionam; Perguntar e Conselho não geram respostas, e Observabilidade só avisa que precisa da API. O build usa caminhos relativos (`base: "./"`), então o mesmo `web/dist` serve em localhost e no GitHub Pages.

## Invariantes

1. Nenhum conteúdo de repositório `privado` sai do ambiente local: `export.ts` filtra por `visibility = 'publico'` e só grava o relatório de avaliação se todos os itens forem públicos; resultados privados vão para `eval/resultados/privado/` (no `.gitignore`). Spans exportados não levam texto de trechos nem `docId` privado.
2. Um índice, um espaço vetorial: `ensureEmbeddingSpace` recusa abrir com modelo ou dimensão diferentes dos gravados em `meta`.
3. Um processo por banco PGlite.
4. Toda citação exibida é verificável: o número aponta para uma fonte enviada no mesmo stream, ou é marcado como inválido.
5. Todo professor do conselho aponta só para repositórios existentes em `corpus.config.json`.
