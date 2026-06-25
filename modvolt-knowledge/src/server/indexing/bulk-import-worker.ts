import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { bulkImportJobs } from "../db/schema.js";
import {
  createDocument,
  isAcceptedDocument,
  isZipFile,
  DuplicateDocumentError,
} from "../documents/document-service.js";
import { streamZipEntries, countZipEntries } from "../documents/zip-stream.js";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { readFile, rm, stat } from "node:fs/promises";

interface BulkSource {
  path: string;
  originalName: string;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

export function startBulkImportWorker(): void {
  if (timer) return;
  // Stejně jako indexační worker: jednoduchý polling, žádný externí broker.
  timer = setInterval(() => void triggerProcessing(), 5000);
  void resetStaleJobs().finally(() => void triggerProcessing());
}

export function stopBulkImportWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Okamžitě se pokusí zpracovat čekající joby (volá se po založení nového jobu). */
export function triggerBulkImport(): void {
  void triggerProcessing();
}

/**
 * Joby uvízlé ve stavu "processing" po restartu serveru přepneme na "failed" –
 * nelze je spolehlivě obnovit (nevíme, které soubory už prošly, a dočasné
 * soubory mohly být z /tmp smazány). Případné dříve založené dokumenty zůstávají.
 */
async function resetStaleJobs(): Promise<void> {
  try {
    await pool.query(
      `UPDATE bulk_import_jobs
       SET status='failed',
           last_error=COALESCE(last_error, 'Zpracování přerušeno restartem serveru.'),
           finished_at=now(), updated_at=now()
       WHERE status='processing'`,
    );
  } catch (err) {
    logger.error("Reset uvízlých hromadných importů selhal", String(err));
  }
}

async function triggerProcessing(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let job = await claimNextJob();
    while (job) {
      await processJob(job);
      job = await claimNextJob();
    }
  } catch (err) {
    logger.error("Chyba workeru hromadného importu", String(err));
  } finally {
    running = false;
  }
}

async function claimNextJob(): Promise<{
  id: string;
  createdByUserId: string | null;
  autoClassify: boolean;
  sources: BulkSource[];
} | null> {
  const res = await pool.query(
    `UPDATE bulk_import_jobs
     SET status='processing', started_at=now(), updated_at=now()
     WHERE id = (
       SELECT id FROM bulk_import_jobs
       WHERE status='queued'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, created_by_user_id, auto_classify, sources`,
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    autoClassify: row.auto_classify === true,
    sources: (row.sources as BulkSource[]) ?? [],
  };
}

