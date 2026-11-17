# Documentação

Referência técnica do Acervo UFABC. A apresentação do projeto e o passo a passo para rodar estão no [README da raiz](../README.md).

| Documento | Conteúdo |
|---|---|
| [arquitetura.md](arquitetura.md) | Pipeline de ingestão e de resposta, módulos, modelo de dados, invariantes |
| [configuracao.md](configuracao.md) | Variáveis de ambiente, `corpus.config.json`, `conselho.config.json` |
| [api.md](api.md) | Rotas HTTP, eventos SSE, ferramentas MCP, comandos de terminal |
| [desenvolvimento.md](desenvolvimento.md) | Testes, tarefas comuns (novo repositório, novo professor, novo provedor), problemas frequentes |
| [avaliacao.md](avaliacao.md) | Conjunto de perguntas, métricas e o histórico das decisões medidas |
| [../integrations/python/README.md](../integrations/python/README.md) | Integração com os servidores MCP de disciplina em Python |

O que está aqui descreve contratos e decisões estáveis. Números do acervo (quantos documentos, trechos, nós) mudam a cada ingestão e ficam em `/api/health` e na interface, não nesta documentação.
