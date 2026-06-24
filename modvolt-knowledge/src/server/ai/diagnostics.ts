import { sql } from "drizzle-orm";
import { getOpenAi } from "./openai-client.js";
import { createJsonResponse } from "./openai-responses.js";
import { describeOpenAiError } from "./openai-errors.js";
import { env, isOpenAiUsable } from "../env.js";
import { db, pool } from "../db/index.js";
import {
  EMBEDDING_DIMENSIONS,
  documentChunks,
  documentEmbeddings,
} from "../db/schema.js";
import type { AiDiagnostics, AiCheckResult } from "../../shared/types.js";

/**
 * Živá diagnostika AI: skutečně otestuje chat i embedding model, ověří rozměr
 * vektoru proti databázi (vector(1536)), dostupnost rozšíření pgvector a vrátí
 * počty chunků a embeddingů. Nikdy nevrací API klíč ani jiné tajné hodnoty –
 * pouze příznak `hasKey`. Každé selhání mapuje na srozumitelnou českou příčinu.
 */
export async function collectAiDiagnostics(): Promise<AiDiagnostics> {
  const enabled = isOpenAiUsable();
  const hasKey = env.openai.apiKey.length > 0;

  let chatTest: AiCheckResult = { ok: false, cause: null };
  let embeddingTest: AiCheckResult = { ok: false, cause: null };
  let actualDimension: number | null = null;

  if (!enabled) {
    const cause = hasKey
      ? "AI je vypnuté (nastavte OPENAI_ENABLED=true)."
      : "Chybí OPENAI_API_KEY nebo je AI vypnuté (OPENAI_ENABLED).";
    chatTest = { ok: false, cause };
    embeddingTest = { ok: false, cause };
  } else {
    // Chat model – ověříme přes Responses API s vynuceným JSON výstupem.
    // Vyžadujeme NEPRÁZDNOU, platnou JSON odpověď s ok:true. Prázdný výstup
    // (out === "") nesmí projít jako úspěch – jinak by diagnostika hlásila
    // funkční chat i tam, kde model nic nevrátil.
    try {
      const out = await createJsonResponse({
        system: 'Odpovídej výhradně platným JSON. Vrať přesně {"ok":true}.',
        user: "ping",
      });
      let parsed: { ok?: unknown } | null = null;
      try {
        parsed = out ? (JSON.parse(out) as { ok?: unknown }) : null;
      } catch {
        parsed = null;
      }
      if (parsed && parsed.ok === true) {
        chatTest = { ok: true, cause: null };
      } else {
        chatTest = {
          ok: false,
          cause:
            "Chat model odpověděl, ale nevrátil očekávaný JSON (prázdná nebo neplatná odpověď).",
        };
      }
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      chatTest = {
        ok: false,
        cause: describeOpenAiError(e, env.openai.chatModel),
      };
    }

    // Embedding model – ověříme rozměr vektoru proti tomu, co očekává DB.
    try {
      const res = await getOpenAi().embeddings.create(
        { model: env.openai.embeddingModel, input: "ping" },
        { maxRetries: 0 },
      );
      const vec = res.data[0]?.embedding as number[] | undefined;
      actualDimension = Array.isArray(vec) ? vec.length : null;
      if (actualDimension === EMBEDDING_DIMENSIONS) {
        embeddingTest = { ok: true, cause: null };
      } else {
        embeddingTest = {
          ok: false,
          cause: `Embedding model vrací ${actualDimension ?? "?"} dimenzí, ale databáze očekává ${EMBEDDING_DIMENSIONS}. Použijte model s rozměrem ${EMBEDDING_DIMENSIONS} (např. text-embedding-3-small).`,
        };
      }
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      embeddingTest = {
        ok: false,
        cause: describeOpenAiError(
          e,
          env.openai.embeddingModel,
          "OPENAI_EMBEDDING_MODEL",
        ),
      };
    }
  }

  // Dostupnost rozšíření pgvector (bez něj nelze ukládat ani hledat embeddingy).
  let pgvectorAvailable = false;
  try {
    const r = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
    );
    pgvectorAvailable = (r.rowCount ?? 0) > 0;
  } catch {
    pgvectorAvailable = false;
  }

  // Počty chunků a embeddingů (přehled o stavu indexace).
  let chunks = 0;
  let embeddings = 0;
  try {
    const [cRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(documentChunks);
    const [eRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(documentEmbeddings);
    chunks = cRow?.c ?? 0;
    embeddings = eRow?.c ?? 0;
  } catch {
    // Počty necháme na 0, pokud dotaz selže (např. chybí tabulky).
  }

  return {
    openaiEnabled: enabled,
    hasKey,
    baseUrl: env.openai.baseUrl || null,
    chatModel: env.openai.chatModel,
    embeddingModel: env.openai.embeddingModel,
    imageAnalysisEnabled: env.openai.imageAnalysisEnabled,
    expectedDimension: EMBEDDING_DIMENSIONS,
    actualDimension,
    dimensionMatch:
      actualDimension === null
        ? null
        : actualDimension === EMBEDDING_DIMENSIONS,
    pgvectorAvailable,
    chatTest,
    embeddingTest,
    counts: { chunks, embeddings },
  };
}
