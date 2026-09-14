import { BacklogItemDraftSchema, BacklogItemSchema } from '../src/schemas/backlog-item.js';
import { RequirementSchema } from '../src/schemas/requirement.js';
import { SprintPlanSchema } from '../src/schemas/sprint-plan.js';

describe('RequirementSchema', () => {
  it('aceita um requisito válido com esforço', () => {
    const result = RequirementSchema.safeParse({
      id: 'REQ-001',
      title: 'Login de usuário',
      description: 'Permitir login com e-mail e senha',
      layer: 'backend',
      priority: 'must',
      effort: 'l',
      dependencies: [],
      sourceSection: 'Seção 4.1',
    });
    expect(result.success).toBe(true);
    expect(result.data?.effort).toBe('l');
  });

  it('assume esforço "m" em requirements.json antigos sem o campo', () => {
    const result = RequirementSchema.parse({
      id: 'REQ-001',
      title: 'Login de usuário',
      description: 'Permitir login com e-mail e senha',
      layer: 'backend',
      priority: 'must',
      dependencies: [],
      sourceSection: 'Seção 4.1',
    });
    expect(result.effort).toBe('m');
  });

  it('rejeita esforço fora da escala', () => {
    const result = RequirementSchema.safeParse({
      id: 'REQ-001',
      title: 'Login',
      description: 'x',
      layer: 'backend',
      priority: 'must',
      effort: 'xxl',
      dependencies: [],
      sourceSection: 'S',
    });
    expect(result.success).toBe(false);
  });
});

describe('SprintPlanSchema', () => {
  it('aceita um plano de sprints válido, com datas e avisos opcionais', () => {
    const result = SprintPlanSchema.safeParse({
      sprints: [{ number: 1, goal: 'Fundação', requirementIds: ['REQ-001'], startDate: '2026-09-14', dueDate: '2026-09-27' }],
      warnings: ['Sprint 1: subutilizada'],
    });
    expect(result.success).toBe(true);
    expect(SprintPlanSchema.safeParse({ sprints: [{ number: 1, goal: 'F', requirementIds: [] }] }).success).toBe(true);
  });

  it('rejeita datas fora do formato YYYY-MM-DD', () => {
    const result = SprintPlanSchema.safeParse({
      sprints: [{ number: 1, goal: 'Fundação', requirementIds: [], dueDate: '27/09/2026' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('BacklogItemSchema', () => {
  const base = {
    id: 'BL-001',
    epic: 'Autenticação',
    title: 'Corrigir erro 500 no login com senha expirada',
    description: 'Descrição objetiva',
    expectedBehavior: 'Deve retornar 401 com mensagem clara',
    acceptanceCriteria: ['Retorna 401'],
    labels: ['bug'],
    sprint: 1,
    layer: 'backend' as const,
    requirementIds: ['REQ-001'],
    priority: 'must' as const,
  };

  it('exige reproSteps quando type === bug', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'bug' });
    expect(result.success).toBe(false);
  });

  it('aceita bug com reproSteps preenchido', () => {
    const result = BacklogItemSchema.safeParse({
      ...base,
      type: 'bug',
      reproSteps: ['Fazer login com senha expirada'],
    });
    expect(result.success).toBe(true);
  });

  it('não exige reproSteps para features', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'feature' });
    expect(result.success).toBe(true);
  });

  it('não aplica as regras de qualidade do prompt (backlogs revisados à mão continuam válidos)', () => {
    const result = BacklogItemSchema.safeParse({
      ...base,
      type: 'feature',
      description: 'Deve funcionar corretamente',
      acceptanceCriteria: ['Funciona com sucesso'],
    });
    expect(result.success).toBe(true);
  });

  it('dependsOn assume lista vazia em backlogs antigos', () => {
    const result = BacklogItemSchema.parse({ ...base, type: 'feature' });
    expect(result.dependsOn).toEqual([]);
  });

  it('aceita technicalSpecificity opcional', () => {
    const result = BacklogItemSchema.safeParse({
      ...base,
      type: 'feature',
      technicalSpecificity: { httpCodes: ['401'], fields: [], limits: null, needsClarification: false, clarificationNote: null },
    });
    expect(result.success).toBe(true);
  });

  it('rejeita título genérico/curto demais', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'feature', title: 'Erro' });
    expect(result.success).toBe(false);
  });

  it('rejeita description vaga/curta demais', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'feature', description: 'Ruim' });
    expect(result.success).toBe(false);
  });

  it('rejeita acceptanceCriteria vazio', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'feature', acceptanceCriteria: [] });
    expect(result.success).toBe(false);
  });

  it('exige priority', () => {
    const { priority: _priority, ...withoutPriority } = base;
    const result = BacklogItemSchema.safeParse({ ...withoutPriority, type: 'feature' });
    expect(result.success).toBe(false);
  });

  it('rejeita priority fora do enum', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'feature', priority: 'urgent' });
    expect(result.success).toBe(false);
  });

  it('limita o tamanho de description, expectedBehavior e cada critério', () => {
    expect(BacklogItemSchema.safeParse({ ...base, type: 'feature', description: 'x'.repeat(901) }).success).toBe(false);
    expect(BacklogItemSchema.safeParse({ ...base, type: 'feature', expectedBehavior: 'x'.repeat(501) }).success).toBe(false);
    expect(
      BacklogItemSchema.safeParse({ ...base, type: 'feature', acceptanceCriteria: ['x'.repeat(301)] }).success,
    ).toBe(false);
  });

  it('limita acceptanceCriteria a 8 itens', () => {
    const result = BacklogItemSchema.safeParse({
      ...base,
      type: 'feature',
      acceptanceCriteria: Array.from({ length: 9 }, (_, i) => `Critério ${i}`),
    });
    expect(result.success).toBe(false);
  });
});

