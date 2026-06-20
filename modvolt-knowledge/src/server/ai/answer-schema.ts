import { z } from "zod";
import type { AiAnswer, SourceMode } from "../../shared/types.js";

// Zod schema pro validaci výstupu z OpenAI. Je záměrně tolerantní k drobným
// odchylkám (chybějící pole, prázdné objekty), ale zaručuje správné typy.
const citationSchema = z.object({
  documentId: z.string().default(""),
  chunkId: z.string().default(""),
  title: z.string().default(""),
  pageNumber: z.number().nullable().default(null),
  sectionTitle: z.string().nullable().default(null),
  quote: z.string().default(""),
  reason: z.string().default(""),
});

const webCitationSchema = z.object({
  title: z.string().default(""),
  url: z.string().default(""),
  domain: z.string().default(""),
  isOfficialSource: z.boolean().default(false),
  sourceType: z
    .enum([
      "manufacturer_docs",
      "manufacturer_support",
      "forum",
      "blog",
      "ecommerce",
      "other",
    ])
    .default("other"),
  reason: z.string().default(""),
});

export const aiAnswerSchema = z.object({
  answer: z.string(),
  imageObservations: z.array(z.string()).default([]),
  requiredMeasurements: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("low"),
  hasSufficientSources: z.boolean().default(false),
  citations: z.array(citationSchema).default([]),
  webCitations: z.array(webCitationSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export type ParsedAiAnswer = z.infer<typeof aiAnswerSchema>;

/** Bezpečná odpověď použitá, když OpenAI vrátí nevalidní JSON/strukturu. */
export function safeFallbackAnswer(sourceMode: SourceMode): AiAnswer {
  return {
    answer:
      "Odpověď se nepodařilo bezpečně zpracovat (neplatný formát výstupu modelu). " +
      "Zkuste dotaz prosím zopakovat nebo jej přeformulujte.",
    imageObservations: [],
    requiredMeasurements: [],
    confidence: "low",
    hasSufficientSources: false,
    sourceMode,
    citations: [],
    webCitations: [],
    warnings: [
      "Výstup AI neprošel validací (neplatný JSON nebo struktura). Odpověď nebyla poskytnuta.",
    ],
  };
}
