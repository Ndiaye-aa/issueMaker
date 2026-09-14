# Documento de Design de Software (SDD)
## Projeto: SDD Bot — Automação de Backlog a partir de Documentos de Design

**Versão:** 1.0
**Data:** Setembro/2026
**Autor:** Adama

---

## 1. Introdução

### 1.1 Propósito
Este documento descreve o design técnico do **SDD Bot**, uma ferramenta de linha de comando (CLI) que automatiza a transição de um Documento de Design de Software (SDD) para um backlog de desenvolvimento estruturado, publicado como issues no GitHub, organizado em sprints e separado por camada (frontend/backend).

### 1.2 Escopo
O sistema recebe um arquivo SDD (Markdown, Word ou PDF), extrai requisitos de forma estruturada, organiza esses requisitos em um plano de sprints respeitando dependências técnicas, gera itens de backlog seguindo boas práticas de issue tracking, e — após revisão humana — publica essas issues em um repositório GitHub à escolha do usuário.

**Fora do escopo:**
- Edição, criação ou exclusão de arquivos de código nos repositórios de destino
- Anexação automática de prints, GIFs ou logs às issues
- Estimativa de esforço em story points (pode ser adicionado como extensão futura)
- Interface gráfica (o produto é exclusivamente CLI nesta versão)

### 1.3 Definições e Siglas
| Termo | Significado |
|---|---|
| SDD | Software Design Document — documento de entrada do sistema |
| Requirement | Unidade atômica de requisito extraída do SDD |
| Backlog Item | Item de trabalho pronto para virar issue no GitHub |
| Epic | Agrupador temático de múltiplos backlog items |
| Layer | Camada de destino do requisito/item: `frontend`, `backend` ou `shared` |

---

## 2. Visão Geral da Arquitetura

### 2.1 Diagrama de Fluxo

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐     ┌──────────────────┐
│  SDD Input  │ --> │   Ingest &   │ --> │   Extração de      │ --> │  requirements     │
│ (.md/.docx/ │     │  Normalize   │     │  Requisitos (IA)   │     │     .json          │
│    .pdf)    │     └──────────────┘     └───────────────────┘     └────────┬─────────┘
└─────────────┘                                                             │
                                                                             ▼
┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────────────────┐
│  sprint-plan      │ <-- │  Planejamento de     │ <-- │  requirements.json            │
│    .json          │     │  Sprints (IA)        │     │  (grafo de dependências)       │
└────────┬──────────┘     └─────────────────────┘     └──────────────────────────────┘
         │
         ▼
┌──────────────────────────────┐     ┌─────────────────────────────────┐
│  Geração de Backlog (IA)      │ --> │ backlog-frontend.md              │
│  (separado por layer)         │     │ backlog-backend.md               │
└──────────────────────────────┘     └────────────────┬──────────────────┘
                                                        │
                                              ┌─────────▼─────────┐
                                              │  REVISÃO HUMANA    │
                                              │  (edição manual     │
                                              │   dos arquivos .md) │
                                              └─────────┬─────────┘
                                                        │
                                              ┌─────────▼─────────┐
                                              │  Publicação        │
                                              │  (Octokit/GitHub)  │
                                              └────────────────────┘
