import os from "node:os";
import path from "node:path";
import {
  mkdir,
  rm,
  rename,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";

/**
 * Odolné nahrávání velkých souborů po částech (chunked / resumable upload).
 *
 * Velký ZIP (stovky MB) se z prohlížeče nahrává po malých částech (~5 MB), každá
 * část jako samostatný krátký HTTP požadavek. Výhody na nestálém připojení:
 * - výpadek shodí jen jednu část (klient ji zopakuje), ne celý soubor,
 * - žádný jediný obří požadavek, který by spadl na timeout/limit reverzní proxy
 *   (typická příčina chyby 502 u velkých uploadů).
 *
 * Stav relace je čistě na disku (přežije restart serveru → lze obnovit). Každá
 * část se ukládá jako samostatný soubor `f<index>/<chunkIndex>`; při commitu se
 * po sobě jdoucí části spojí do výsledného souboru a průběžně se mažou.
 */

export const UPLOAD_SESSION_DIR = path.join(
  os.tmpdir(),
  "modvolt-bulk-sessions",
);

export interface UploadSessionFile {
  name: string;
  size: number;
  // Čas poslední změny souboru (z prohlížeče). Slouží jen k identitě souboru při
  // obnovení nahrávání – jiný/přegenerovaný soubor se stejným názvem i velikostí
  // má jiný timestamp, takže se na starou relaci nenaváže (ochrana proti záměně).
  lastModified?: number;
}

export interface UploadSessionMeta {
  uploadId: string;
  userId: string;
  autoClassify: boolean;
  createdAt: number;
  files: UploadSessionFile[];
}

function sessionDir(uploadId: string): string {
  return path.join(UPLOAD_SESSION_DIR, uploadId);
}

function metaPath(uploadId: string): string {
  return path.join(sessionDir(uploadId), "meta.json");
}

function fileChunkDir(uploadId: string, fileIndex: number): string {
  return path.join(sessionDir(uploadId), `f${fileIndex}`);
}

/** Založí relaci nahrávání: vytvoří adresáře pro části a uloží metadata. */
export async function createUploadSession(
  meta: UploadSessionMeta,
): Promise<void> {
  for (let i = 0; i < meta.files.length; i++) {
    await mkdir(fileChunkDir(meta.uploadId, i), { recursive: true });
  }
  await writeFile(metaPath(meta.uploadId), JSON.stringify(meta), "utf8");
}

/** Načte metadata relace, nebo null, pokud relace neexistuje/je poškozená. */
export async function readUploadSession(
  uploadId: string,
): Promise<UploadSessionMeta | null> {
  try {
    const raw = await readFile(metaPath(uploadId), "utf8");
    return JSON.parse(raw) as UploadSessionMeta;
  } catch {
    return null;
  }
}

/**
 * Uloží jednu část souboru. Idempotentní: opakované zaslání téže části jen
 * přepíše soubor (klient může část bezpečně zopakovat po výpadku). Zápis je
 * atomický přes dočasný `.part` + přejmenování, takže nedokončený zápis nikdy
 * nezanechá poškozenou část.
 */
export async function writeChunk(
  uploadId: string,
  fileIndex: number,
  chunkIndex: number,
  data: Buffer,
): Promise<void> {
  const dir = fileChunkDir(uploadId, fileIndex);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${chunkIndex}.part`);
  const fin = path.join(dir, String(chunkIndex));
  await writeFile(tmp, data);
  await rename(tmp, fin);
}

/** Vrátí seřazené indexy již přijatých částí daného souboru (pro obnovení). */
export async function receivedChunks(
  uploadId: string,
  fileIndex: number,
): Promise<number[]> {
  try {
    const names = await readdir(fileChunkDir(uploadId, fileIndex));
    return names
      .filter((n) => /^\d+$/.test(n))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Spojí po sobě jdoucí části souboru (0..n-1) do `destPath` a každou část po
 * zapsání smaže (aby špička obsazení disku byla jen ~výsledná velikost + jedna
 * část). Vyhodí chybu, pokud některá část chybí. Vrací celkový počet bajtů.
 */
export async function assembleFile(
  uploadId: string,
  fileIndex: number,
  destPath: string,
): Promise<number> {
  const chunks = await receivedChunks(uploadId, fileIndex);
  const out = createWriteStream(destPath);
  let total = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i] !== i) {
        throw new Error(`Chybí část ${i} souboru #${fileIndex}.`);
      }
      const chunkPath = path.join(fileChunkDir(uploadId, fileIndex), String(i));
      const buf = await readFile(chunkPath);
      total += buf.length;
      await new Promise<void>((resolve, reject) =>
        out.write(buf, (err) => (err ? reject(err) : resolve())),
      );
      await rm(chunkPath, { force: true });
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  return total;
}

/** Smaže celou relaci nahrávání (metadata i všechny zbylé části). */
export async function deleteUploadSession(uploadId: string): Promise<void> {
  await rm(sessionDir(uploadId), { recursive: true, force: true });
}

/**
 * Úklid opuštěných relací starších než `maxAgeMs` (nedokončené nahrávání, které
 * klient nikdy nedokončil). Volá se při startu serveru.
 */
export async function cleanupStaleUploadSessions(
  maxAgeMs: number,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(UPLOAD_SESSION_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const id of entries) {
    const meta = await readUploadSession(id);
    const age = meta ? now - meta.createdAt : Number.POSITIVE_INFINITY;
    if (!meta || age > maxAgeMs) {
      await deleteUploadSession(id).catch(() => {});
    }
  }
}
