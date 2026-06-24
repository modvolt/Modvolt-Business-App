// Sdílené typy mezi frontendem a backendem.

export type UserRole = "admin" | "user" | "read_only";

export type SourceMode =
  | "internal_only"
  | "internal_then_web"
  | "web_allowed"
  | "csn_only";

export type SearchMode = "search" | "ai_chat" | "image_chat";

export type DocumentStatus =
  | "uploaded"
  | "processing"
  | "indexed"
  | "needs_review"
  | "needs_ocr"
  | "failed"
  | "archived";

export type DocumentVisibility = "all_users" | "admin_only";

// Kanonický seznam typů dokumentů. Slouží jako jediný zdroj pravdy pro
// frontend (výběry/filtry), server (validace) i AI klasifikaci.
export const DOCUMENT_TYPES = [
  "standard",
  "norm",
  "manual",
  "internal_procedure",
  "datasheet",
  "legal",
  "bozp",
  "template",
  "manufacturer_manual",
  "troubleshooting",
  "other",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type Confidence = "low" | "medium" | "high";

export type WebSourceType =
  | "manufacturer_docs"
  | "manufacturer_support"
  | "forum"
  | "blog"
  | "ecommerce"
  | "other";

export interface Citation {
  documentId: string;
  chunkId: string;
  title: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  quote: string;
  reason: string;
}

export interface WebCitation {
  title: string;
  url: string;
  domain: string;
  isOfficialSource: boolean;
  sourceType: WebSourceType;
  reason: string;
}

export interface AiAnswer {
  answer: string;
  imageObservations?: string[];
  requiredMeasurements?: string[];
  confidence: Confidence;
  hasSufficientSources: boolean;
  sourceMode: SourceMode;
  citations: Citation[];
  webCitations: WebCitation[];
  warnings: string[];
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface AiCheckResult {
  ok: boolean;
  cause: string | null;
}

export interface AiDiagnostics {
  openaiEnabled: boolean;
  hasKey: boolean;
  baseUrl: string | null;
  chatModel: string;
  embeddingModel: string;
  imageAnalysisEnabled: boolean;
  expectedDimension: number;
  actualDimension: number | null;
  dimensionMatch: boolean | null;
  pgvectorAvailable: boolean;
  chatTest: AiCheckResult;
  embeddingTest: AiCheckResult;
  counts: { chunks: number; embeddings: number };
}
