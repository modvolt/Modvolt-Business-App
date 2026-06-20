import { z } from "zod";
import { getOpenAi } from "./openai-client.js";
import { env, isOpenAiUsable } from "../env.js";
import { DOCUMENT_TYPES } from "../../shared/types.js";
import type { DocumentType } from "../../shared/types.js";
import { logger } from "../lib/logger.js";

export interface ClassificationCategory {
  id: string;
  name: string;
}

export interface ClassificationTag {
  id: string;
  name: string;
}

export interface ClassificationInput {
  /** Extrahovaný text dokumentu (může být prázdný). */
  text: string;
  fileName: string;
  categories: ClassificationCategory[];
  tags: ClassificationTag[];
}

export interface ClassificationSuggestion {
  documentType: DocumentType;
  /** ID existující kategorie nebo null (AI nevymýšlí nové kategorie). */
  categoryId: string | null;
  /** ID existujících štítků (AI nevymýšlí nové štítky). */
  tagIds: string[];
  title: string;
  description: string;
}

/** Klasifikace je dostupná pouze pokud je dostupná OpenAI. */
export function classificationAvailable(): boolean {
  return isOpenAiUsable();
}

// Maximální délka textu posílaná modelu (úspora tokenů). Klasifikaci stačí
// začátek dokumentu; přesnost se s plným textem výrazně nezvyšuje.
const MAX_TEXT_CHARS = 6000;

const suggestionSchema = z.object({
  documentType: z.string().default("other"),
  categoryId: z.string().nullable().default(null),
  tagIds: z.array(z.string()).default([]),
  title: z.string().default(""),
  description: z.string().default(""),
});

function buildSystemPrompt(input: ClassificationInput): string {
  const typeList = DOCUMENT_TYPES.join(", ");
  const catList = input.categories.length
    ? input.categories.map((c) => `- id="${c.id}" název="${c.name}"`).join("\n")
    : "(žádné kategorie nejsou k dispozici)";
  const tagList = input.tags.length
    ? input.tags.map((t) => `- id="${t.id}" název="${t.name}"`).join("\n")
    : "(žádné štítky nejsou k dispozici)";

  return `Jsi asistent pro automatickou klasifikaci dokumentů ve firmě Modvolt s.r.o. (elektroinstalace, slaboproud, revize, normy).
Na základě obsahu dokumentu navrhni jeho zařazení. Odpovídej VÝHRADNĚ česky a STRIKTNĚ ve formátu JSON dle schématu, bez textu mimo JSON.

PRAVIDLA:
- "documentType" MUSÍ být přesně jedna z těchto hodnot: ${typeList}. Pokud si nejsi jistý, použij "other".
- "categoryId" MUSÍ být id JEDNÉ z níže uvedených kategorií, nebo null. NIKDY nevymýšlej nové kategorie ani nevracej jejich názvy.
- "tagIds" MUSÍ být pole id z níže uvedených štítků (jen ty relevantní), nebo prázdné pole. NIKDY nevymýšlej nové štítky.
- "title" je stručný výstižný název dokumentu v češtině (max ~120 znaků).
- "description" je krátké shrnutí obsahu (1–2 věty) v češtině.
- Vycházej pouze z obsahu dokumentu; nic si nevymýšlej.

DOSTUPNÉ KATEGORIE:
${catList}

DOSTUPNÉ ŠTÍTKY:
${tagList}

FORMÁT ODPOVĚDI (JSON):
{
  "documentType": "jedna z povolených hodnot",
  "categoryId": "id kategorie nebo null",
  "tagIds": ["id štítku", "..."],
  "title": "string",
  "description": "string"
}`;
}

/**
 * Navrhne klasifikaci dokumentu (typ, kategorie, štítky, název, popis).
 * Vrací návrh omezený na kanonické hodnoty enum a existující kategorie/štítky.
 * Pokud OpenAI není dostupná nebo dojde k chybě, vrací null (volající doplní
 * výchozí hodnoty a klasifikuje ručně).
 */
export async function classifyDocument(
  input: ClassificationInput,
): Promise<ClassificationSuggestion | null> {
  if (!classificationAvailable()) return null;

  const text = (input.text ?? "").trim();
  const fallbackTitle = input.fileName.replace(/\.[^.]+$/, "");
  // Bez textu (např. skenovaný PDF bez OCR) nemá AI co klasifikovat.
  if (!text) return null;

  const userContent = `NÁZEV SOUBORU: ${input.fileName}\n\nOBSAH DOKUMENTU (zkráceno):\n${text.slice(
    0,
    MAX_TEXT_CHARS,
  )}`;

  let raw: string;
  try {
    const completion = await getOpenAi().chat.completions.create({
      model: env.openai.chatModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(input) },
        { role: "user", content: userContent },
      ],
    });
    raw = completion.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    logger.warn("AI klasifikace dokumentu selhala", String(err));
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    logger.warn("AI klasifikace vrátila neplatný JSON.", {
      rawPreview: raw.slice(0, 200),
    });
    return null;
  }

  const parsed = suggestionSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn("AI klasifikace neprošla validací.", {
      issues: parsed.error.issues,
    });
    return null;
  }

  // Omezení výstupu na kanonické hodnoty a existující záznamy (model si
  // nesmí vymýšlet typy/kategorie/štítky).
  const data = parsed.data;
  const documentType: DocumentType = (
    DOCUMENT_TYPES as readonly string[]
  ).includes(data.documentType)
    ? (data.documentType as DocumentType)
    : "other";

  const validCategoryIds = new Set(input.categories.map((c) => c.id));
  const categoryId =
    data.categoryId && validCategoryIds.has(data.categoryId)
      ? data.categoryId
      : null;

  const validTagIds = new Set(input.tags.map((t) => t.id));
  const tagIds = Array.from(
    new Set(data.tagIds.filter((id) => validTagIds.has(id))),
  );

  const title = data.title.trim() || fallbackTitle;
  const description = data.description.trim();

  return { documentType, categoryId, tagIds, title, description };
}