```

### 2.2 Princípios de Design
1. **Determinismo onde possível:** qualquer etapa que não exija raciocínio semântico (parsing de Markdown, renderização, chamadas à API do GitHub) é implementada sem IA, garantindo previsibilidade e testabilidade.
2. **IA isolada e substituível:** toda interação com modelos de linguagem passa por uma interface única (`AIProvider`), permitindo trocar de provedor sem alterar a lógica de negócio.
3. **Validação estrita:** toda saída de IA é validada contra um schema Zod antes de prosseguir no pipeline. Falha de validação aciona retry automático com o erro anexado ao prompt.
4. **Checkpoint humano obrigatório:** nenhuma issue é publicada sem uma etapa de revisão manual dos arquivos de backlog gerados.
5. **Resiliência de custo zero:** o motor de IA pode operar inteiramente em camadas gratuitas (Groq) com fallback local (Ollama), sem dependência de billing. O provedor principal e o fallback são configuráveis (`AI_PRIMARY`/`AI_FALLBACK`): Claude pela própria máquina via Agent SDK (`claude-code`, default), API compatível com OpenAI, Groq ou Ollama; o fallback é opcional.

---

## 3. Motor de IA

### 3.1 Estratégia de Provedores
| Papel | Provedor | Modelo sugerido | Justificativa |
|---|---|---|---|
| Principal | Groq | `llama-3.3-70b-versatile` | Cota gratuita generosa (até 14.400 req/dia dependendo do modelo), sem cláusula de uso dos dados para treinamento, alta velocidade |
| Fallback | Ollama (local) | `OLLAMA_MODEL` (default `qwen2.5:3b-instruct`) | Sem limite de cota, 100% local — assume o restante do pipeline quando o Groq retorna rate-limit / cota esgotada (HTTP 429). Usa a API nativa `/api/chat` com structured output (JSON schema derivado do Zod) e `num_ctx` calculado pelo tamanho do prompt |

### 3.2 Interface Abstrata

```typescript
interface AIProvider {
  complete<T>(prompt: CompletionRequest, schema: ZodSchema<T>): Promise<T>;
}

interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}
```

### 3.3 Cliente Resiliente

```typescript
class ResilientAIClient {
  constructor(
    private primary: AIProvider,
    private fallback: AIProvider,
    private maxRetries = 3
  ) {}

  async complete<T>(request: CompletionRequest, schema: ZodSchema<T>): Promise<T> {
    try {
      return await this.withSchemaRetry(this.primary, request, schema);
    } catch (err) {
      if (isRateLimitError(err)) {
        return await this.withSchemaRetry(this.fallback, request, schema);
      }
      throw err;
    }
  }

