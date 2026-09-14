import { jest } from '@jest/globals';
import { z } from 'zod';
import { OllamaProvider, hasRepetition, normalizeBaseURL } from '../src/ai/providers/ollama.js';
import type { HttpTransport } from '../src/ai/providers/ollama.js';
import { parseJsonResponse } from '../src/ai/provider.js';

const schema = z.array(z.object({ id: z.string(), title: z.string() }));
const request = { systemPrompt: 'system', userPrompt: 'user', temperature: 0.1 };

function ndjson(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function transportResponding(text: string, status = 200) {
  return jest.fn<HttpTransport>(async () => ({ status, text }));
}

function sentBody(transport: jest.Mock<HttpTransport>): Record<string, any> {
  return JSON.parse(transport.mock.calls[0]?.[1] ?? '{}');
}

describe('OllamaProvider', () => {
  it('chama /api/chat em streaming com JSON schema, num_ctx calculado e num_predict', async () => {
    const transport = transportResponding(
      ndjson([
        { message: { content: '[{"id":"REQ-1",' }, done: false },
        { message: { content: '"title":"Login"}]' }, done: true, done_reason: 'stop' },
      ]),
    );

    const provider = new OllamaProvider({ baseURL: 'http://ollama:11434/v1', model: 'm', transport });
    const result = await provider.complete(request, schema);

    expect(result).toEqual([{ id: 'REQ-1', title: 'Login' }]);
    expect(transport.mock.calls[0]?.[0]).toBe('http://ollama:11434/api/chat');
    const body = sentBody(transport);
    expect(body.model).toBe('m');
    expect(body.stream).toBe(true);
    expect(body.format).toMatchObject({ type: 'array', minItems: 1, items: { type: 'object' } });
    expect(body.format.$schema).toBeUndefined();
    expect(body.options).toEqual({ temperature: 0.1, num_ctx: 8004, num_predict: 8000 });
    expect(body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ]);
  });

  it('num_ctx cresce com o tamanho do prompt e respeita o teto', async () => {
    const transport = transportResponding(ndjson([{ message: { content: '[]' }, done: true }]));

    const provider = new OllamaProvider({ maxNumCtx: 8000, transport });
    await provider.complete({ ...request, userPrompt: 'x'.repeat(30_000) }, schema);

    expect(sentBody(transport).options.num_ctx).toBe(8000);
  });

  it('erra com dica de `ollama serve` quando a conexão é recusada', async () => {
    const transport = jest.fn<HttpTransport>(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });

    const provider = new OllamaProvider({ transport });
    await expect(provider.complete(request, schema)).rejects.toThrow(
      'Ollama não está rodando em http://localhost:11434 (inicie com `ollama serve`)',
    );
  });

  it('erra com dica de `ollama pull` quando o modelo não existe', async () => {
    const transport = transportResponding('{"error":"model \\"foo\\" not found"}', 404);

    const provider = new OllamaProvider({ model: 'foo', transport });
    await expect(provider.complete(request, schema)).rejects.toThrow(
      'modelo "foo" não encontrado no Ollama — rode `ollama pull foo`',
    );
  });

  it('erra quando a geração é cortada por limite de tokens', async () => {
    const transport = transportResponding(
      ndjson([{ message: { content: '[{"id":' }, done: true, done_reason: 'length' }]),
    );

    const provider = new OllamaProvider({ transport });
    await expect(provider.complete(request, schema)).rejects.toThrow(/limite de tokens/);
  });

  it('propaga erro reportado dentro do stream', async () => {
    const transport = transportResponding(ndjson([{ error: 'context length exceeded' }]));

    const provider = new OllamaProvider({ transport });
    await expect(provider.complete(request, schema)).rejects.toThrow(
      'Ollama: context length exceeded',
    );
  });

  it('propaga outros erros HTTP com status e corpo', async () => {
    const transport = transportResponding('boom', 500);

    const provider = new OllamaProvider({ transport });
    await expect(provider.complete(request, schema)).rejects.toThrow('Ollama HTTP 500: boom');
  });
});

