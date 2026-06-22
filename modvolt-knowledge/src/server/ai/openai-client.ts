import OpenAI from "openai";
import { env } from "../env.js";

// Jediný OpenAI klient pro celou aplikaci. Jeden klíč obsluhuje všechny modely
// (chat, klasifikaci, embeddingy i vizi). Volitelně lze přesměrovat na jiný
// OpenAI-kompatibilní endpoint přes OPENAI_BASE_URL.
let client: OpenAI | null = null;

/**
 * Vrátí sdíleného OpenAI klienta. Dostupnost si volající ověřuje přes
 * is*Usable() z env.ts; tady jen tvrdě selžeme, pokud klíč chybí.
 */
export function getOpenAi(): OpenAI {
  if (!env.openai.apiKey) {
    throw new Error(
      "OpenAI není dostupné (chybí OPENAI_API_KEY nebo OPENAI_ENABLED=false).",
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: env.openai.apiKey,
      baseURL: env.openai.baseUrl || undefined,
      timeout: env.openai.requestTimeoutMs,
      maxRetries: env.openai.maxRetries,
    });
  }
  return client;
}