  private async withSchemaRetry<T>(
    provider: AIProvider,
    request: CompletionRequest,
    schema: ZodSchema<T>
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const raw = await provider.complete(request, schema);
        return schema.parse(raw);
      } catch (err) {
        lastError = err;
        request = appendSchemaErrorToPrompt(request, err);
        await backoff(attempt);
      }
    }
    throw lastError;
  }
}
```

### 3.4 Tratamento de Erros
- **HTTP 429 (rate limit):** backoff exponencial respeitando o `retry-after`, insistindo no provedor atual até acumular 120 s de espera (throttle por minuto devolve 429 repetidos com retry-after curto). Um `retry-after` que estoure esse orçamento indica cota diária esgotada e aciona o fallback na hora.
- **Cota esgotada:** uma vez acionado o fallback, todas as chamadas restantes daquela execução vão direto ao Ollama (sem tentar o Groq de novo), com um único aviso no stderr informando o modelo em uso.
- **JSON inválido / falha de schema Zod:** retry no mesmo provedor, anexando a mensagem de erro de validação ao prompt seguinte ("sua resposta anterior falhou nesta validação: `{erro}`. Corrija.").
- **Falha total (ambos os provedores):** o pipeline interrompe a execução do comando atual e reporta claramente qual etapa falhou, sem corromper arquivos de saída já gerados em etapas anteriores.

---

## 4. Modelos de Dados (Schemas)

### 4.1 Requirement
```typescript
interface Requirement {
  id: string;                          // "REQ-001"
  title: string;
  description: string;
  layer: 'frontend' | 'backend' | 'shared';
  priority: 'must' | 'should' | 'could';
  dependencies: string[];              // ids de outros Requirements
  sourceSection: string;               // rastreabilidade até o SDD original
}
```

### 4.2 SprintPlan
```typescript
interface SprintPlan {
  sprints: {
    number: number;
    goal: string;
    requirementIds: string[];
  }[];
}
```

### 4.3 BacklogItem
```typescript
interface BacklogItem {
  id: string;
  epic: string;                        // = Requirement.sourceSection (vira a label area:)
  type: 'feature' | 'bug' | 'tech-debt';
  title: string;                       // verbo no infinitivo + objeto + contexto, ≤ 70 chars
  description: string;                 // mecanismo (o que implementar / o que está quebrado)
  expectedBehavior: string;            // resultado observável, distinto da descrição
  reproSteps?: string[];               // obrigatório apenas quando type === 'bug'
  environment?: string;                // preenchido apenas se o SDD especificar
  acceptanceCriteria: string[];        // ≥ 1 caminho de sucesso + casos negativos
  technicalSpecificity?: {             // números e nomes reais, não adjetivos
    httpCodes: string[];
    fields: string[];
    limits: string | null;
    needsClarification: boolean;       // true ⇒ label status: needs-clarification
    clarificationNote: string | null;
  };
  labels: string[];                    // legado; não publicado (labels vêm de dado estruturado)
  sprint: number;
  layer: 'frontend' | 'backend';
  requirementIds: string[];            // rastreabilidade (1 requisito por item)
  dependsOn: string[];                 // ids de requisito (REQ-x) de que depende; vira "Depende de: #N"
}
```

`Requirement` ganhou `effort: 'xs' | 's' | 'm' | 'l' | 'xl'` (1/2/3/5/8 pontos) e `Sprint`
ganhou `startDate?`/`dueDate?` (`YYYY-MM-DD`); `SprintPlan` ganhou `warnings?: string[]`.

Todos os schemas são implementados em Zod, servindo simultaneamente como validação em runtime e como fonte de tipos TypeScript (`z.infer<typeof Schema>`).

---

## 5. Componentes do Sistema

### 5.1 Ingest & Normalize
**Responsabilidade:** converter qualquer formato de entrada suportado em texto normalizado e dividido em chunks processáveis.

| Formato | Biblioteca | Observação |
|---|---|---|
| `.md` | Leitura direta (`fs`) | Sem transformação necessária |
| `.docx` | `mammoth` | Extrai texto preservando estrutura de headings |
| `.pdf` | `pdf-parse` | Extração de texto; não trata PDFs escaneados (fora do escopo) |

**Chunking:** divisão por seção (detectada via headings), com fallback para divisão por tamanho de tokens quando uma seção excede o limite de contexto do provedor de IA ativo.

### 5.2 Extração de Requisitos
**Responsabilidade:** para cada chunk, invocar o `ResilientAIClient` com o prompt de extração e consolidar os resultados.

**Pós-processamento determinístico:**
- Merge dos arrays JSON de todos os chunks
- Deduplicação: comparação de similaridade textual entre títulos; pares acima do threshold são confirmados via uma chamada adicional de IA ("esses dois requisitos são a mesma coisa?")
- Persistência em `requirements.json`

### 5.3 Planejamento de Sprints
**Responsabilidade:** organizar os requisitos extraídos em sprints por esforço ponderado, respeitando o grafo de dependências.

**Método:** esforço por requisito (estimado na extração) → capacidade efetiva por sprint (`--capacity × --buffer`) → nº mínimo de sprints = esforço total ÷ capacidade → distribuição respeitando dependências e prioridade.

**Validação determinística pós-IA:**
1. Grafo de dependências: nenhum requisito antes daquilo de que depende (reordenação automática).
2. Transbordo por capacidade (pontos) e por teto de itens: saem primeiro `could`, depois `should`, levando dependentes.
3. Pull-forward: `must` (depois `should`) de sprints posteriores sobem enquanto houver capacidade e as dependências permitirem.
4. Sprints vazias removidas e renumeradas; goals de sprints cuja composição mudou são reescritos por uma chamada extra (refine anti-genérico).
5. Datas sequenciais (`--start-date` + duração) e auditoria (`warnings`): goal genérico, desbalanceamento (> 130% da média ou > 50% entre extremos), sobrecarga/subutilização, `could` antes de `must` sem dependência, dependência violada.

### 5.4 Geração de Backlog
**Responsabilidade:** transformar cada requisito em um item de backlog (uma chamada de IA por requisito, por camada; ids `BL-nnn` renumerados por camada ao final). `sprint`, `layer`, `epic` (= seção do SDD) e `requirementIds` são preenchidos localmente; `priority` é calculada do requisito de origem. As cinco regras do prompt (Apêndice A.3) são validadas deterministicamente sobre a resposta e devolvidas ao modelo em caso de violação. Títulos repetidos na mesma camada geram aviso.

**Renderização:** conversão determinística do JSON de backlog para Markdown, seguindo o template canônico de issue (ver Seção 6).

### 5.5 Publicação
**Responsabilidade:** ler os arquivos `.md` de backlog (já revisados manualmente) e criar issues no repositório GitHub escolhido.

**Fluxo:**
1. Parse determinístico dos Markdowns (várias camadas na mesma execução) → `BacklogItem[]` (+ `sprint-plan.json` opcional para os milestones)
2. Ordenação topológica por `dependsOn` (ciclo = erro antes de qualquer escrita)
3. Se `mode === 'replace'`: fechar issues existentes com a label `sdd-bot`; se `add`: carregar `REQ-x → #N` das issues abertas (resolve dependências de execuções/camadas anteriores)
4. Garantir existência das labels e alinhar cores (`ensureLabelsExist`)
5. Garantir milestones `Sprint N` (reaproveita/reabre existentes; descrição = objetivo; due date do plano)
6. Criar uma issue por `BacklogItem` em passada única: o corpo cita `**Depende de:** #N` com os números já criados; labels por dimensão: `sdd-bot`, `type: …`, `layer: …`, `priority: …`, `area: …` e, se houver decisão pendente, `status: needs-clarification`
7. Fechar milestones `Sprint N` cujas issues estão todas fechadas
8. Modo `--dry-run` disponível em toda execução, exibindo o resultado (e a ordem de criação) sem chamar a API de escrita

