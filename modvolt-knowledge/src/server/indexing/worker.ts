import { eq, and } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import {
  documents,
  documentChunks,
  documentEmbeddings,
  indexingJobs,
} from "../db/schema.js";
import { getObjectBuffer } from "../storage/s3.js";
import { extractText } from "../documents/text-extraction.js";
import { chunkText } from "../documents/chunking.js";
import {
  createEmbedding,
  createEmbeddings,
  embeddingsAvailable,
  toVectorLiteral,
} from "../ai/embeddings.js";
import { env, isOcrUsable } from "../env.js";
import { ocrPdf } from "../documents/ocr.js";
import { logger } from "../lib/logger.js";

let running = false;
let timer: NodeJS.Timeout | null = null;

/** Zařadí dokument ke zpracování. */
export async function enqueueDocument(
  documentId: string,
  jobType = "index",
): Promise<void> {
  await db.insert(indexingJobs).values({ documentId, jobType, status: "queued" });
  triggerProcessing();
}

export function startIndexingWorker(): void {
  if (timer) return;
  // Polling jednoduché fronty (portabilní, bez externího brokeru).
  timer = setInterval(() => void triggerProcessing(), 5000);
  triggerProcessing();
}

export function stopIndexingWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function triggerProcessing(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let job = await claimNextJob();
    while (job) {
      await processJob(job.id, job.documentId, job.jobType);
      job = await claimNextJob();
    }
  } catch (err) {
    logger.error("Chyba indexačního workeru", String(err));
  } finally {
    running = false;
  }
}

async function claimNextJob(): Promise<{
  id: string;
  documentId: string;
  jobType: string;
} | null> {
  // Atomické převzetí jednoho jobu.
  const res = await pool.query(
    `UPDATE indexing_jobs
     SET status='processing', started_at=now(), attempts=attempts+1, updated_at=now()
     WHERE id = (
       SELECT id FROM indexing_jobs
       WHERE status='queued'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, document_id, job_type`,
  );
  if (res.rows.length === 0) return null;
  return {
    id: res.rows[0].id,
    documentId: res.rows[0].document_id,
    jobType: res.rows[0].job_type,
  };
}

export async function processJob(
  jobId: string,
  documentId: string,
  jobType: string,
): Promise<void> {
  try {
    const docRows = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const doc = docRows[0];
    if (!doc) throw new Error("Dokument nenalezen");

    await db
      .update(documents)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(documents.id, documentId));

    const buffer = await getObjectBuffer(doc.objectPath);
    const extraction = await extractText(buffer, doc.mimeType, doc.originalFileName);

    if (extraction.needsOcr) {
      // OCR spustíme jen cíleně: buď to admin vyžádal (jobType "ocr"), nebo
      // dokument už dříve přes OCR prošel a teď ho přeindexováváme. Běžný
      // import/reindex skenu OCR nezkouší (kontrola nákladů na malém stroji).
      const wantOcr =
        isOcrUsable() && (jobType === "ocr" || doc.ocrApplied === true);
      if (wantOcr) {
        const isPdf =
          doc.mimeType === "application/pdf" ||
          doc.originalFileName.toLowerCase().endsWith(".pdf");
        if (isPdf && (await tryOcr(jobId, documentId, buffer))) {
          return;
        }
      }
      await markNeedsOcr(documentId);
      await finishJob(jobId, "done");
      logger.info(`Dokument ${documentId} vyžaduje OCR.`);
      return;
    }

    await indexFullText(jobId, documentId, extraction.fullText, false);
  } catch (err) {
    logger.error(`Indexace dokumentu ${documentId} selhala`, String(err));
    await pool.query(
      `UPDATE indexing_jobs SET status='failed', last_error=$2, finished_at=now(), updated_at=now() WHERE id=$1`,
      [jobId, String(err)],
    );
    await db
      .update(documents)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(documents.id, documentId));
  }
}

/** Nastaví dokument do stavu needs_ocr (sken bez využitelné textové vrstvy). */
async function markNeedsOcr(documentId: string): Promise<void> {
  await db
    .update(documents)
    .set({ status: "needs_ocr", textExtracted: false, updatedAt: new Date() })
    .where(eq(documents.id, documentId));
}

