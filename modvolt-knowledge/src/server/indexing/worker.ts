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
import { env } from "../env.js";
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
      await processJob(job.id, job.documentId);
      job = await claimNextJob();
    }
  } catch (err) {
    logger.error("Chyba indexačního workeru", String(err));
  } finally {
    running = false;
  }
}

async function claimNextJob(): Promise<{ id: string; documentId: string } | null> {
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
     RETURNING id, document_id`,
  );
  if (res.rows.length === 0) return null;
  return { id: res.rows[0].id, documentId: res.rows[0].document_id };
}

async function processJob(jobId: string, documentId: string): Promise<void> {
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
      await db
        .update(documents)
        .set({ status: "needs_ocr", textExtracted: false, updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await finishJob(jobId, "done");
      logger.info(`Dokument ${documentId} vyžaduje OCR.`);
      return;
    }

    // Smaž staré chunky a embeddingy (reindex).
    await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));

    const chunks = chunkText(extraction.fullText, null);
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
        indexedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));

    await finishJob(jobId, "done");
    logger.info(`Dokument ${documentId} zaindexován (${chunks.length} chunků).`);
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
