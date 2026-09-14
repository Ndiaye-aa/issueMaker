# SDD Bot

CLI que transforma um Documento de Design de Software (SDD) em backlog estruturado e publica
issues no GitHub, organizadas em sprints e separadas por camada (frontend/backend).

Ver `issueMaker.md` para o Documento de Design de Software completo e
`sdd-bot-plano-implementacao.md` (plano de sprints da construção deste próprio bot).

## Setup

```bash
npm install          # não use --omit=optional: o binário do Claude Code vem como optional dependency
cp .env.example .env
# escolher AI_PRIMARY / AI_FALLBACK e preencher as credenciais do provedor escolhido
# (e GITHUB_TOKEN para o comando publish)
```

## Escolhendo os provedores de IA

Tudo é definido no `.env`. `AI_PRIMARY` é quem responde; `AI_FALLBACK` assume o restante do
pipeline quando o principal devolve rate limit ou cota esgotada (`none` desliga).

| Provedor      | O que é                                                                 | Variáveis                                                    |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `claude-code` | Claude pela própria máquina (Agent SDK com binário do Claude Code embutido). Usa o login já feito no Claude Code; sem chave no `.env` | `CLAUDE_MODEL` (default `claude-sonnet-5`), `CLAUDE_LIGHT_MODEL` (decisões mecânicas, default `claude-haiku-4-5-20251001`), `CLAUDE_EFFORT`/`CLAUDE_THINKING` (raciocínio, default `low`/`disabled`), `CLAUDE_TIMEOUT_MS`, `ANTHROPIC_API_KEY` opcional |
| `groq`        | Camada gratuita da Groq                                                 | `GROQ_API_KEY`, `GROQ_MODEL`                                 |
| `openai`      | Qualquer API compatível com a OpenAI (OpenAI, OpenRouter, Together...) | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`          |
| `ollama`      | Modelo local, sem chave                                                 | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`                            |

Receitas:

```bash
# Só Claude local, sem fallback (default do modelo: claude-sonnet-5)
AI_PRIMARY=claude-code
AI_FALLBACK=none

# Comportamento das versões anteriores: Groq gratuito com Ollama de reserva
AI_PRIMARY=groq
AI_FALLBACK=ollama

# Só Ollama, 100% offline
AI_PRIMARY=ollama
AI_FALLBACK=none
```

O provedor `claude-code` roda o Claude Code como subprocesso local. Sem `ANTHROPIC_API_KEY` ele
usa o login da máquina (`claude` → `/login`); com a chave definida, ela tem prioridade. A
Anthropic não permite que terceiros ofereçam login do claude.ai em produtos construídos com o
Agent SDK: esse modo é para uso pessoal na sua própria conta. Para distribuir o sdd-bot, use
`ANTHROPIC_API_KEY` ou outro provedor.

## Uso (desenvolvimento)

```bash
npm run dev -- --help
```

## Comandos

| Comando                                                                                 | Descrição                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `sdd-bot process --file <sdd> --sprint-length <duração> [--out <dir>] [--max-per-sprint <n>] [--capacity <pontos>] [--buffer <fração>] [--start-date <YYYY-MM-DD>] [--no-cache]` | Pipeline completo (analyze + plan + backlog) → JSONs intermediários + `.md` por camada |
| `sdd-bot publish --backlog <path...> --repo <org/repo> [--sprint-plan <path>] [--mode add\|replace] [--dry-run]` | Publicação de issues no GitHub (ordem topológica, labels por dimensão, milestones por sprint) |
| `sdd-bot analyze --file <path> [--out <path>]`                                        | (uso granular) Ingest + extração de requisitos →`requirements.json` |
| `sdd-bot plan --in <requirements.json> --sprint-length <duração> [--out <path>] [--max-per-sprint <n>] [--capacity <pontos>] [--buffer <fração>] [--start-date <YYYY-MM-DD>]` | (uso granular) Planejamento →`sprint-plan.json`                       |
| `sdd-bot backlog --in <requirements.json> --plan <sprint-plan.json> [--out <dir>]`    | (uso granular) Geração de backlog →`.md` por camada                 |

`process` roda a mesma sequência de `analyze` → `plan` → `backlog` em um único passo e grava
também os intermediários (`requirements.json`, `sprint-plan.json`) no diretório de saída, para
auditoria e rastreabilidade. Use os comandos granulares (`analyze`/`plan`/`backlog`) quando
quiser editar os artefatos intermediários manualmente entre uma etapa e outra.

### Como o pipeline se comporta