describe('OllamaProvider repetition guard', () => {
  it('aborta a geração quando a saída em streaming começa a se repetir', async () => {
    const item = '{"id":"REQ-1","title":"' + 'x'.repeat(500) + '"},';
    const transport = jest.fn<HttpTransport>(async (_url, _body, onData) => {
      for (let i = 0; i < 6; i++) {
        onData?.(ndjson([{ message: { content: item }, done: false }]));
      }
      return { status: 200, text: '' };
    });

    const provider = new OllamaProvider({ transport });
    await expect(provider.complete(request, schema)).rejects.toThrow(/loop de repetição/);
  });

  it('não interfere numa saída normal entregue em vários pedaços', async () => {
    const transport = jest.fn<HttpTransport>(async (_url, _body, onData) => {
      const text = ndjson([
        { message: { content: '[{"id":"REQ-1","title":"A"},' }, done: false },
        { message: { content: '{"id":"REQ-2","title":"B"}]' }, done: true, done_reason: 'stop' },
      ]);
      onData?.(text.slice(0, 40));
      onData?.(text.slice(40));
      return { status: 200, text };
    });

    const provider = new OllamaProvider({ transport });
    await expect(provider.complete(request, schema)).resolves.toEqual([
      { id: 'REQ-1', title: 'A' },
      { id: 'REQ-2', title: 'B' },
    ]);
  });
});

describe('hasRepetition', () => {
  it('detecta quando a janela final já apareceu antes', () => {
    const block = 'abcdefghij'.repeat(50);
    expect(hasRepetition(block + block, 100)).toBe(true);
    expect(hasRepetition('a'.repeat(50), 100)).toBe(false);
    const varied = Array.from({ length: 400 }, (_, i) => `${String.fromCharCode(97 + (i % 26))}${(i * 7919).toString(36)};`).join('');
    expect(hasRepetition(varied, 100)).toBe(false);
  });

  it('detecta loop em que só o id muda entre os itens repetidos', () => {
    const item = (i: number) =>
      `{"id":"REQ-${i}","title":"Login com RGA","description":"O sistema deve autenticar o usuário com RGA e senha.","layer":"backend","priority":"must","dependencies":[],"sourceSection":"2.1"}`;
    const looping = '[' + Array.from({ length: 3 }, (_, i) => item(40 + i)).join(',\n') + ',{"id":"REQ-43"';
    expect(hasRepetition(looping)).toBe(true);
  });

  it('não confunde uma lista longa de ids (plano de sprints) com loop', () => {
    const ids = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `"REQ-${from + i}"`).join(',');
    const plan = `{"sprints":[{"number":1,"goal":"Fundações e autenticação","requirementIds":[${ids(1, 70)}]},{"number":2,"goal":"Loja e eventos","requirementIds":[${ids(71, 134)}]}`;
    expect(hasRepetition(plan)).toBe(false);
  });

  it('não confunde itens distintos com o mesmo formato', () => {
    const item = (i: number, title: string) =>
      `{"id":"REQ-${i}","title":"${title}","description":"O sistema deve ${title.toLowerCase()} conforme a seção correspondente do SDD.","layer":"backend","priority":"must","dependencies":[],"sourceSection":"2.1"}`;
    const titles = ['Login com RGA', 'Recuperar senha', 'Cadastrar produto', 'Listar eventos', 'Emitir relatório'];
    const distinct = '[' + titles.map((t, i) => item(i + 1, t)).join(',') + ',{"id":"REQ-6"';
    expect(hasRepetition(distinct)).toBe(false);
  });
});

describe('OllamaProvider format', () => {
  it('não força minItems em schemas de objeto', async () => {
    const transport = transportResponding(ndjson([{ message: { content: '{"same":true}' }, done: true }]));
    const provider = new OllamaProvider({ transport });

    await provider.complete(request, z.object({ same: z.boolean() }));

    expect(sentBody(transport).format).toMatchObject({ type: 'object' });
    expect(sentBody(transport).format.minItems).toBeUndefined();
  });
});

describe('normalizeBaseURL', () => {
  it('remove /v1 e barras finais para compatibilidade com o .env antigo', () => {
    expect(normalizeBaseURL('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(normalizeBaseURL('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeBaseURL('http://localhost:11434')).toBe('http://localhost:11434');
  });
});

describe('parseJsonResponse', () => {
  it('ignora blocos <think> emitidos por modelos locais', () => {
    expect(parseJsonResponse('<think>hmm\nlet me see</think>\n{"same": true}')).toEqual({
      same: true,
    });
  });
});

