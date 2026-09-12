import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

jest.unstable_mockModule('pdf-parse', () => ({
  default: jest.fn(async () => ({ text: '' })),
}));

const { parseSddFile } = await import('../src/ingest/parsers.js');

describe('parseSddFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sdd-bot-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejeita extensões não suportadas', async () => {
    const filePath = join(dir, 'sdd.txt');
    await writeFile(filePath, 'conteúdo', 'utf-8');

    await expect(parseSddFile(filePath)).rejects.toThrow(/não suportado/);
  });

  it('lê arquivos .md diretamente', async () => {
    const filePath = join(dir, 'sdd.md');
    await writeFile(filePath, '# SDD\nconteúdo', 'utf-8');

    await expect(parseSddFile(filePath)).resolves.toBe('# SDD\nconteúdo');
  });

  it('falha com mensagem clara para PDF sem texto extraível (ex.: escaneado)', async () => {
    const filePath = join(dir, 'sdd.pdf');
    await writeFile(filePath, '%PDF-1.4 fake', 'utf-8');

    await expect(parseSddFile(filePath)).rejects.toThrow(/Nenhum texto extraído/);
  });
});
