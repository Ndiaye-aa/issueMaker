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
5. **Resiliência de custo zero:** o motor de IA opera inteiramente em camadas gratuitas (Groq) com fallback local (Ollama), sem dependência de billing.

---

## 3. Motor de IA

### 3.1 Estratégia de Provedores
| Papel | Provedor | Modelo sugerido | Justificativa |
|---|---|---|---|
| Principal | Groq | `llama-3.3-70b-versatile` | Cota gratuita generosa (até 14.400 req/dia dependendo do modelo), sem cláusula de uso dos dados para treinamento, alta velocidade |
| Fallback | Ollama (local) | `qwen2.5:14b-instruct` | Sem limite de cota, 100% local — usado quando o Groq retorna rate-limit (HTTP 429) ou por preferência de privacidade |

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
- **HTTP 429 (rate limit):** backoff exponencial (2 tentativas no provedor atual) antes de acionar o fallback definitivamente.
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
  epic: string;
  type: 'feature' | 'bug' | 'tech-debt';
  title: string;                       // específico e descritivo, nunca genérico
  description: string;
  expectedBehavior: string;            // obrigatório em todo item
  reproSteps?: string[];               // obrigatório apenas quando type === 'bug'
  environment?: string;                // preenchido apenas se o SDD especificar
  acceptanceCriteria: string[];
  labels: string[];
  sprint: number;
  layer: 'frontend' | 'backend';
}
```

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
**Responsabilidade:** organizar os requisitos extraídos em sprints, respeitando o grafo de dependências.

**Validação determinística pós-IA:** um passo de verificação de grafo confirma que nenhum requisito foi alocado em um sprint anterior ao de qualquer requisito do qual dependa. Caso a IA viole essa regra, o sistema reordena automaticamente antes de persistir o `sprint-plan.json`.

### 5.4 Geração de Backlog
**Responsabilidade:** transformar requisitos + plano de sprints em itens de backlog, separados por camada (chamadas independentes para frontend e backend).

**Renderização:** conversão determinística do JSON de backlog para Markdown, seguindo o template canônico de issue (ver Seção 6).

### 5.5 Publicação
**Responsabilidade:** ler os arquivos `.md` de backlog (já revisados manualmente) e criar issues no repositório GitHub escolhido.

**Fluxo:**
1. Parse determinístico do Markdown → `BacklogItem[]`
2. Garantir existência das labels necessárias (`ensureLabelsExist`)
3. Se `mode === 'replace'`: fechar issues existentes com a label `sdd-bot`
4. Criar uma issue por `BacklogItem`, com labels `sdd-bot` + `sprint-N` + labels específicas do item
5. Modo `--dry-run` disponível em toda execução, exibindo o resultado sem chamar a API de escrita

---

## 6. Template de Issue

```markdown
### [Sprint {N}] {Título específico e descritivo}
**Tipo:** {feature|bug|tech-debt}
**Labels:** `label1`, `label2`

**Descrição:**
{Descrição objetiva do comportamento atual ou funcionalidade necessária}

**Passos para reproduzir:**          <!-- apenas se type === bug -->
1. {passo 1}
2. {passo 2}

**Comportamento esperado:**
{O que deveria acontecer}

**Ambiente:** {SO/navegador/versão}   <!-- apenas se especificado no SDD -->

**Critérios de aceite:**
- [ ] {critério 1}
- [ ] {critério 2}

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
| `sdd-bot analyze --file <path> --out <path>` | Ingest + extração → `requirements.json` |
| `sdd-bot plan --in <requirements.json> --sprint-length <duração> --out <path>` | Planejamento → `sprint-plan.json` |
| `sdd-bot backlog --in <requirements.json> --plan <sprint-plan.json> --out <dir>` | Geração → `backlog-frontend.md` + `backlog-backend.md` |
| `sdd-bot publish --backlog <path> --repo <org/repo> [--mode add\|replace] [--dry-run]` | Publicação de issues |

Implementado com `commander`, cada comando isolado em seu próprio módulo dentro de `src/cli/`.

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

[USER]
Requisitos (JSON): {{ requirements.json }}
Duração do sprint: {{ sprint_length }}
```

### A.3 Geração de Backlog
```
[SYSTEM]
Você é um Product Owner técnico. Transforme requisitos de {{ layer }} em itens de
backlog prontos para virar issues no GitHub, seguindo boas práticas:
- Título específico e descritivo, nunca genérico
- Escopo único por item
- "expectedBehavior" obrigatório
- "reproSteps" obrigatório apenas quando type === "bug"
- "environment" apenas se especificado no SDD original
- Sem referências a prints/logs/GIFs

[USER]
Requisitos de {{ layer }} (JSON): {{ requirements_filtrados }}
Plano de sprints (JSON): {{ sprint-plan.json }}
```
