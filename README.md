# Acervo UFABC

**RAG sobre os repositórios UÉFIabecê.** Ementas, PPCs, provas antigas, listas e notas de aula de cursos da UFABC, em PDF bagunçado e Markdown, viram um acervo consultável: busca híbrida com pgvector, respostas em streaming com cada afirmação citando o trecho de origem, um grafo que liga disciplinas, conceitos e livros, e uma avaliação automatizada que diz quanto disso funciona.

Node + TypeScript · PostgreSQL com pgvector (PGlite embutido ou Docker) · bge-m3 via Ollama · Claude (Anthropic SDK), OpenAI ou Ollama · React + Vite · MCP

## Como funciona

```
repositórios UÉFIabecê ──► extração ──► limpeza ──► chunking ──► embeddings ──► Postgres + pgvector
 (PDF, .md, .txt)          pdf.js com    cabeçalho,   por título,   bge-m3,          HNSW + tsvector
                           layout        rodapé,      questão e     com o lugar      em português
                                         hifenização  página        do trecho
                                                                                         │
pergunta ──► busca vetorial ┐                                                            │
         └─► busca léxica  ─┴─► RRF ──► fontes numeradas + fatos do grafo ──► Claude ──► resposta em SSE
                                                                                         com [n] validados
```

**Ingestão.** O texto do PDF é remontado a partir das posições dos fragmentos (pdf.js), o que permite separar parágrafos pelo espaçamento e jogar notas de rodapé, em fonte menor, para o fim da página. Cabeçalhos e rodapés repetidos saem antes do chunking. Uma linha conta como repetida se for idêntica entre páginas, ou se o único número que muda acompanhar a página ("PPC 2023 · 25" na página 26); só normalizar os dígitos apagaria "Exercício 3" de slides. Cada documento recebe um diagnóstico (páginas sem texto, sinal de digitalização, texto corrompido, truncado), visível na aba **Acervo**.

**Chunking.** Os trechos respeitam títulos Markdown, títulos numerados de PDF ("4.1 Justificativa…") e enunciados de questão, de modo que uma prova vira um trecho por questão. Cada trecho guarda o título mais próximo e o intervalo de páginas, que viram a citação. O texto embedado leva na frente a disciplina, o documento e a seção: "Bibliografia Básica" sozinho não diz de qual matéria é.

**Incremental.** A reingestão pula arquivos com o mesmo SHA-256 e reaproveita o embedding de cada trecho cujo texto não mudou. Editar uma lista não reembeda o PDF inteiro. Arquivos apagados saem do índice.

**Busca híbrida.** A vetorial (HNSW, cosseno) e a léxica (tsvector em português com `unaccent`, ordenada por cobertura de termos) se fundem por Reciprocal Rank Fusion, com no máximo três trechos por documento. A avaliação mostrou que a primeira versão da busca léxica atrapalhava mais do que ajudava; [docs/avaliacao.md](docs/avaliacao.md) conta como isso foi medido e corrigido.

**Resposta.** O modelo recebe as fontes numeradas e a instrução de citar cada afirmação, separar documento oficial de material de aluno e dizer quando o acervo não responde. As citações são conferidas depois da geração: número sem fonte correspondente aparece marcado em vermelho na interface. O streaming usa Server-Sent Events, com as fontes enviadas antes do primeiro token. Com Claude, a requisição usa thinking adaptativo e o fallback de recusa do lado do servidor.

**Grafo de contexto.** Regras auditáveis, sem LLM, leem as ementas no formato do Catálogo de Disciplinas (código, TPEI, recomendação, ementa, bibliografia básica e complementar), as tabelas de currículo e as tabelas de disciplinas dos PPCs. Saem disciplinas, conceitos (a ementa da UFABC é uma lista de tópicos separados por ponto e dois-pontos), livros (referências ABNT irregulares, normalizadas por sobrenome e título) e cursos, além de ligações entre disciplinas com conceitos ou livros em comum. Quando a pergunta cita uma disciplina ou conceito do grafo, a vizinhança entra como mais uma fonte numerada.

## Público e privado

Parte dos repositórios UÉFIabecê é privada, e parte do material é bibliografia com direitos autorais. O `corpus.config.json` marca cada repositório como `publico` ou `privado`:

- localmente, o acervo inteiro é indexado e consultável (a interface marca as fontes privadas);
- `PUBLIC_ONLY=1` ou a opção "só públicos" restringe as respostas;
- `npm run export` gera a demo estática **só** com documentos, trechos, nós do grafo e respostas gravadas de repositórios públicos;
- os resultados da avaliação do conjunto privado ficam em `eval/resultados/privado/`, fora do git.

## Rodar

Pré-requisitos: Node 22 e [Ollama](https://ollama.com) com `ollama pull bge-m3`.

```bash
npm install
cp .env.example .env              # ajuste UEFI_ROOT e ANTHROPIC_API_KEY
npm run ingest -- --public        # só os repositórios públicos (minutos)
npm run ingest                    # o acervo inteiro (horas em CPU; retomável)
npm run graph
npm run serve                     # API em http://127.0.0.1:8787
npm run dev                       # interface em http://localhost:5173
```

Sem chave da Anthropic, `LLM_PROVIDER=ollama` gera as respostas com um modelo local. Para usar um Postgres de verdade, `docker compose up -d` e `DATABASE_URL=postgres://rag:rag@localhost:5432/rag`. O schema é o mesmo.

Outros comandos:

```bash
npm run search -- "ementa de bases matemáticas"   # busca no terminal, com a posição em cada lista
npm run ask -- "o estágio é obrigatório na biotecnologia?"
npm run eval                                      # ver docs/avaliacao.md
npm run export && npm run build                   # demo estática em web/dist
npm test                                          # testes de limpeza, chunking, grafo, citações e RRF
```

O PGlite guarda o banco em `data/pglite` e aceita um processo por vez: pare a API antes de rodar `ingest`, `graph` ou `eval` no terminal.

## Integração com os servidores MCP

O acervo atende os servidores MCP de duas formas, ambas pela API HTTP:

- `npm run mcp` sobe um servidor MCP próprio com `buscar_acervo`, `contexto_disciplina` e `listar_documentos`, para registrar no Claude Desktop ou no Claude Code;
- `integrations/python/uefi_rag_client.py` substitui a busca por regex dos servidores de disciplina (`ContentLoader.search`) pela busca híbrida, com a regex como recuo se a API estiver fora.

Detalhes em [integrations/python/README.md](integrations/python/README.md).

## Estrutura

```
server/src/
  sources.ts    descoberta dos arquivos nos repositórios, visibilidade, metadados de subject.json
  extract.ts    PDF → páginas com layout; texto puro
  clean.ts      cabeçalho/rodapé, hifenização, refluxo de parágrafos, diagnóstico de qualidade
  chunk.ts      trechos por título, questão e página, com sobreposição
  embed.ts      Ollama ou OpenAI; texto contextualizado
  ingest.ts     pipeline incremental
  retrieve.ts   busca vetorial, léxica e RRF
  graph.ts      parsers de ementa, bibliografia, currículo e tabelas; construção e consulta do grafo
  answer.ts     prompt, fontes numeradas, validação de citações
  generate.ts   Claude, OpenAI e Ollama com streaming
  api.ts        Fastify: /api/search, /api/ask (SSE), /api/documents, /api/graph, /api/eval/latest
  mcp.ts        servidor MCP (stdio)
  eval.ts       avaliação de recuperação e respostas
  export.ts     JSON da demo estática
web/src/        React: Perguntar, Grafo, Acervo, Avaliação
eval/           perguntas.jsonl e resultados
```
