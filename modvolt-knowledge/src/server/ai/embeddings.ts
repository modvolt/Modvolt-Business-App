import { getOpenAi } from "./openai-client.js";
import { env, isEmbeddingsUsable } from "../env.js";
import { logger } from "../lib/logger.js";

export function embeddingsAvailable(): boolean {
  return isEmbeddingsUsable();
}

/**
 * Rozhodne, zda má smysl volání opakovat. Konfigurační chyby (4xx kromě 429)
 * neopakujeme; přechodné síťové chyby (např. node-fetch "Premature close",
 * ECONNRESET, timeout) a 429/5xx ano.
 */
function isRetryable(err: unknown): boolean {
  const e = err as {
    name?: string;
    status?: number;
    message?: string;
  };
  const status = e?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  const msg = (e?.message ?? "").toLowerCase();
  return (
    e?.name === "FetchError" ||
    e?.name === "APIConnectionError" ||
    e?.name === "APIConnectionTimeoutError" ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    msg.includes("premature close") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("timeout")
  );
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const max = env.openai.maxRetries;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === max || !isRetryable(err)) break;
      const delay =
        Math.min(1000 * 2 ** attempt, 15000) + Math.floor(Math.random() * 250);
      logger.warn(
        `${label}: pokus ${attempt + 1}/${max + 1} selhal, opakuji za ${delay} ms`,
        String(err),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Vytvoří embeddingy pro dávku textů (s opakováním při přechodných chybách). */
export async function createEmbeddings(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await withRetry(
    () =>
      // maxRetries: 0 vypne vestavěné opakování SDK pro tuto cestu — opakování
      // řeší withRetry, aby se počty opakování nenásobily (SDK × wrapper).
      getOpenAi().embeddings.create(
        {
          model: env.openai.embeddingModel,
          input: texts,
        },
        { maxRetries: 0 },
      ),
    "Embeddingy",
  );
  return res.data.map((d) => d.embedding as number[]);
}

export async function createEmbedding(text: string): Promise<number[]> {
  const [vec] = await createEmbeddings([text]);
  return vec;
}

/** Převod number[] na pgvector literál: "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
