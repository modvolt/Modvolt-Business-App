import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";

// Krátkodobé úložiště rozbalených položek ZIP archivu. Cíl: po rozbalení ZIPu
// na serveru nedrží klient bajty dokumentů (a neposílá je třikrát sem a tam).
// Místo toho server uloží každou položku do dočasného souboru na disku a klient
// dostane jen lehká metadata (token relace + ID položky + název + velikost).
// Analyze/commit pak položky odkážou přes token, aniž by je klient nahrával.
//
// Proč disk a ne paměť: dávka může mít desítky souborů po desítkách MB; držet
// je všechny v paměti serveru po dobu života relace by způsobilo tlak na paměť.
// Disk drží data mimo haldu a čte se vždy jen jedna položka v okamžiku potřeby.

const ROOT = path.join(os.tmpdir(), "modvolt-import-sessions");

// Relace je krátkodobá – jen na dobu mezi rozbalením a potvrzením dávky.
const TTL_MS = 30 * 60 * 1000;

export interface ImportEntryMeta {
  entryId: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
}

interface StoredEntry extends ImportEntryMeta {
  filePath: string;
}

interface ImportSession {
  token: string;
  userId: string;
  expiresAt: number;
  dir: string;
  entries: Map<string, StoredEntry>;
}

const sessions = new Map<string, ImportSession>();

export interface CreateEntryInput {
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}

export interface ResolvedImportEntry {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Vytvoří relaci importu: každou položku zapíše do dočasného souboru a vrátí
 * token + lehká metadata (bez obsahu). Token slouží k pozdějšímu odkazování.
 */
export async function createImportSession(
  userId: string,
  inputs: CreateEntryInput[],
): Promise<{ token: string; entries: ImportEntryMeta[] }> {
  const token = randomUUID();
  const dir = path.join(ROOT, token);
  await mkdir(dir, { recursive: true });

  const session: ImportSession = {
    token,
    userId,
    expiresAt: Date.now() + TTL_MS,
    dir,
    entries: new Map(),
  };
  const metas: ImportEntryMeta[] = [];

  for (const input of inputs) {
    const entryId = randomUUID();
    const filePath = path.join(dir, entryId);
    await writeFile(filePath, input.buffer);
    const meta: StoredEntry = {
      entryId,
      fileName: input.fileName,
      sizeBytes: input.buffer.length,
      mimeType: input.mimeType,
      filePath,
    };
    session.entries.set(entryId, meta);
    metas.push({
      entryId,
      fileName: input.fileName,
      sizeBytes: input.buffer.length,
      mimeType: input.mimeType,
    });
  }

  sessions.set(token, session);
  return { token, entries: metas };
}

/**
 * Načte obsah jedné položky relace. Vrací null, pokud relace neexistuje,
 * vypršela, patří jinému uživateli, položka chybí, nebo soubor zmizel.
 */
export async function readImportEntry(
  token: string,
  entryId: string,
  userId: string,
): Promise<ResolvedImportEntry | null> {
  const session = sessions.get(token);
  if (!session || session.userId !== userId || session.expiresAt < Date.now()) {
    return null;
  }
  const entry = session.entries.get(entryId);
  if (!entry) return null;
  try {
    const buffer = await readFile(entry.filePath);
    return { fileName: entry.fileName, mimeType: entry.mimeType, buffer };
  } catch {
    return null;
  }
}

/** Smaže relaci i s jejími dočasnými soubory (best-effort). */
export async function deleteImportSession(token: string): Promise<void> {
  const session = sessions.get(token);
  sessions.delete(token);
  if (session) {
    try {
      await rm(session.dir, { recursive: true, force: true });
    } catch {
      // Úklid je best-effort; sweeper to případně doklidí.
    }
  }
}

/**
 * Smaže jednu položku relace a její dočasný soubor (best-effort). Slouží k
 * uvolnění místa hned po úspěšném potvrzení položky – bajty už nejsou potřeba.
 * Když po smazání v relaci nezůstanou žádné položky, smaže se celá relace
 * (i s adresářem), takže po potvrzení celé dávky disk nezůstane zaplněný.
 * No-op, pokud relace neexistuje, patří jinému uživateli, nebo položka chybí.
 */
export async function deleteImportEntry(
  token: string,
  entryId: string,
  userId: string,
): Promise<void> {
  const session = sessions.get(token);
  if (!session || session.userId !== userId) return;
  const entry = session.entries.get(entryId);
  if (!entry) return;
  session.entries.delete(entryId);
  try {
    await rm(entry.filePath, { force: true });
  } catch {
    // Úklid je best-effort; sweeper případně doklidí celý adresář relace.
  }
  if (session.entries.size === 0) {
    await deleteImportSession(token);
  }
}

/**
 * Zahodí relaci na pokyn klienta (dokončený/zrušený import). User-scoped:
 * cizí relaci nelze smazat. Idempotentní – chybějící relace je no-op.
 */
export async function discardImportSession(
  token: string,
  userId: string,
): Promise<void> {
  const session = sessions.get(token);
  if (!session || session.userId !== userId) return;
  await deleteImportSession(token);
}

/** Smaže vypršelé relace. Volá se periodicky i lazy při přístupu. */
export async function sweepExpiredImportSessions(): Promise<void> {
  const now = Date.now();
  const expired: string[] = [];
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) expired.push(token);
  }
  for (const token of expired) {
    await deleteImportSession(token);
  }
}

// Periodický úklid vypršelých relací. unref(), aby nebránil ukončení procesu
// (a testům běžícím v node:test).
const sweeper = setInterval(() => {
  void sweepExpiredImportSessions();
}, 5 * 60 * 1000);
sweeper.unref?.();
