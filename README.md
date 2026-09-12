# SDD Bot

CLI que transforma um Documento de Design de Software (SDD) em backlog estruturado e publica
issues no GitHub, organizadas em sprints e separadas por camada (frontend/backend).

Ver `issueMaker.md` para o Documento de Design de Software completo e
`sdd-bot-plano-implementacao.md` (plano de sprints da construção deste próprio bot).

## Setup

```bash
npm install
cp .env.example .env
# preencher GROQ_API_KEY, OLLAMA_BASE_URL e GITHUB_TOKEN no .env
```

## Uso (desenvolvimento)

```bash
npm run dev -- --help
```

## Comandos

| Comando                                                                                 | Descrição                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `sdd-bot process --file <sdd> --sprint-length <duração> [--out <dir>]`              | Pipeline completo (analyze + plan + backlog) →`.md` por camada        |
| `sdd-bot publish --backlog <path> --repo <org/repo> [--mode add\|replace] [--dry-run]` | Publicação de issues no GitHub                                         |
| `sdd-bot analyze --file <path> [--out <path>]`                                        | (uso granular) Ingest + extração de requisitos →`requirements.json` |
| `sdd-bot plan --in <requirements.json> --sprint-length <duração> [--out <path>]`    | (uso granular) Planejamento →`sprint-plan.json`                       |
| `sdd-bot backlog --in <requirements.json> --plan <sprint-plan.json> [--out <dir>]`    | (uso granular) Geração de backlog →`.md` por camada                 |

`process` roda a mesma sequência de `analyze` → `plan` → `backlog` em um único passo, sem
persistir `requirements.json`/`sprint-plan.json` em disco — só os `backlog-*.md` finais. Use os
comandos granulares (`analyze`/`plan`/`backlog`) quando quiser inspecionar ou editar os
artefatos intermediários manualmente entre uma etapa e outra.

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
  --backlog ./out/backlog-backend.md \
  --repo <org>/<repo> \
  --dry-run

# 4. Publicar de fato (usa --mode replace por padrão)
node dist/cli/index.js publish \
  --backlog ./out/backlog-backend.md \
  --repo <org>/<repo>
```

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
| `OLLAMA_BASE_URL` | `process` (ou `analyze`/`plan`/`backlog`, opcional) | Fallback local ativado automaticamente em rate-limit do Groq         |
| `GITHUB_TOKEN`    | `publish`                                                 | Token com permissão de escrita em issues no repositório de destino |

Nenhuma dessas credenciais é logada pela CLI em nenhuma etapa do pipeline.

## Divergências em relação ao SDD original

- **`requirementIds` em `BacklogItem`:** o schema `BacklogItem` da Seção 4.3 do `issueMaker.md`
  não previa um campo ligando cada item de volta aos `Requirement.id` que o originaram, o que
  tornava impossível cumprir o NFR de Rastreabilidade da Seção 10 ("toda issue publicada
  referencia, indiretamente via `requirements.json`, a seção original do SDD"). Foi adicionado
  o campo `requirementIds: string[]`, preenchido pela IA na etapa `backlog` e exibido tanto na
  issue publicada (linha "**Rastreabilidade:**") quanto nos metadados internos do Markdown.

## Scripts

- `npm run build` — compila TypeScript
- `npm run dev` — executa a CLI via `tsx` sem build
- `npm test` — roda a suíte de testes (Jest)
- `npm run lint` — ESLint
- `npm run format` — Prettier
