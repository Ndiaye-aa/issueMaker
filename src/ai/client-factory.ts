import { ResilientAIClient } from './client.js';
import { GroqProvider } from './providers/groq.js';
import { OllamaProvider } from './providers/ollama.js';

export function createResilientAIClient(): ResilientAIClient {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error('GROQ_API_KEY não definida. Configure o arquivo .env (ver .env.example).');
  }

  const primary = new GroqProvider({ apiKey: groqApiKey });
  const ollamaBaseURL = process.env.OLLAMA_BASE_URL;
  const fallback = new OllamaProvider(ollamaBaseURL ? { baseURL: ollamaBaseURL } : {});
  return new ResilientAIClient(primary, fallback);
}
