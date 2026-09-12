# Plano de Implementação — SDD Bot

## Contexto

O documento `issueMaker.md` já contém o SDD completo (v1.0) do **SDD Bot**: uma CLI que
transforma um Documento de Design de Software em backlog estruturado e publica issues no
GitHub, organizadas em sprints e separadas por camada (frontend/backend). A Seção 13 do SDD
referencia um "documento separado" com o plano de implementação (Sprint 0 → Sprint 6), que
ainda não existe. O diretório do projeto está vazio (sem git, sem código) — este é um projeto
greenfield.

Objetivo deste plano: detalhar esse plano de implementação ausente, quebrando a construção do
próprio SDD Bot em sprints incrementais e testáveis, cada um entregando um pedaço vertical do
pipeline descrito no SDD (Ingest → Extração IA → Planejamento → Backlog → Publicação).

## Abordagem

Seguir rigorosamente a arquitetura já definida no SDD (Seções 2–9): motor de IA resiliente com
provider abstrato (`AIProvider`), validação Zod em toda saída de IA, checkpoint humano
obrigatório antes de publicar, e separação estrita entre lógica determinística e chamadas de IA.
Cada sprint entrega um comando funcional da CLI (`analyze`, `plan`, `backlog`, `publish`), na
mesma ordem do pipeline, para permitir testes manuais incrementais ponta a ponta.

### Estrutura de projeto (criada no Sprint 0, conforme Seção 9 do SDD)

```
sdd-bot/
├── src/
│   ├── ingest/{parsers.ts, chunker.ts}
│   ├── ai/
│   │   ├── providers/{groq.ts, ollama.ts}
│   │   ├── client.ts
│   │   └── prompts/{extract.ts, plan.ts, backlog.ts}
│   ├── schemas/{requirement.ts, sprint-plan.ts, backlog-item.ts}
│   ├── render/backlog-markdown.ts
│   ├── publish/{parse-backlog.ts, github.ts}
│   └── cli.ts
├── .env.example
├── package.json
└── tsconfig.json
```

Stack: TypeScript/Node.js, `commander`, `zod`, `mammoth`, `pdf-parse`, SDK `openai` (compatível
com Groq/Ollama via base URL), `octokit`, `jest`, `eslint`+`prettier` (todos definidos na Seção
11 do SDD).

---

## Sprint 0 — Fundação

**Objetivo:** projeto instalável e executável, sem lógica de negócio ainda.

- `git init`, `package.json`, `tsconfig.json` (strict mode)
- Estrutura de pastas de `src/` (acima)
- `commander` configurado em `src/cli.ts` com os 4 subcomandos como stubs (`analyze`, `plan`,
  `backlog`, `publish`) que apenas imprimem "not implemented"
- `eslint` + `prettier` configurados
- `jest` configurado com um teste trivial passando
- `.env.example` com `GROQ_API_KEY`, `GITHUB_TOKEN`, `OLLAMA_BASE_URL`
- README mínimo com instruções de setup

**Critério de aceite:** `npm run build && npx sdd-bot --help` lista os 4 comandos.

---

## Sprint 1 — Schemas + Motor de IA

**Objetivo:** camada de IA testável isoladamente, sem depender de ingest/parsing ainda.

- Schemas Zod: `Requirement`, `SprintPlan`, `BacklogItem` (Seção 4) em `src/schemas/`
- Interface `AIProvider` e `CompletionRequest` (Seção 3.2)
- `src/ai/providers/groq.ts` e `ollama.ts` — ambos usando SDK `openai` com `baseURL` customizada
- `ResilientAIClient` (Seção 3.3): retry com schema validation, backoff exponencial, fallback em
  `isRateLimitError` (HTTP 429)
- Testes unitários com providers mockados: cenário de sucesso, cenário de retry por schema
  inválido, cenário de fallback por rate-limit, cenário de falha total (ambos os providers)

**Critério de aceite:** suite de testes cobre os 4 cenários de erro da Seção 3.4 do SDD.

---

## Sprint 2 — Ingest & Extração de Requisitos (comando `analyze`)

**Objetivo:** primeiro comando real e ponta a ponta.

- `src/ingest/parsers.ts`: leitura de `.md` (fs direto), `.docx` (mammoth), `.pdf` (pdf-parse)
- `src/ingest/chunker.ts`: chunking por seção (via headings), fallback por tamanho de tokens
- `src/ai/prompts/extract.ts` com o prompt do Apêndice A.1
- Lógica de extração: uma chamada de IA por chunk → merge dos arrays → deduplicação por
  similaridade textual de títulos, com confirmação via chamada adicional de IA para pares acima
  do threshold (Seção 5.2)
