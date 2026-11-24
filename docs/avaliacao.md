# Avaliação

`npm run eval` roda as perguntas de `eval/perguntas.jsonl` e grava o relatório em `eval/resultados/`. A aba **Avaliação** da interface lê o último relatório público.

## O conjunto

34 perguntas escritas à mão a partir da leitura dos documentos, não a partir do que a busca devolve (assim o gabarito não herda os acertos do sistema):

| Conjunto | Perguntas | De onde vêm |
|---|---|---|
| `publico` | 26 | PPCs do BC&T e da Biotecnologia, listas de opção limitada, regras de transição, planejamento de oferta 2026, documentação do UÉFIabecê |
| `privado` | 8 | ementas, planos de ensino e material de estudo dos repositórios privados; só roda localmente |

Os tipos cobrem fato simples, lista, comparação entre versões de PPC, **conflito** (pub-03: o próprio PPC 2023 do BC&T diz "480 horas" de opção limitada no texto e "32 créditos / 384 horas" no Quadro 3; a resposta certa aponta as duas) e **fora do acervo** (pub-22 a pub-24, que o sistema deve recusar; pub-24 pergunta a nota de corte do SiSU, assunto que o PPC menciona sem dar o número).

Cada item lista os documentos que contêm a resposta (`fontes`) e os fatos que a resposta precisa conter (`fatos`, grupos de alternativas; a comparação ignora acento, caixa e espaços, então "2 - 2 - 0 - 4" casa com "2-2-0-4").

## Métricas

**Recuperação**, sem LLM, para as três estratégias de busca:

- `hit@k`: algum dos k trechos devolvidos vem de um documento esperado.
- `MRR`: média de 1/posição do primeiro trecho certo.

**Respostas**, com o gerador configurado:

- *aprovada*: todos os fatos presentes, ao menos uma citação e nenhuma citação para fonte inexistente; nas perguntas fora do acervo, recusar sem inventar citação.
- *cita a fonte esperada*: alguma citação aponta para um documento do gabarito.
- *abstenção indevida*: disse que não sabia numa pergunta que o acervo responde.

A correção é por regra, como no [Recado bench](https://github.com/ArthurGaspar/pv-bench): previsível e auditável, ao custo de reprovar uma resposta certa escrita com outras palavras. Os relatórios guardam o texto de cada resposta para conferência manual.

## O que a avaliação já mudou

A primeira rodada de recuperação (26 perguntas públicas, 23 com resposta no acervo, bge-m3, k = 8) mostrou a busca híbrida **pior** que a vetorial pura:

| Busca | hit@1 | hit@3 | MRR |
|---|---|---|---|
| Vetorial | 83% | 100% | 0,91 |
| Híbrida (RRF, pesos iguais) | 57% | 91% | 0,76 |
| Léxica (OR entre termos, `ts_rank_cd`) | 30% | 52% | 0,46 |

O culpado era a parte léxica: um OR entre todos os termos, ordenado por `ts_rank_cd`, que não tem IDF e favorece trechos longos do PPC cheios de palavras comuns ("disciplinas", "horas", "curso"). Com pesos iguais no RRF, esse ruído empurrava para baixo os acertos da busca vetorial.

A correção foi ordenar a busca léxica primeiro pela **cobertura** (quantos termos distintos da pergunta o trecho contém) e só então por `ts_rank_cd`, o que equivale a uma transição suave de AND para OR:

| Busca | hit@1 | MRR |
|---|---|---|
| Léxica com cobertura | 57% | 0,72 |
| Híbrida, peso léxico 1 | 74% | 0,84 |
| Híbrida, peso léxico 0,5 (padrão) | 74% | 0,85 |
| Híbrida, peso léxico 0,3 | 78% | 0,88 |
| Vetorial | 83% | 0,91 |

A vetorial pura ainda vence por pouco nesta amostra, o equivalente a uma ou duas perguntas em 23. A híbrida continua sendo o padrão porque é ela que acerta as perguntas com código de disciplina e termos exatos (na primeira rodada, pub-07 e pub-08 ficaram em 1º lugar na híbrida e em 2º e 3º na vetorial), um tipo de pergunta pouco representado no conjunto público e comum no uso real. O peso 0,5 foi fixado antes de olhar o resultado de 0,3, para não ajustar o sistema às mesmas 23 perguntas que o medem. `LEXICAL_WEIGHT` no `.env` muda o peso.

Próximo passo natural: mais perguntas com códigos e nomes próprios no conjunto público, para que essa escolha deixe de depender de dois itens.

### Primeira rodada de respostas

Com um modelo gratuito via OpenRouter (`nvidia/nemotron-3-ultra-550b-a55b:free`, `OPENAI_BASE_URL=https://openrouter.ai/api/v1`), as 26 perguntas públicas:

| Métrica | Resultado |
|---|---|
| Respostas aprovadas | 81% (21 de 26) |
| Com todos os fatos do gabarito | 91% (21 de 23) |
| Citam o documento esperado | 74% |
| Abstenção correta fora do acervo | 100% (3 de 3) |
| Abstenções indevidas | 2 |
| Citações inválidas | 0 |
| Latência mediana | 14,7 s |

Das cinco reprovações, três (pub-03, pub-16, pub-20) têm os fatos certos mas nenhuma citação `[n]` válida: o modelo às vezes escreve `[Fonte 1 (p. 11)]`, formato que `parseCitations` não aceita, e a regra reprova. As outras duas são abstenções indevidas: pub-18 (prazo até a recuperação) e pub-21, cujo documento esperado nem chega à busca híbrida (só a vetorial o encontra). O prompt não foi ajustado para este modelo; a nota mede a aderência dele ao contrato de citações tal como está.

O plano gratuito do OpenRouter limita a 20 requisições por minuto e o pool de cada modelo `:free` é compartilhado. `google/gemma-4-31b-it:free` devolveu 429 em todas as chamadas no mesmo dia. Por isso o gerador compatível com a OpenAI repete a chamada com espera crescente ao receber 429/503.

## Rodar

```bash
npm run eval                         # público, recuperação + respostas
npm run eval -- --no-answers         # só recuperação (sem chave de API)
npm run eval -- --set privado        # local; o resultado fica fora do git
LLM_PROVIDER=ollama npm run eval     # respostas com um modelo local
LLM_PROVIDER=openai OPENAI_BASE_URL=https://openrouter.ai/api/v1 LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free npm run eval   # modelo gratuito, chave do OpenRouter em OPENAI_API_KEY
```
