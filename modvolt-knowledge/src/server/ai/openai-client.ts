import OpenAI from "openai";
import { env } from "../env.js";

// Cache klientů podle API klíče. Klíče se u některých poskytovatelů generují
// zvlášť k jednotlivým modelům, proto může embeddingy, chat a vision obsluhovat
// různý klíč (a tedy různý klient).
const clients = new Map<string, OpenAI>();

/**
 * Vrátí OpenAI klienta pro daný API klíč. Bez argumentu se použije klíč pro
 * chat (env.openai.chatApiKey). Volající si dostupnost ověřuje přes
 * is*Usable() z env.ts; tady jen tvrdě selžeme, pokud klíč chybí.
 */
export function getOpenAi(apiKey: string = env.openai.chatApiKey): OpenAI {
  if (!apiKey) {
    throw new Error(
      "OpenAI není dostupné (chybí API klíč nebo OPENAI_ENABLED=false).",
    );
  }
  let client = clients.get(apiKey);
  if (!client) {
    client = new OpenAI({
      apiKey,
      timeout: env.openai.requestTimeoutMs,
      maxRetries: env.openai.maxRetries,
    });
    clients.set(apiKey, client);
  }
  return client;
}