describe('BacklogItemDraftSchema — regras de qualidade do prompt', () => {
  const valid = {
    title: 'Validar formato de e-mail no cadastro de usuário',
    type: 'feature',
    description: 'Adicionar validação de formato no campo email do endpoint POST /users, usando regex RFC 5322.',
    expectedBehavior: 'Requisições com email fora do padrão recebem HTTP 422 e a mensagem "email inválido".',
    acceptanceCriteria: [
      'Quando o email é válido, então o usuário é criado e a resposta é HTTP 201',
      'Quando o email não tem "@", então a resposta é HTTP 422 com a mensagem "email inválido"',
    ],
    technicalSpecificity: { httpCodes: ['201', '422'], fields: ['email'], limits: null, needsClarification: false, clarificationNote: null },
  };

  function messagesOf(input: unknown): string[] {
    const result = BacklogItemDraftSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  }

  it('aceita um rascunho que segue todas as regras', () => {
    expect(messagesOf(valid)).toEqual([]);
  });

  it('exige technicalSpecificity no rascunho', () => {
    const { technicalSpecificity: _spec, ...without } = valid;
    expect(BacklogItemDraftSchema.safeParse(without).success).toBe(false);
  });

  it('Regra 4: rejeita termos vagos em description, expectedBehavior e critérios', () => {
    expect(messagesOf({ ...valid, description: 'O cadastro deve funcionar corretamente para todos os usuários' })).toEqual([
      expect.stringMatching(/^description: .*"funcionar corretamente"/),
    ]);
    expect(messagesOf({ ...valid, expectedBehavior: 'O usuário é cadastrado com sucesso no sistema' })).toEqual([
      expect.stringMatching(/^expectedBehavior: .*"com sucesso"/),
    ]);
    expect(messagesOf({ ...valid, acceptanceCriteria: [valid.acceptanceCriteria[0], 'O sistema responde de forma adequada'] })).toEqual([
      expect.stringMatching(/^acceptanceCriteria\.1: .*"de forma adequada"/),
    ]);
  });

  it('Regra 1: rejeita description igual (ou quase igual) ao expectedBehavior', () => {
    expect(messagesOf({ ...valid, expectedBehavior: valid.description })).toEqual([expect.stringMatching(/^expectedBehavior: .*mesma coisa/)]);
    expect(messagesOf({ ...valid, expectedBehavior: `${valid.description} Também.` })).toEqual([
      expect.stringMatching(/^expectedBehavior: .*mesma coisa/),
    ]);
  });

  it('Regras 2/3: exige caso negativo, salvo justificativa explícita', () => {
    expect(messagesOf({ ...valid, acceptanceCriteria: [valid.acceptanceCriteria[0]] })).toEqual([
      expect.stringMatching(/^acceptanceCriteria: .*caso negativo/),
    ]);
    expect(
      messagesOf({
        ...valid,
        acceptanceCriteria: ['Nenhum caso negativo aplicável — justificativa: leitura de constante sem entrada do usuário'],
      }),
    ).toEqual([]);
  });

  it('Regra 2: rejeita critérios repetidos, mas aceita o par positivo/negativo espelhado', () => {
    const first = valid.acceptanceCriteria[0]!;
    expect(messagesOf({ ...valid, acceptanceCriteria: [first, first.toUpperCase()] })).toEqual([
      expect.stringMatching(/^acceptanceCriteria\.1: .*repete o critério 1/),
    ]);
    const mirrored = [
      'Quando o email é válido, então a resposta é HTTP 201',
      'Quando o email é inválido, então a resposta é HTTP 422',
    ];
    expect(messagesOf({ ...valid, acceptanceCriteria: mirrored })).toEqual([]);
  });

  it('Regra 5: título com mais de 70 caracteres', () => {
    const title = 'Implementar validação completa do formato de e-mail no formulário de cadastro de usuário final';
    expect(messagesOf({ ...valid, title })).toEqual([expect.stringMatching(/^title: .*máximo 70/)]);
  });

  it('Regra 5: título sem verbo no infinitivo', () => {
    expect(messagesOf({ ...valid, title: 'Problema no cadastro de usuário' })).toEqual([expect.stringMatching(/^title: .*infinitivo/)]);
  });

  it('Regra 5: título com prefixo de tipo', () => {
    expect(messagesOf({ ...valid, title: 'Bug: validar formato de e-mail no cadastro' })).toEqual([
      expect.stringMatching(/^title: .*label já classifica/),
    ]);
  });

  it('Regra 5: título genérico com menos de 4 palavras', () => {
    expect(messagesOf({ ...valid, title: 'Autenticar usuário' })).toEqual([
      expect.stringMatching(/^title: .*pelo menos 4 palavras/),
    ]);
  });

  it('needsClarification exige a nota com a decisão pendente', () => {
    const spec = { ...valid.technicalSpecificity, needsClarification: true, clarificationNote: '  ' };
    expect(messagesOf({ ...valid, technicalSpecificity: spec })).toEqual([
      expect.stringMatching(/^technicalSpecificity\.clarificationNote: /),
    ]);
    expect(messagesOf({ ...valid, technicalSpecificity: { ...spec, clarificationNote: 'Definir TTL da sessão' } })).toEqual([]);
  });

  it('bug exige reproSteps', () => {
    expect(messagesOf({ ...valid, type: 'bug', title: 'Corrigir timeout no upload de arquivos acima de 10MB' })).toEqual([
      expect.stringMatching(/^reproSteps: /),
    ]);
  });
});
