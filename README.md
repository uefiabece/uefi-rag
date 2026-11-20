# Acervo UFABC

**RAG sobre os repositórios UÉFIabecê.** Ementas, PPCs, provas antigas, listas e notas de aula de cursos da UFABC, em PDF bagunçado e Markdown, viram um acervo consultável: busca híbrida com pgvector, respostas em streaming com cada afirmação citando o trecho de origem, um conselho de professores de áreas diferentes que explica a mesma pergunta por várias perspectivas, um grafo que liga disciplinas, conceitos e livros, e uma avaliação automatizada que diz quanto disso funciona.

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

## Conselho de professores

A aba **Conselho** convoca de dois a cinco professores, um para cada curso da UFABC (27 ao todo: os interdisciplinares de ingresso, as exatas e naturais, as nove engenharias e as humanas e sociais aplicadas), para explicar a mesma pergunta. Quando um curso tem bacharelado e licenciatura, o mesmo professor representa os dois: Física, Matemática, Química e Ciências Biológicas incluem a licenciatura pela LCNE, e Ciências e Humanidades representa o BC&H e a LCH. A ideia é que "o que é memória?" receba uma resposta da Neurociência (mecanismos sinápticos), outra da Ciência da Computação (representação e armazenamento) e outra da História (como o conceito mudou ao longo do tempo), e que o aluno veja as três lado a lado.

- **Cada professor busca só no acervo da própria área.** O mapeamento curso → repositórios fica em `conselho.config.json`, junto com a "lente" que orienta cada um e os cursos que ele representa. A Neurociência busca nos repositórios de neuro; a Matemática, nos de Bases Matemáticas e Funções de Várias Variáveis; o BC&T, nos de todas as suas disciplinas; as engenharias, em Introdução às Engenharias. Um teste confere que nenhum professor aponta para um repositório que não existe no `corpus.config.json`.
- **Curso sem acervo participa, mas declara isso.** A maioria dos cursos ainda não tem repositório UÉFIabecê; a cobertura cresce conforme os repositórios forem criados, sem mudar código, só o `conselho.config.json`. Em vez de deixar esses professores citarem trechos de outra área como se fossem seus, eles não recebem fontes, e o servidor marca a perspectiva inteira como conhecimento geral, mesmo que o modelo não marque cada frase. Professores com acervo usam a mesma marca para o que não está nos trechos. A interface mostra, por coluna, quantas afirmações vieram do acervo e quantas são gerais.
- **As perspectivas são geradas em paralelo** e chegam intercaladas no mesmo stream SSE, cada evento identificado pelo professor.
- **Uma síntese fecha o conselho**, com convergências, divergências e como as perspectivas se completam. O prompt proíbe fatos novos: a síntese só pode remeter ao que algum professor disse, pelo nome da área.

Uma pergunta ao conselho custa N + 1 chamadas ao modelo (N professores mais a síntese). No terminal: `npm run council -- "o que é memória?" --prof neurociencia,computacao,historia`. Pelo MCP, a ferramenta `conselho_de_professores` entrega a lente e os trechos de cada área para o LLM do cliente fazer o papel de conselho.

## Público e privado

Parte dos repositórios UÉFIabecê é privada, e parte do material é bibliografia com direitos autorais. O `corpus.config.json` marca cada repositório como `publico` ou `privado`; pastas `uefi-uefimcp-*` não declaradas entram sozinhas, sempre como privadas:

- localmente, o acervo inteiro é indexado e consultável (a interface marca as fontes privadas);
- `PUBLIC_ONLY=1` ou a opção "só públicos" restringe as respostas;
- `npm run export` gera a demo estática **só** com documentos, trechos, nós do grafo e respostas gravadas de repositórios públicos;
- os resultados da avaliação do conjunto privado ficam em `eval/resultados/privado/`, fora do git.

## Rodar

Pré-requisitos: Node 22 e [Ollama](https://ollama.com) com `ollama pull bge-m3`.

```bash
npm install
cp .env.example .env              # ajuste UEFI_ROOT e ANTHROPIC_API_KEY
npm run ingest                    # repositórios de corpus.config.json + uefi-uefimcp-* descobertos (retomável)
npm run graph
npm run serve                     # API em http://127.0.0.1:8787
npm run dev                       # interface em http://localhost:5173
```

A primeira ingestão pode levar horas em CPU: o tempo é proporcional à quantidade de texto (cada trecho passa pelo modelo de embedding), não ao número de repositórios nem à visibilidade deles. `--repo <nome>` e `--public` só restringem quais repositórios entram; interromper e rodar de novo continua de onde parou, e as execuções seguintes só processam o que mudou.

Sem chave da Anthropic, `LLM_PROVIDER=ollama` gera as respostas com um modelo local. Para usar um Postgres de verdade, `docker compose up -d` e `DATABASE_URL=postgres://rag:rag@localhost:5432/rag`. O schema é o mesmo.

Outros comandos:

```bash
npm run search -- "ementa de bases matemáticas"   # busca no terminal, com a posição em cada lista
npm run ask -- "o estágio é obrigatório na biotecnologia?"
npm run eval                                      # ver docs/avaliacao.md
npm run export && npm run build                   # demo estática em web/dist
npm test                                          # testes de limpeza, chunking, grafo, citações, RRF e conselho
```

O PGlite guarda o banco em `data/pglite` e aceita um processo por vez: pare a API antes de rodar `ingest`, `graph` ou `eval` no terminal.

## Integração com os servidores MCP

O acervo atende os servidores MCP de duas formas, ambas pela API HTTP:

- `npm run mcp` sobe um servidor MCP próprio com `buscar_acervo`, `contexto_disciplina`, `conselho_de_professores` e `listar_documentos`, para registrar no Claude Desktop ou no Claude Code;
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
  council.ts    conselho de professores: busca por área, perspectivas em paralelo, síntese
  generate.ts   Claude, OpenAI e Ollama com streaming
  api.ts        Fastify: /api/search, /api/ask (SSE), /api/council (SSE), /api/documents, /api/graph, /api/eval/latest
  mcp.ts        servidor MCP (stdio)
  eval.ts       avaliação de recuperação e respostas
  export.ts     JSON da demo estática
web/src/        React: Perguntar, Conselho, Grafo, Acervo, Avaliação
eval/           perguntas.jsonl e resultados
```