- **Paralelismo:** chunks do SDD, confirmações de duplicata e lotes de backlog são
  independentes e rodam em paralelo no provedor principal (`AI_CONCURRENCY`, default 3). No
  Ollama as chamadas são sempre seriais (CPU não ganha com paralelismo). A numeração de
  `REQ-n`/`BL-nnn` segue a ordem do documento, não a ordem de chegada das respostas.
- **Cache de respostas:** cada chamada de IA é memoizada em `.sdd-bot-cache/` (chave =
  prompt + schema + modelo). Rodar `process` de novo sobre o mesmo SDD é instantâneo e não
  gasta cota; uma falha na etapa 3 não obriga a refazer as etapas 1 e 2. `--no-cache` ou
  `SDD_BOT_CACHE=0` forçam regeneração.
- **Lotes de backlog:** requisitos da mesma sprint/camada entram juntos numa única chamada
  de geração de backlog (`BACKLOG_BATCH_SIZE`, default 4) — o system prompt, que é a maior
  fatia de tokens do pipeline, deixa de ser reenviado uma vez por requisito. Forçado a 1
  (uma chamada por requisito) quando o provedor principal é o Ollama. Ao final de cada
  comando, a CLI imprime quantos tokens de entrada/saída (e custo estimado) cada provedor
  consumiu.
- **Esforço ponderado, não contagem:** cada requisito recebe na extração um `effort`
  (`xs`/`s`/`m`/`l`/`xl` → 1/2/3/5/8 pontos). A capacidade nominal por sprint vem de
  `--capacity` (default: 1 ponto por dia de `--sprint-length`, ou seja, `"2 semanas"` → 14)
  e `--buffer` (default `0.75`) reserva folga para imprevistos; a capacidade efetiva é
  `floor(capacity × buffer)` e o número mínimo de sprints é `ceil(esforço total ÷ capacidade
  efetiva)`. Esses números vão para o prompt de planejamento.
- **Distribuição determinística:** modelos tendem a colocar tudo no sprint 1. Depois da
  validação de dependências, uma sprint que passe da capacidade em pontos **ou** de
  `--max-per-sprint` (default 20) transborda para a seguinte: saem primeiro os `could`,
  depois `should`, levando junto quem depende deles. Em seguida, `must` (depois `should`) de
  sprints posteriores são puxados para frente enquanto houver capacidade e as dependências
  permitirem. Sprints esvaziadas somem e a numeração é refeita; se a composição de uma
  sprint mudou, o `goal` dela é reescrito por uma chamada extra de IA (nunca genérico).
- **Auditoria do plano:** o `sprint-plan.json` ganha `warnings` (também no stderr) para:
  goal genérico, carga desbalanceada (uma sprint > 130% da média das outras, ou diferença
  > 50% entre a mais cheia e a mais vazia), sprint sobrecarregada ou subutilizada, sprint só
  de `could` com `must` pendente adiante sem dependência que justifique, e dependência
  violada. O resumo `Sprint N: X pts / Y (Z%) — k requisito(s)` sai no stderr.
- **Datas:** com `--start-date` (default: hoje) e uma duração reconhecível em
  `--sprint-length` ("2 semanas", "10 dias", "3w"), cada sprint recebe `startDate`/`dueDate`
  sequenciais e sem sobreposição, usados como due date dos milestones.
- **Requisitos `shared`:** vão para o backlog de backend (infra, dados, segurança
  transversal), em vez de serem descartados.
- **Retentativas:** erros de rede/5xx e loops de geração do Ollama repetem o mesmo prompt;
  respostas que falham no schema recebem o erro anexado ao prompt para o modelo corrigir.

Todo `--out` é opcional: se você não passar, os arquivos são salvos em `./out` (criado
automaticamente se não existir) — `./out/requirements.json`, `./out/sprint-plan.json`,
`./out/backlog-frontend.md` e `./out/backlog-backend.md`, conforme o comando. Passe `--out`
explicitamente só se quiser salvar em outro lugar.

## Uso ponta a ponta

Fluxo padrão, com apenas 2 comandos — processar o SDD e publicar. Sem `--out`, tudo cai em
`./out` automaticamente:

```bash
npm run build

# 1. Ler e processar o SDD (analyze + plan + backlog em um passo)
node dist/cli/index.js process --file issueMaker.md --sprint-length "2 semanas"

# 2. Revisar manualmente ./out/backlog-frontend.md e ./out/backlog-backend.md

# 3. Validar o que seria publicado, sem escrever no GitHub
node dist/cli/index.js publish \
  --backlog ./out/backlog-backend.md ./out/backlog-frontend.md \
  --sprint-plan ./out/sprint-plan.json \
  --repo <org>/<repo> \
  --dry-run

# 4. Publicar de fato (usa --mode replace por padrão)
node dist/cli/index.js publish \
  --backlog ./out/backlog-backend.md ./out/backlog-frontend.md \
  --sprint-plan ./out/sprint-plan.json \
  --repo <org>/<repo>
```

`--sprint-plan` é opcional, mas sem ele os milestones são criados só com o título (sem
objetivo nem due date) e a CLI avisa. Passe as duas camadas no mesmo `publish` para que as
dependências entre elas virem referências `#N` (ver abaixo).

### Dependências entre issues

Cada item de backlog carrega `dependsOn`: os ids de requisito (`REQ-x`) dos quais o seu
requisito depende, derivados de `Requirement.dependencies` (nunca do modelo). No `backlog.md`
isso aparece como `**Depende de:** REQ-005`; na issue publicada vira `**Depende de:** #12`, que
o GitHub linka sozinho — sem Projects, sem aba Relationships, sem label "blocked".

Para que o número exista na hora de citar, `publish` cria as issues em **ordem topológica**
numa única passada (a dependência sempre antes do dependente; itens sem relação mantêm a
ordem sprint → id). Um ciclo em `dependencies` é erro antes de qualquer escrita. Dependências
já publicadas em execução anterior ou em outra camada são resolvidas em modo `add` pelas
issues `sdd-bot` abertas (o corpo carrega os ids de requisito); em modo `replace` tudo é
recriado. O que não puder ser resolvido fica como `REQ-x (não publicado)`.

### Labels e milestones

Label responde "o quê" (categoria atemporal); milestone responde "quando" (janela temporal).

- **Labels** são sempre derivadas de dado estruturado, nunca do texto livre do modelo, uma por
  dimensão e no formato `dimensão: valor`, para permitir filtros combinados (`AND`) e cores por
  família:

  | Dimensão   | Origem                                   | Valores                                | Cor                |
  | ---------- | ---------------------------------------- | -------------------------------------- | ------------------ |
  | `type`     | `BacklogItem.type`                       | `feature`, `bug`, `tech-debt`          | família azul       |
  | `layer`    | `BacklogItem.layer`                      | `frontend`, `backend`                  | família roxa       |
  | `priority` | calculada dos requisitos de origem       | `must`, `should`, `could`              | vermelho → laranja |
  | `area`     | seção do SDD de onde veio o requisito    | slug da seção (sem numeração)          | tons de verde      |
  | `status`   | `technicalSpecificity.needsClarification`| `needs-clarification` (só quando true) | amarelo            |
  | —          | marcador do bot                          | `sdd-bot`                              | cinza              |

  Não existe mais `sprint-N` (é milestone) nem label livre gerada pelo modelo. Em cada
  `publish`, labels ausentes são criadas e as existentes têm a cor alinhada à paleta.
- **Milestones** são sempre `Sprint N`, um por sprint, com descrição = objetivo do sprint e
  due date = `dueDate` do plano. Milestones já existentes (inclusive fechados) são reaproveitados
  e atualizados, nunca duplicados. Ao final de cada `publish` (fora de `--dry-run`), milestones
  `Sprint N` cujas issues estão todas fechadas são fechados automaticamente.

`publish` usa `--mode replace` como padrão: a cada execução, fecha as issues já publicadas
com a label `sdd-bot` e recria a partir do backlog atual. Use `--mode add` explicitamente se
quiser apenas adicionar itens novos sem tocar nas issues já existentes (itens com o mesmo
título são ignorados nesse modo).

Fluxo granular equivalente (útil para inspecionar `requirements.json`/`sprint-plan.json` entre
etapas — também caem em `./out` se `--out` for omitido):

```bash
node dist/cli/index.js analyze --file issueMaker.md
node dist/cli/index.js plan --in ./out/requirements.json --sprint-length "2 semanas"
node dist/cli/index.js backlog --in ./out/requirements.json --plan ./out/sprint-plan.json
```

## Variáveis de ambiente