**Critérios de label:** ortogonalidade (uma dimensão por label), baixa cardinalidade, nomenclatura `dimensão: valor`, derivadas de enum/dado calculado (nunca de texto livre), mutuamente exclusivas dentro da dimensão, cor por família. **Critérios de milestone:** um único critério de agrupamento (tempo), nome padronizado `Sprint N`, due date calculada, descrição = objetivo, sem sobreposição, fechado quando 100% das issues fecham.

---

## 6. Template de Issue

```markdown
### [Sprint {N}] {Título específico e descritivo}
**Tipo:** {feature|bug|tech-debt}
**Prioridade:** {must|should|could}
**Depende de:** #3, #7                <!-- apenas se dependsOn não vazio; REQ-x no backlog.md -->

**Descrição:**
{Descrição objetiva do comportamento atual ou funcionalidade necessária}

**Passos para reproduzir:**          <!-- apenas se type === bug -->
1. {passo 1}
2. {passo 2}

**Comportamento esperado:**
{O que deveria acontecer}

**Ambiente:** {SO/navegador/versão}   <!-- apenas se especificado no SDD -->

**Critérios de aceite:**
- [ ] {critério de caminho de sucesso}
- [ ] {critério de caso negativo}

**Especificidade técnica:**
- Códigos HTTP: {200, 422}            <!-- linha omitida se vazio -->
- Campos: `{campo1}`, `{campo2}`      <!-- idem -->
- Limites: {limite}                   <!-- omitida se null -->
- Precisa de esclarecimento: {sim — decisão pendente | não}

**Rastreabilidade:** {REQ-001} (ver requirements.json)

---
```

Regras de qualidade aplicadas na geração (via prompt, Seção 7.3):
- Título nunca genérico
- Escopo único por item (um problema ou uma funcionalidade por issue)
- `reproSteps` presente apenas para bugs
- Sem placeholders de prints/logs/GIFs (decisão de produto — fora do escopo do bot)

---

## 7. Prompts de IA

### 7.1 Extração de Requisitos
Ver Apêndice A.1. Retorna array JSON de `Requirement`, um chunk por chamada.

### 7.2 Planejamento de Sprints
Ver Apêndice A.2. Retorna `SprintPlan` completo em uma única chamada, recebendo todos os requisitos de uma vez.

### 7.3 Geração de Backlog
Ver Apêndice A.3. Uma chamada por camada (frontend/backend), recebendo os requisitos filtrados por `layer` e o plano de sprints.

---

## 8. Interface de Linha de Comando (CLI)

