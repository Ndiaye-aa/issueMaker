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

| Comando | Descrição |
|---|---|
| `sdd-bot analyze --file <path> --out <path>` | Ingest + extração de requisitos → `requirements.json` |
| `sdd-bot plan --in <requirements.json> --sprint-length <duração> --out <path>` | Planejamento → `sprint-plan.json` |
| `sdd-bot backlog --in <requirements.json> --plan <sprint-plan.json> --out <dir>` | Geração de backlog → `.md` por camada |
| `sdd-bot publish --backlog <path> --repo <org/repo> [--mode add\|replace] [--dry-run]` | Publicação de issues no GitHub |

## Uso ponta a ponta

```bash
npm run build

# 1. Extrair requisitos do SDD
node dist/cli/index.js analyze --file issueMaker.md --out ./out/requirements.json

# 2. Planejar sprints
node dist/cli/index.js plan \
  --in ./out/requirements.json \
  --sprint-length "2 semanas" \
  --out ./out/sprint-plan.json

# 3. Gerar backlog em Markdown (frontend + backend)
node dist/cli/index.js backlog \
  --in ./out/requirements.json \
  --plan ./out/sprint-plan.json \
  --out ./out

# 4. Revisar manualmente ./out/backlog-frontend.md e ./out/backlog-backend.md

# 5. Validar o que seria publicado, sem escrever no GitHub
node dist/cli/index.js publish \
  --backlog ./out/backlog-backend.md \
  --repo <org>/<repo> \
  --dry-run

# 6. Publicar de fato
node dist/cli/index.js publish \
  --backlog ./out/backlog-backend.md \
  --repo <org>/<repo>
```

Reexecuções do `publish` em modo `add` (padrão) não duplicam issues já publicadas com o
mesmo título; use `--mode replace` para fechar as issues existentes com a label `sdd-bot`
antes de recriar.

## Variáveis de ambiente

| Variável | Obrigatória para | Descrição |
|---|---|---|
| `GROQ_API_KEY` | `analyze`, `plan`, `backlog` | Provedor principal de IA (camada gratuita do Groq) |
| `OLLAMA_BASE_URL` | `analyze`, `plan`, `backlog` (opcional) | Fallback local ativado automaticamente em rate-limit do Groq |
| `GITHUB_TOKEN` | `publish` | Token com permissão de escrita em issues no repositório de destino |

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