| Variável           | Obrigatória para                                           | Descrição                                                          |
| ------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `GROQ_API_KEY`    | `process` (ou `analyze`/`plan`/`backlog`)           | Provedor principal de IA (camada gratuita do Groq)                   |
| `OLLAMA_BASE_URL` | `process` (ou `analyze`/`plan`/`backlog`, opcional) | URL do Ollama local (default `http://localhost:11434`)               |
| `OLLAMA_MODEL`    | `process` (ou `analyze`/`plan`/`backlog`, opcional) | Modelo do fallback local (default `qwen2.5:3b-instruct`; `ollama pull` antes) |
| `BACKLOG_BATCH_SIZE` | opcional | Requisitos por chamada de geração de backlog (default 4; forçado a 1 no Ollama) |
| `CLAUDE_LIGHT_MODEL` | opcional | Modelo para decisões mecânicas do `claude-code` (default `claude-haiku-4-5-20251001`) |
| `CLAUDE_EFFORT` / `CLAUDE_THINKING` | opcional | Esforço de raciocínio do `claude-code` (default `low` / `disabled`) |

| `GITHUB_TOKEN`    | `publish`                                                 | Token com permissão de escrita em issues no repositório de destino |

Quando o Groq responde rate limit / cota esgotada (HTTP 429), a CLI avisa uma vez no stderr e
roda **todo o restante do pipeline** no Ollama, sem tentar o Groq de novo naquela execução.
O progresso por chunk/etapa também vai para o stderr (o stdout fica só com os resultados).
O backlog é gerado por camada, agrupando até `BACKLOG_BATCH_SIZE` requisitos da mesma sprint
por chamada de IA (default 4; sempre 1 por chamada no Ollama; cada requisito ainda vira
exatamente um item), com os ids `BL-nnn` renumerados por camada ao final. O prompt é o de um "engenheiro sênior
escrevendo issues" com cinco regras (descrição = mecanismo, critérios testáveis e não
redundantes, casos negativos obrigatórios, especificidade técnica com números e nomes reais,
título com verbo no infinitivo ≤ 70 caracteres). As mesmas regras são validadas
deterministicamente sobre a resposta do modelo (termos vagos como "corretamente"/"com sucesso",
descrição igual ao comportamento esperado, menos de 2 critérios sem justificativa, critérios
duplicados, título genérico ou prefixado com o tipo); uma violação volta ao modelo como erro
de validação para correção. Cada issue ganha a seção **Especificidade técnica** (códigos HTTP,
campos, limites e a decisão técnica pendente, se houver), e itens com decisão pendente recebem
a label `status: needs-clarification`. Se dois itens da mesma camada saírem com o mesmo título,
a CLI avisa (o modo `add` do `publish` usaria o título para deduplicar).

Nenhuma dessas credenciais é logada pela CLI em nenhuma etapa do pipeline.

## Divergências em relação ao SDD original

- **`requirementIds` em `BacklogItem`:** o schema `BacklogItem` da Seção 4.3 do `issueMaker.md`
  não previa um campo ligando cada item de volta aos `Requirement.id` que o originaram, o que
  tornava impossível cumprir o NFR de Rastreabilidade da Seção 10 ("toda issue publicada
  referencia, indiretamente via `requirements.json`, a seção original do SDD"). Foi adicionado
  o campo `requirementIds: string[]`, preenchido localmente na etapa `backlog` (um requisito
  por item) e exibido tanto na issue publicada (linha "**Rastreabilidade:**") quanto nos
  metadados internos do Markdown.
- **`effort` em `Requirement` e `startDate`/`dueDate`/`warnings` em `SprintPlan`:** o SDD
  planejava sprints por contagem de requisitos. O esforço estimado na extração permite planejar
  por capacidade em pontos; as datas alimentam os due dates dos milestones e os avisos
  registram a auditoria do plano. Arquivos antigos sem `effort` são lidos como `m`.
- **`technicalSpecificity` em `BacklogItem`:** o template da Seção 6 não previa o bloco de
  especificidade técnica nem a sinalização de decisão pendente; ambos foram adicionados
  (seção "**Especificidade técnica:**" na issue, opcional no parse para backlogs antigos).
- **`epic` = seção do SDD; `labels` do item não são publicadas:** o SDD deixava o modelo
  escolher épico e labels livres, o que gerava labels de cardinalidade alta e inconsistentes.
  O épico passa a ser `Requirement.sourceSection` (vira a label `area: ...`) e as labels
  publicadas são só as derivadas de enum/campo calculado. Também saiu a label `sprint-N`,
  redundante com o milestone `Sprint N`.

## Scripts

- `npm run build` — compila TypeScript
- `npm run dev` — executa a CLI via `tsx` sem build
- `npm test` — roda a suíte de testes (Jest)
- `npm run lint` — ESLint
- `npm run format` — Prettier
