# Configuração

Três fontes de configuração, todas na raiz do repositório:

- `.env` — ambiente e segredos (copie de `.env.example`; não versionado);
- `corpus.config.json` — quais repositórios e arquivos entram no acervo;
- `conselho.config.json` — professores do conselho.

`server/src/config.ts` carrega o `.env` da raiz automaticamente (`process.loadEnvFile`), qualquer que seja o diretório de onde o comando foi chamado.

## Variáveis de ambiente

| Variável | Padrão | Efeito |
|---|---|---|
| `UEFI_ROOT` | `uefiRoot` do `corpus.config.json` | Pasta que contém os repositórios UÉFIabecê. Caminho relativo é resolvido a partir da raiz deste repositório. |
| `DATABASE_URL` | — | Se definida, usa Postgres (`pg`). Sem ela, PGlite em `data/pglite`. |
| `EMBED_PROVIDER` | `ollama` | `ollama` ou `openai`. |
| `EMBED_MODEL` | `bge-m3` (Ollama) / `text-embedding-3-small` (OpenAI) | Modelo de embedding. Mudar exige `npm run ingest -- --reset`. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Usado para embeddings e para geração com `LLM_PROVIDER=ollama`. |
| `LLM_PROVIDER` | `anthropic` | `anthropic`, `openai` ou `ollama`. |
| `LLM_MODEL` | `claude-opus-5` / `gpt-5` / `qwen2.5:7b` | Modelo de geração, conforme o provedor. |
| `ANTHROPIC_API_KEY` | — | Necessária com `LLM_PROVIDER=anthropic`. |
| `OPENAI_API_KEY` | — | Necessária com `EMBED_PROVIDER=openai` ou `LLM_PROVIDER=openai`. |
| `PORT` | `8787` | Porta da API (sempre em `127.0.0.1`). Também é a porta que o servidor MCP procura. |
| `PUBLIC_ONLY` | — | `1` força todas as rotas a responder só com documentos públicos. |
| `LEXICAL_WEIGHT` | `0.5` | Peso da busca léxica no RRF. Ver [avaliacao.md](avaliacao.md). |
| `RAG_URL` | `http://127.0.0.1:$PORT` | Endereço da API usado por `mcp.ts` e pela integração Python. |

## `corpus.config.json`

```jsonc
{
  "uefiRoot": "../../../UEFIabc",       // sobrescrito por UEFI_ROOT
  "repos": [
    { "name": "uefi-uefimcp-bct", "visibility": "publico" },
    { "name": "uefi-uefimcp-bm",  "visibility": "privado" },
    {
      "name": "uefi-context",
      "visibility": "publico",
      "kind": "ecossistema",            // seção "ecossistema", disciplina "Ecossistema UÉFIabecê"
      "include": ["README.md", "projects/**"]
    }
  ],
  "extensions": [".md", ".txt", ".pdf"],
  "exclude": ["**/media/**", "**/scripts/**"],
  "maxPdfPages": 400
}
```

| Campo | Significado |
|---|---|
| `repos[].name` | Nome da pasta dentro de `uefiRoot`. Repositório ausente é listado como "não encontrado" na ingestão, sem erro. |
| `repos[].visibility` | `publico` ou `privado`. Privado é indexado localmente, mas nunca exportado. |
| `repos[].kind` | `disciplina` (padrão) ou `ecossistema`. Repositórios de disciplina leem `config/subject.json` e derivam a seção da pasta em `content/`. |
| `repos[].include` | Globs relativos ao repositório. Padrão: `["content/**"]`. |
| `extensions` | Extensões aceitas (minúsculas, com ponto). |
| `exclude` | Globs aplicados ao caminho relativo dentro de cada repositório. |
| `maxPdfPages` | Páginas extraídas por PDF; o restante é ignorado e o documento recebe o diagnóstico de truncado. |

Globs suportam `**` (qualquer número de pastas) e `*` (qualquer coisa exceto `/`); a comparação ignora caixa.

### Estrutura esperada de um repositório de disciplina

```
uefi-uefimcp-<disciplina>/
  config/subject.json        { "subject_name": "...", "course_name": "..." }
  content/
    syllabus/   exams/   exercises/   notes/   bibliography/   flashcards/
```

A pasta imediatamente abaixo de `content/` vira a `section` do documento. Arquivos diretamente em `content/` ficam com `section = "outros"`.

## `conselho.config.json`

```jsonc
{
  "padrao": ["neurociencia", "computacao", "historia"],   // convocados quando a pergunta não escolhe
  "grupos": [ { "id": "exatas", "nome": "Ciências exatas, naturais e da computação" } ],
  "professores": [
    {
      "id": "computacao",                 // único; usado na API, CLI e MCP
      "grupo": "exatas",                  // um dos grupos acima
      "area": "Ciência da Computação",    // como os colegas e a síntese se referem a ele
      "titulo": "Professor de Ciência da Computação",
      "cursos": "Bacharelado em Ciência da Computação",
      "repos": ["uefi-uefimcp-pd"],       // acervo da área; [] = sem acervo, perspectiva toda [geral]
      "lente": "como a questão aparece em representação, algoritmos e ..."
    }
  ]
}
```

Regras verificadas por `server/test/council.test.ts`:

- ids únicos, `grupo` existente, todos os ids de `padrao` existentes;
- todo item de `repos` existe em `corpus.config.json`;
- licenciaturas compartilhadas aparecem no campo `cursos` do professor da área.

A ordem de `professores` é a ordem de exibição e de geração.
