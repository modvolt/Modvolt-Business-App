import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { promptVersions } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import {
  type PromptVersion,
  getPrompt,
  isBuiltInPromptVersion,
  getBuiltInPromptBody,
  getPromptPreview,
  makeCustomPrompt,
  listPromptVersions,
} from "./index.js";

// ---------------------------------------------------------------------------
// Správa vlastních (adminem upravených) verzí promptů uložených v databázi.
// Vestavěné verze (v kódu) slouží jako fallback; vlastní verze je rozšiřují
// a lze je vybrat jako aktivní stejně jako vestavěné.
// ---------------------------------------------------------------------------

export interface PromptVersionInfo {
  version: string;
  description: string;
  /** Editovatelné tělo promptu (základní pravidla). */
  body: string;
  /** Náhled kompletního systémového promptu (jen pro čtení). */
  preview: string;
  /** True = vestavěná verze v kódu (neupravitelná), false = vlastní z DB. */
  builtIn: boolean;
}

/** Náhled kompletního promptu pro libovolné tělo (reprezentativní kontext). */
function previewForBody(version: string, description: string, body: string): string {
  return makeCustomPrompt(version, description, body).buildSystemPrompt({
    sourceMode: "internal_then_web",
    sourceModeLocked: false,
    webSearchAvailable: true,
    hasImages: true,
  });
}

/** Vrátí vlastní prompt z DB podle verze, nebo null. */
async function findCustomPrompt(version: string) {
  const [row] = await db
    .select()
    .from(promptVersions)
    .where(eq(promptVersions.version, version))
    .limit(1);
  return row ?? null;
}

/**
 * Resolvuje aktivní verzi promptu na PromptVersion. Nejprve hledá vlastní verzi
 * v DB; pokud neexistuje, použije vestavěnou verzi v kódu (ta má vlastní
 * fallback na výchozí verzi).
 */
export async function resolvePrompt(version: string): Promise<PromptVersion> {
  if (!isBuiltInPromptVersion(version)) {
    const custom = await findCustomPrompt(version);
    if (custom) {
      return makeCustomPrompt(custom.version, custom.description, custom.body);
    }
  }
  return getPrompt(version);
}

/** Je `version` známá (vestavěná nebo uložená vlastní)? */
export async function isKnownPromptVersion(version: string): Promise<boolean> {
  if (isBuiltInPromptVersion(version)) return true;
  return (await findCustomPrompt(version)) !== null;
}

/** Spojený seznam vestavěných + vlastních verzí pro admin UI. */
export async function listAllPromptVersions(): Promise<PromptVersionInfo[]> {
  const builtIns = listPromptVersions().map((p) => ({
    version: p.version,
    description: p.description,
    body: getBuiltInPromptBody(p.version),
    preview: p.preview,
    builtIn: true,
  }));
  const customRows = await db.select().from(promptVersions);
  const custom = customRows.map((r) => ({
    version: r.version,
    description: r.description,
    body: r.body,
    preview: previewForBody(r.version, r.description, r.body),
    builtIn: false,
  }));
  return [...builtIns, ...custom];
}

export interface UpsertPromptInput {
  version: string;
  description: string;
  body: string;
}

/** Vytvoří novou vlastní verzi promptu. Verze nesmí kolidovat s vestavěnou. */
export async function createCustomPrompt(input: UpsertPromptInput) {
  if (isBuiltInPromptVersion(input.version)) {
    throw new PromptStoreError(
      `Verze „${input.version}" koliduje s vestavěnou verzí.`,
      "conflict",
    );
  }
  const existing = await findCustomPrompt(input.version);
  if (existing) {
    throw new PromptStoreError(
      `Verze „${input.version}" již existuje.`,
      "conflict",
    );
  }
  const [row] = await db
    .insert(promptVersions)
    .values({
      version: input.version,
      description: input.description,
      body: input.body,
    })
    .returning();
  return row;
}

/** Upraví existující vlastní verzi promptu (popis + tělo). */
export async function updateCustomPrompt(
  version: string,
  data: { description: string; body: string },
) {
  const [row] = await db
    .update(promptVersions)
    .set({
      description: data.description,
      body: data.body,
      updatedAt: new Date(),
    })
    .where(eq(promptVersions.version, version))
    .returning();
  if (!row) {
    throw new PromptStoreError("Vlastní verze promptu nenalezena.", "not_found");
  }
  return row;
}

/** Smaže vlastní verzi promptu. */
export async function deleteCustomPrompt(version: string) {
  const [row] = await db
    .delete(promptVersions)
    .where(eq(promptVersions.version, version))
    .returning();
  if (!row) {
    throw new PromptStoreError("Vlastní verze promptu nenalezena.", "not_found");
  }
  return row;
}

export type PromptStoreErrorKind = "conflict" | "not_found";

export class PromptStoreError extends AppError {
  kind: PromptStoreErrorKind;
  constructor(message: string, kind: PromptStoreErrorKind) {
    super(message, kind === "not_found" ? 404 : 409);
    this.name = "PromptStoreError";
    this.kind = kind;
  }
}