async function processJob(job: {
  id: string;
  createdByUserId: string | null;
  autoClassify: boolean;
  sources: BulkSource[];
}): Promise<void> {
  const maxEntryBytes = env.bulk.maxFileMb * 1024 * 1024;
  const maxFiles = env.bulk.maxFiles;

  let accepted = 0;
  let duplicates = 0;
  let limitReached = false;
  const skipped: { fileName: string; reason: string }[] = [];
  const errors: { fileName: string; error: string }[] = [];

  // Počet zpracovaných položek odvozujeme z počítadel, aby zůstal konzistentní
  // napříč všemi větvemi (přijaté + duplicity + přeskočené + chyby).
  const processedCount = () =>
    accepted + duplicates + skipped.length + errors.length;

  try {
    // Odhad celkového počtu souborů (součet položek archivů + volné soubory).
    let totalFiles = 0;
    for (const src of job.sources) {
      totalFiles += isZipFile(src.originalName)
        ? await countZipEntries(src.path)
        : 1;
    }

    let lastFlush = 0;
    const maybeFlush = async (force = false): Promise<void> => {
      if (!force && Date.now() - lastFlush < 1000) return;
      lastFlush = Date.now();
      await flush(job.id, {
        totalFiles,
        processedFiles: processedCount(),
        accepted,
        duplicates,
        skippedCount: skipped.length,
        errorCount: errors.length,
        limitReached,
      });
    };
    await maybeFlush(true);

    const ingest = async (fileName: string, buffer: Buffer): Promise<void> => {
      if (accepted + duplicates >= maxFiles) {
        limitReached = true;
        return;
      }
      try {
        await createDocument({
          buffer,
          originalFileName: fileName,
          uploadedByUserId: job.createdByUserId ?? undefined,
          autoClassify: job.autoClassify,
        });
        accepted += 1;
      } catch (err) {
        if (err instanceof DuplicateDocumentError) {
          duplicates += 1;
        } else {
          errors.push({ fileName, error: (err as Error).message });
        }
      } finally {
        await maybeFlush();
      }
    };

    for (const src of job.sources) {
      try {
        if (isZipFile(src.originalName)) {
          const result = await streamZipEntries(
            src.path,
            {
              maxEntryBytes,
              shouldStop: () => accepted + duplicates >= maxFiles,
            },
            async (entry) => {
              await ingest(entry.fileName, entry.buffer);
            },
          );
          skipped.push(...result.skipped);
          // Archiv byl ukončen na limitu počtu souborů ještě před vyčerpáním
          // položek → část souborů zůstala nezpracována.
          if (result.stopped) limitReached = true;
        } else if (isAcceptedDocument(src.originalName)) {
          // Velikost z metadat na disku PŘED načtením do paměti.
          const info = await stat(src.path).catch(() => null);
          if (info && info.size > maxEntryBytes) {
            skipped.push({ fileName: src.originalName, reason: "Soubor je příliš velký." });
          } else {
            const buffer = await readFile(src.path);
            await ingest(src.originalName, buffer);
          }
        } else {
          skipped.push({ fileName: src.originalName, reason: "Nepodporovaný typ souboru." });
        }
      } catch (err) {
        errors.push({ fileName: src.originalName, error: (err as Error).message });
      } finally {
        // Dočasný soubor mažeme hned po zpracování (uvolní místo u velkých archivů).
        await rm(src.path, { force: true }).catch(() => {});
      }
      await maybeFlush();
    }

    await db
      .update(bulkImportJobs)
      .set({
        status: "completed",
        // Po dokončení srovnáme odhad na skutečně zpracovaný počet (odhad mohl
        // zahrnovat adresářové položky archivu nebo se zastavit na limitu).
        totalFiles: Math.max(totalFiles, processedCount()),
        processedFiles: processedCount(),
        accepted,
        duplicates,
        skippedCount: skipped.length,
        errorCount: errors.length,
        limitReached,
        skipped,
        errors,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bulkImportJobs.id, job.id));

    logger.info(
      `Hromadný import ${job.id} dokončen: přijato ${accepted}, duplicity ${duplicates}, přeskočeno ${skipped.length}, chyby ${errors.length}.`,
    );
  } catch (err) {
    // Fatální chyba (mimo jednotlivé soubory) – job označíme jako failed, ať
    // neuvízne ve stavu "processing" až do restartu serveru.
    logger.error(`Hromadný import ${job.id} selhal`, String(err));
    await db
      .update(bulkImportJobs)
      .set({
        status: "failed",
        accepted,
        duplicates,
        skippedCount: skipped.length,
        errorCount: errors.length,
        lastError: (err as Error).message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bulkImportJobs.id, job.id))
      .catch(() => {});
  } finally {
    // Záchranná síť proti úniku dočasných souborů: smaž vše, co po jobu zbylo
    // (např. když spadl ještě před hlavní smyčkou). Již smazané se přeskočí.
    await Promise.all(
      job.sources.map((s) => rm(s.path, { force: true }).catch(() => {})),
    );
  }
}

async function flush(
  jobId: string,
  counters: {
    totalFiles: number;
    processedFiles: number;
    accepted: number;
    duplicates: number;
    skippedCount: number;
    errorCount: number;
    limitReached: boolean;
  },
): Promise<void> {
  await db
    .update(bulkImportJobs)
    .set({ ...counters, updatedAt: new Date() })
    .where(eq(bulkImportJobs.id, jobId));
}