- Persistência em `requirements.json`
- Implementar comando `sdd-bot analyze --file <path> --out <path>`

**Critério de aceite:** rodar `analyze` num SDD de exemplo (pode ser o próprio `issueMaker.md`)
gera um `requirements.json` válido contra o schema `Requirement`.

---

## Sprint 3 — Planejamento de Sprints (comando `plan`)

**Objetivo:** organizar requisitos em sprints respeitando dependências.

- `src/ai/prompts/plan.ts` com o prompt do Apêndice A.2
- Chamada única de IA recebendo todos os requisitos + duração do sprint
- Validação determinística de grafo pós-IA (Seção 5.3): nenhum requisito pode estar em sprint
  anterior a uma de suas dependências; reordenação automática se a IA violar essa regra
- Persistência em `sprint-plan.json`
- Implementar comando `sdd-bot plan --in <requirements.json> --sprint-length <duração> --out <path>`

**Critério de aceite:** teste unitário do validador de grafo com um caso onde a IA (mockada)
retorna uma ordenação inválida, confirmando que o sistema corrige antes de persistir.

---

## Sprint 4 — Geração de Backlog (comando `backlog`)

**Objetivo:** produzir os arquivos Markdown revisáveis por humano.

- `src/ai/prompts/backlog.ts` com o prompt do Apêndice A.3
- Duas chamadas de IA independentes (frontend/backend), filtrando requisitos por `layer`
- `src/render/backlog-markdown.ts`: conversão determinística de `BacklogItem[]` para Markdown
  seguindo o template canônico (Seção 6) — incluindo regras condicionais (`reproSteps` só para
  bugs, `environment` só se especificado)
- Implementar comando `sdd-bot backlog --in <requirements.json> --plan <sprint-plan.json> --out <dir>`
  gerando `backlog-frontend.md` e `backlog-backend.md`

**Critério de aceite:** Markdown gerado é parseável de volta (round-trip) para `BacklogItem[]`
sem perda de campos — valida o parser que será reaproveitado no Sprint 5.

---

## Sprint 5 — Publicação (comando `publish`)

**Objetivo:** fechar o pipeline com escrita real (opcional) no GitHub.

- `src/publish/parse-backlog.ts`: parser determinístico de Markdown → `BacklogItem[]`
  (reaproveita o round-trip validado no Sprint 4)
- `src/publish/github.ts` via `octokit`: `ensureLabelsExist`, criação de issues com labels
  `sdd-bot` + `sprint-N` + labels específicas
- Modo `replace`: fecha issues existentes com label `sdd-bot` antes de recriar
- Modo `--dry-run`: executa todo o fluxo exceto as chamadas de escrita à API, exibindo o que
  seria feito
- Implementar comando `sdd-bot publish --backlog <path> --repo <org/repo> [--mode add|replace] [--dry-run]`

**Critério de aceite:** `--dry-run` contra um backlog de exemplo lista corretamente todas as
issues que seriam criadas/fechadas, sem nenhuma chamada de escrita real à API do GitHub.

---

## Sprint 6 — Hardening e Documentação

**Objetivo:** robustez e usabilidade antes de considerar v1.0 pronta.

- Cobertura de testes para casos de borda: SDD sem requisitos extraíveis, PDF escaneado
  (comportamento esperado: falha clara, não crash), rate-limit simultâneo em ambos providers
- Auditoria de segurança: garantir que `GROQ_API_KEY`/`GITHUB_TOKEN` nunca aparecem em logs
  (Seção 10 — Segurança)
- Teste de idempotência do modo `add` (não duplicar issues com mesmo conteúdo)
- README completo: instalação, variáveis de ambiente, exemplo de uso ponta a ponta dos 4
  comandos em sequência
- Revisão final de todos os Requisitos Não-Funcionais (Seção 10) como checklist de release

**Critério de aceite:** checklist da Seção 10 do SDD 100% verificado; pipeline completo
(`analyze` → `plan` → `backlog` → revisão manual → `publish --dry-run` → `publish`) executado
com sucesso contra um SDD real.

---

## Verificação end-to-end (após Sprint 5)

1. `sdd-bot analyze --file issueMaker.md --out ./out/requirements.json`
2. `sdd-bot plan --in ./out/requirements.json --sprint-length "2 semanas" --out ./out/sprint-plan.json`
3. `sdd-bot backlog --in ./out/requirements.json --plan ./out/sprint-plan.json --out ./out`
4. Revisar manualmente `./out/backlog-frontend.md` e `./out/backlog-backend.md`
5. `sdd-bot publish --backlog ./out/backlog-backend.md --repo <org/repo> --dry-run` (validar saída)
6. `sdd-bot publish --backlog ./out/backlog-backend.md --repo <org/repo>` (repo de teste real)
