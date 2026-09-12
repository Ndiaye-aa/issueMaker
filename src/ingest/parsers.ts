import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

export type SupportedExtension = '.md' | '.docx' | '.pdf';

export function isSupportedExtension(ext: string): ext is SupportedExtension {
  return ext === '.md' || ext === '.docx' || ext === '.pdf';
}

export async function parseSddFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (!isSupportedExtension(ext)) {
    throw new Error(
      `Formato de arquivo não suportado: "${ext}". Formatos aceitos: .md, .docx, .pdf`,
    );
  }

  switch (ext) {
    case '.md':
      return readFile(filePath, 'utf-8');
    case '.docx': {
      const buffer = await readFile(filePath);
      const { value } = await mammoth.extractRawText({ buffer });
      return assertNonEmptyText(value, filePath);
    }
    case '.pdf': {
      const buffer = await readFile(filePath);
      const { text } = await pdfParse(buffer);
      return assertNonEmptyText(
        text,
        filePath,
        'Se o PDF for digitalizado (imagem escaneada sem camada de texto), ele não é suportado — extraia o texto manualmente antes de usar o sdd-bot.',
      );
    }
  }
}

function assertNonEmptyText(text: string, filePath: string, hint?: string): string {
  if (text.trim().length === 0) {
    const suffix = hint ? ` ${hint}` : '';
    throw new Error(`Nenhum texto extraído de "${filePath}".${suffix}`);
  }
  return text;
}