| Comando | Descrição |
|---|---|
| `sdd-bot process --file <sdd> --sprint-length <duração> [--out <dir>]` | Pipeline completo (analyze + plan + backlog) → `backlog-frontend.md` + `backlog-backend.md` |
| `sdd-bot publish --backlog <path> --repo <org/repo> [--mode add\|replace] [--dry-run]` | Publicação de issues (`--mode replace` é o padrão) |
| `sdd-bot analyze --file <path> [--out <path>]` | (granular) Ingest + extração → `requirements.json` |
| `sdd-bot plan --in <requirements.json> --sprint-length <duração> [--out <path>]` | (granular) Planejamento → `sprint-plan.json` |
| `sdd-bot backlog --in <requirements.json> --plan <sprint-plan.json> [--out <dir>]` | (granular) Geração → `backlog-frontend.md` + `backlog-backend.md` |

Todo `--out` é opcional e, se omitido, aponta para `./out` (criado automaticamente).

Implementado com `commander`, cada comando isolado em seu próprio módulo dentro de `src/cli/`.
`process` compõe, no mesmo módulo, as chamadas às funções já usadas por `analyze`/`plan`/
`backlog` (nenhuma etapa é pulada ou duplicada), mas sem persistir os artefatos intermediários
`requirements.json`/`sprint-plan.json` em disco. Os comandos granulares continuam disponíveis
para quem quiser inspecionar ou editar esses artefatos manualmente entre etapas.

---

## 9. Estrutura do Projeto

```
sdd-bot/
├── src/
│   ├── ingest/
│   │   ├── parsers.ts
│   │   └── chunker.ts
│   ├── ai/
│   │   ├── providers/
│   │   │   ├── groq.ts
│   │   │   └── ollama.ts
│   │   ├── client.ts
│   │   └── prompts/
│   │       ├── extract.ts
│   │       ├── plan.ts
│   │       └── backlog.ts
│   ├── schemas/
│   │   ├── requirement.ts
│   │   ├── sprint-plan.ts
│   │   └── backlog-item.ts
│   ├── render/
│   │   └── backlog-markdown.ts
│   ├── publish/
│   │   ├── parse-backlog.ts
│   │   └── github.ts
│   └── cli.ts
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 10. Requisitos Não-Funcionais

| Requisito | Descrição |
|---|---|
| Custo | Operação inteiramente gratuita (Groq free tier + Ollama local); sem dependência de billing |
| Rastreabilidade | Toda issue publicada referencia, indiretamente via `requirements.json`, a seção original do SDD que a originou |
| Idempotência | Reexecuções em modo `add` não duplicam issues já publicadas com o mesmo conteúdo; modo `replace` cuida de limpeza explícita |
| Validação | Nenhum dado gerado por IA chega à etapa de publicação sem passar por validação de schema Zod |
| Segurança | Nenhuma credencial (GROQ_API_KEY, GITHUB_TOKEN) é logada ou persistida fora de variáveis de ambiente |
| Restrição de escrita | O sistema nunca cria, edita ou exclui arquivos de código nos repositórios de destino — apenas issues |

---

## 11. Stack Tecnológica

- **Linguagem:** TypeScript / Node.js
- **CLI:** `commander`
- **Validação:** `zod`
- **Parsing de documentos:** `mammoth` (docx), `pdf-parse` (pdf)
- **IA:** SDK `openai` (compatível com Groq e Ollama via base URL customizada)
- **GitHub:** `octokit`
- **Testes:** `jest`
- **Lint/Format:** `eslint` + `prettier`

---

## 12. Riscos e Mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| Rate-limit do Groq em SDDs muito grandes (muitos chunks) | Pipeline interrompido | Fallback automático para Ollama local |
| Qualidade inconsistente de extração em SDDs mal estruturados | Requisitos incompletos ou mal classificados | Checkpoint de revisão humana antes da publicação; rastreabilidade via `sourceSection` facilita auditoria |
| Alucinação de dependências inexistentes entre requisitos | Sprints mal ordenados | Validação determinística do grafo de dependências após a etapa de IA |
| Duplicação de issues em reexecuções | Backlog poluído | Label `sdd-bot` + modo `replace` explícito |

---

## 13. Plano de Implementação

O plano de implementação (sprints de desenvolvimento do próprio bot) está detalhado em documento separado (`sdd-bot-plano-implementacao.md`), cobrindo Sprint 0 (fundação) até Sprint 6 (hardening e documentação).

---

## Apêndice A — Prompts Completos

### A.1 Extração de Requisitos
```
[SYSTEM]
Você é um analista de requisitos de software sênior. Sua tarefa é ler trechos de um
Documento de Design de Software (SDD) e extrair requisitos de forma estruturada.

