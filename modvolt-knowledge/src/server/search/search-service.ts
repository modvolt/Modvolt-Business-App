import { pool } from "../db/index.js";
import {
  createEmbedding,
  embeddingsAvailable,
  toVectorLiteral,
} from "../ai/embeddings.js";
import type { SourceMode } from "../../shared/types.js";
import { csnOnlyDocumentTypes } from "./source-mode.js";

export interface SearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  documentType: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  content: string;
  score: number;
  matchType: "vector" | "fulltext" | "hybrid";
}

export interface SearchOptions {
  limit?: number;
  sourceMode?: SourceMode;
  includeAdminOnly?: boolean;
}

/**
 * Hybridní vyhledávání: kombinuje fulltext (ts_rank) a vektorové (cosine).
 * Bez OpenAI funguje pouze fulltext.
 */
export async function searchChunks(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 8;
  const visibilityFilter = opts.includeAdminOnly
    ? ""
    : "AND d.visibility = 'all_users'";
  const typeFilter =
    opts.sourceMode === "csn_only"
      ? `AND d.document_type = ANY($TYPES)`
      : "";

  const typeParams =
    opts.sourceMode === "csn_only" ? csnOnlyDocumentTypes() : null;

  const fulltextHits = await fulltextSearch(
    query,
    limit,
    visibilityFilter,
    typeFilter,
    typeParams,
  );

  if (!embeddingsAvailable()) {
    return fulltextHits;
  }

  let vectorHits: SearchHit[] = [];
  try {
    const embedding = await createEmbedding(query);
    vectorHits = await vectorSearch(
      embedding,
      limit,
      visibilityFilter,
      typeFilter,
      typeParams,
    );
  } catch {
    // Při výpadku embeddingu se spolehni na fulltext.
    return fulltextHits;
  }

  return mergeHits(vectorHits, fulltextHits, limit);
}

async function fulltextSearch(
  query: string,
  limit: number,
  visibilityFilter: string,
  typeFilter: string,
  typeParams: string[] | null,
): Promise<SearchHit[]> {
  const params: unknown[] = [query, limit];
  let typeClause = "";
  if (typeParams) {
    params.push(typeParams);
    typeClause = typeFilter.replace("$TYPES", `$${params.length}`);
  }
  const sql = `
    SELECT c.id AS chunk_id, c.document_id, d.title, d.document_type,
           c.page_number, c.section_title, c.content,
           ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $1)) AS score
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.is_current = true
      AND d.status = 'indexed'
      AND to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
      ${visibilityFilter}
      ${typeClause}
    ORDER BY score DESC
    LIMIT $2`;
  const res = await pool.query(sql, params);
  return res.rows.map((r) => rowToHit(r, "fulltext"));
}

async function vectorSearch(
  embedding: number[],
  limit: number,
  visibilityFilter: string,
  typeFilter: string,
  typeParams: string[] | null,
): Promise<SearchHit[]> {
  const params: unknown[] = [toVectorLiteral(embedding), limit];
  let typeClause = "";
  if (typeParams) {
    params.push(typeParams);
    typeClause = typeFilter.replace("$TYPES", `$${params.length}`);
  }
  const sql = `
    SELECT c.id AS chunk_id, c.document_id, d.title, d.document_type,
           c.page_number, c.section_title, c.content,
           1 - (e.embedding <=> $1::vector) AS score
    FROM document_embeddings e
    JOIN document_chunks c ON c.id = e.chunk_id
    JOIN documents d ON d.id = c.document_id
    WHERE c.is_current = true
      AND d.status = 'indexed'
      ${visibilityFilter}
      ${typeClause}
    ORDER BY e.embedding <=> $1::vector ASC
    LIMIT $2`;
  const res = await pool.query(sql, params);
  return res.rows.map((r) => rowToHit(r, "vector"));
}

function rowToHit(r: any, matchType: SearchHit["matchType"]): SearchHit {
  return {
    chunkId: r.chunk_id,
    documentId: r.document_id,
    title: r.title,
    documentType: r.document_type,
    pageNumber: r.page_number,
    sectionTitle: r.section_title,
    content: r.content,
    score: Number(r.score),
    matchType,
  };
}

/** Reciprocal Rank Fusion pro spojení vektorových a fulltext výsledků. */
function mergeHits(
  vector: SearchHit[],
  fulltext: SearchHit[],
  limit: number,
): SearchHit[] {
  const k = 60;
  const scores = new Map<string, { hit: SearchHit; score: number }>();

  const add = (hits: SearchHit[]) => {
    hits.forEach((hit, idx) => {
      const prev = scores.get(hit.chunkId);
      const rrf = 1 / (k + idx + 1);
      if (prev) {
        prev.score += rrf;
        prev.hit.matchType = "hybrid";
      } else {
        scores.set(hit.chunkId, { hit: { ...hit }, score: rrf });
      }
    });
  };
  add(vector);
  add(fulltext);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ ...s.hit, score: s.score }));
}
