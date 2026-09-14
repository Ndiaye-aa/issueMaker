import { ResilientAIClient } from './client.js';
import { GroqProvider } from './providers/groq.js';
import { OllamaProvider } from './providers/ollama.js';
import { log } from '../cli/logger.js';

export function createResilientAIClient(): ResilientAIClient {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error('GROQ_API_KEY não definida. Configure o arquivo .env (ver .env.example).');
  }

  const groqModel = process.env.GROQ_MODEL;
  const primary = new GroqProvider({ apiKey: groqApiKey, ...(groqModel ? { model: groqModel } : {}) });

  const ollamaBaseURL = process.env.OLLAMA_BASE_URL;
  const ollamaModel = process.env.OLLAMA_MODEL;
  const fallback = new OllamaProvider({
    ...(ollamaBaseURL ? { baseURL: ollamaBaseURL } : {}),
    ...(ollamaModel ? { model: ollamaModel } : {}),
  });

  log.step(`provedores: groq=${primary.model} → fallback ollama=${fallback.model}`);
  return new ResilientAIClient(primary, fallback);
}