REGRAS:
- Responda SOMENTE com um array JSON válido. Nenhum texto antes ou depois.
- Cada requisito deve ser atômico (uma responsabilidade só).
- Classifique "layer" como "frontend", "backend" ou "shared" com base no contexto.
- Se um requisito depende de outro para fazer sentido tecnicamente, liste o id dele em "dependencies".
- "sourceSection" deve citar o título da seção de onde a informação veio.
- Se a seção não tiver requisitos extraíveis, retorne [].

[USER]
Seção do SDD: "{{ nome_da_secao }}"
Conteúdo: """{{ chunk_de_texto }}"""
IDs já usados até agora: {{ lista_de_ids_existentes }}
```

### A.2 Planejamento de Sprints
```
[SYSTEM]
Você é um gerente técnico de projeto experiente. Organize os requisitos recebidos em
sprints, respeitando dependências, priorizando must > should > could, com objetivo
coerente por sprint e esforço equilibrado entre sprints.
O QUE É UMA BOA SPRINT: objetivo único e demonstrável (goals genéricos proibidos), carga
balanceada dentro da capacidade em pontos, dependências respeitadas, must o mais cedo
possível, tamanho adequado ao período, sem sprint vazia. Pontos: xs=1, s=2, m=3, l=5, xl=8.

[USER]
Duração do sprint: {{ sprint_length }}
Capacidade efetiva: {{ pontos }} pontos por sprint. Esforço total: {{ total }} pontos em
{{ n }} requisitos (portanto no mínimo {{ ceil(total / pontos) }} sprints).
Teto de itens: {{ max_per_sprint }} requisitos por sprint.
Requisitos (JSON): {{ id, title, layer, priority, effort, dependencies }}
```

Quando a distribuição determinística muda a composição de uma sprint, um segundo prompt
(`src/ai/prompts/sprint-goals.ts`) reescreve só os goals dessas sprints.

### A.3 Geração de Backlog
O prompt completo (com as cinco regras) está em `src/ai/prompts/backlog.ts` (`BACKLOG_SYSTEM_PROMPT`).
Uma chamada por requisito:

```
[SYSTEM]
Você é um engenheiro de software sênior especializado em escrever issues técnicas
de altíssima qualidade. Sua única tarefa é transformar um requisito em uma issue
completa, seguindo rigorosamente as regras abaixo.

REGRA 1 — DESCRIÇÃO (o mecanismo, não o resultado)
REGRA 2 — CRITÉRIOS DE ACEITE (testáveis, não redundantes)
REGRA 3 — CASOS NEGATIVOS (obrigatórios, não opcionais)
REGRA 4 — ESPECIFICIDADE TÉCNICA (números e nomes reais, não adjetivos)
REGRA 5 — TÍTULO (verbo no infinitivo + objeto + contexto, ≤ 70 caracteres,
          sem prefixo de tipo, sintoma observável para bugs, teste anti-genérico)

FORMATO DE SAÍDA — responda SOMENTE com este JSON:
{ "title", "type", "description", "expectedBehavior", "acceptanceCriteria": [...],
  "technicalSpecificity": { "httpCodes", "fields", "limits", "needsClarification",
  "clarificationNote" }, "reproSteps": [apenas se bug], "environment": [se especificado] }

[USER]
Requisito original: """{{ título }}. {{ descrição }}"""
Contexto adicional (se houver): """Sprint {{ n }} — objetivo: {{ goal }}. Camada: {{ layer }}.
Prioridade (MoSCoW): {{ priority }}. Esforço estimado: {{ effort }}. Seção do SDD de origem:
{{ sourceSection }}. Dependências: {{ ids }}."""
```

Os campos `id`, `epic`, `labels`, `sprint`, `layer` e `requirementIds` não são pedidos ao
modelo: vêm de dado estruturado.