/**
 * Zkusí OCR naskenovaného PDF a při úspěchu dokument rovnou zaindexuje.
 * Vrací true, pokud OCR našlo využitelný text a job byl dokončen; jinak false
 * (volající ponechá stav needs_ocr). Chyba OCR neshodí worker ani server.
 */
async function tryOcr(
  jobId: string,
  documentId: string,
  buffer: Buffer,
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof ocrPdf>>;
  try {
    result = await ocrPdf(buffer);
  } catch (err) {
    logger.error(`OCR dokumentu ${documentId} selhalo`, String(err));
    return false;
  }
  const text = result.fullText.trim();
  if (text.length < 20) {
    logger.info(`OCR dokumentu ${documentId} nenašlo využitelný text.`);
    return false;
  }
  await indexFullText(jobId, documentId, text, true);
  logger.info(
    `Dokument ${documentId} zpracován přes OCR (${result.pageCount} stran${
      result.truncated ? ", oříznuto" : ""
    }).`,
  );
  return true;
}

/**
 * Společná indexační cesta: smaže staré chunky, rozseká text, uloží chunky,
 * spočítá embeddingy a nastaví dokument na indexed. `ocrApplied` označí, že
 * text pochází z OCR. Job se uvnitř dokončí.
 */
async function indexFullText(
  jobId: string,
  documentId: string,
  fullText: string,
  ocrApplied: boolean,
): Promise<void> {
  // Smaž staré chunky a embeddingy (reindex; embeddingy mají FK ON DELETE).
  await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));

  const chunks = chunkText(fullText, null);
  if (chunks.length === 0) {
    await db
      .update(documents)
      .set({ status: "needs_review", textExtracted: false, updatedAt: new Date() })
      .where(eq(documents.id, documentId));
    await finishJob(jobId, "done");
    return;
  }

  const inserted = await db
    .insert(documentChunks)
    .values(
      chunks.map((c) => ({
        documentId,
        chunkIndex: c.chunkIndex,
        pageNumber: c.pageNumber,
        sectionTitle: c.sectionTitle,
        content: c.content,
        tokenCount: c.tokenCount,
        isCurrent: true,
      })),
    )
    .returning({ id: documentChunks.id, content: documentChunks.content });

  // Embeddingy jsou volitelné - bez OpenAI zůstane fulltext.
  if (embeddingsAvailable()) {
    await embedChunks(inserted);
  }

  await db
    .update(documents)
    .set({
      status: "indexed",
      textExtracted: true,
      ocrApplied,
      indexedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));

  await finishJob(jobId, "done");
  logger.info(`Dokument ${documentId} zaindexován (${chunks.length} chunků).`);
}

async function embedChunks(
  chunks: { id: string; content: string }[],
): Promise<void> {
  const BATCH = Math.max(1, env.openai.embeddingBatchSize);
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    let vectors: number[][];
    try {
      vectors = await createEmbeddings(slice.map((c) => c.content));
    } catch (err) {
      // Dávka selhala i po opakování (typicky síťové „Premature close" nebo
      // jeden problémový chunk). Degradujeme na embedding po jednom chunku —
      // menší požadavky častěji projdou a izolují případný vadný chunk.
      if (slice.length === 1) throw err;
      logger.warn(
        `Embedding dávky (${slice.length} chunků) selhal, zkouším po jednom`,
        String(err),
      );
      vectors = [];
      for (const c of slice) {
        vectors.push(await createEmbedding(c.content));
      }
    }
    for (let j = 0; j < slice.length; j++) {
      await pool.query(
        `INSERT INTO document_embeddings (chunk_id, embedding, embedding_model)
         VALUES ($1, $2::vector, $3)`,
        [slice[j].id, toVectorLiteral(vectors[j]), env.openai.embeddingModel],
      );
    }
  }
}

async function finishJob(jobId: string, status: string): Promise<void> {
  await db
    .update(indexingJobs)
    .set({ status, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(indexingJobs.id, jobId));
}
