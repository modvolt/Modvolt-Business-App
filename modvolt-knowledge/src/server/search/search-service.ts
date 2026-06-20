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

export interface SearchFilters {
  categoryId?: string;
  status?: string;
  documentTypes?: string[];
  tagIds?: string[];
  version?: string;
  validOn?: string; // ISO datum (YYYY-MM-DD) – platnost dokumentu k tomuto dni
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  sourceMode?: SourceMode;
  includeAdminOnly?: boolean;
}

/**
 * Sestaví dynamické WHERE klauzule pro filtry a doplní parametry.
 * `params` je sdílené pole, do kterého se přidávají hodnoty filtrů; indexy
 * placeholderů ($N) navazují na již existující parametry.
 */
function buildFilterClauses(
  opts: SearchOptions,
  params: unknown[],
): string {
  const clauses: string[] = [];

  // Viditelnost (admin-only dokumenty skryjeme běžným uživatelům).
  if (!opts.includeAdminOnly) {
    clauses.push("d.visibility = 'all_users'");
  }

  // Stav dokumentu. Výchozí je 'indexed', lze přepsat explicitním filtrem.
  if (opts.status) {
    params.push(opts.status);
    clauses.push(`d.status = $${params.length}`);
  } else {
    clauses.push("d.status = 'indexed'");
  }

  // Typy dokumentů. csn_only vynucuje normy/standardy bez ohledu na vstup.
  const documentTypes =
    opts.sourceMode === "csn_only"
      ? csnOnlyDocumentTypes()
      : opts.documentTypes && opts.documentTypes.length > 0
        ? opts.documentTypes
        : null;
  if (documentTypes) {
    params.push(documentTypes);
    clauses.push(`d.document_type = ANY($${params.length})`);
  }

  if (opts.categoryId) {
    params.push(opts.categoryId);
    clauses.push(`d.category_id = $${params.length}`);
  }

  if (opts.version) {
    params.push(opts.version);
    clauses.push(`d.version = $${params.length}`);
  }

  if (opts.validOn) {
    params.push(opts.validOn);
    const idx = params.length;
    clauses.push(`(d.valid_from IS NULL OR d.valid_from <= $${idx}::date)`);
    clauses.push(`(d.valid_to IS NULL OR d.valid_to >= $${idx}::date)`);
  }

  if (opts.tagIds && opts.tagIds.length > 0) {
    params.push(opts.tagIds);
    clauses.push(
      `EXISTS (SELECT 1 FROM document_tag_links dtl
               WHERE dtl.document_id = d.id AND dtl.tag_id = ANY($${params.length}))`,
    );
  }

  return clauses.length ? `AND ${clauses.join("\n      AND ")}` : "";
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

  const fulltextHits = await fulltextSearch(query, limit, opts);

  if (!embeddingsAvailable()) {
    return fulltextHits;
  }

  let vectorHits: SearchHit[] = [];
  try {
    const embedding = await createEmbedding(query);
    vectorHits = await vectorSearch(embedding, limit, opts);
  } catch {
    // Při výpadku embeddingu se spolehni na fulltext.
    return fulltextHits;
  }

  return mergeHits(vectorHits, fulltextHits, limit);
}

async function fulltextSearch(
  query: string,
  limit: number,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  const params: unknown[] = [query, limit];
  const filterClause = buildFilterClauses(opts, params);
  const sql = `
    SELECT c.id AS chunk_id, c.document_id, d.title, d.document_type,
           c.page_number, c.section_title, c.content,
           ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $1)) AS score
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.is_current = true
      AND to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
      ${filterClause}
    ORDER BY score DESC
    LIMIT $2`;
  const res = await pool.query(sql, params);
  return res.rows.map((r) => rowToHit(r, "fulltext"));
}

async function vectorSearch(
  embedding: number[],
  limit: number,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  const params: unknown[] = [toVectorLiteral(embedding), limit];
  const filterClause = buildFilterClauses(opts, params);
  const sql = `
    SELECT c.id AS chunk_id, c.document_id, d.title, d.document_type,
           c.page_number, c.section_title, c.content,
           1 - (e.embedding <=> $1::vector) AS score
    FROM document_embeddings e
    JOIN document_chunks c ON c.id = e.chunk_id
    JOIN documents d ON d.id = c.document_id
    WHERE c.is_current = true
      ${filterClause}
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
