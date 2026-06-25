import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  integer,
  jsonb,
  vector,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// Pozn.: embedding dimenze odpovídá text-embedding-3-small (1536).
export const EMBEDDING_DIMENSIONS = 1536;

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"), // admin | user | read_only
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    emailIdx: index("users_email_idx").on(t.email),
  }),
);

export const documentCategories = pgTable("document_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  parentId: uuid("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    // SET NULL: při smazání kategorie se dokumenty neodstraní, pouze ztratí vazbu.
    categoryId: uuid("category_id").references(() => documentCategories.id, {
      onDelete: "set null",
    }),
    documentType: text("document_type").notNull().default("other"),
    sourceName: text("source_name"),
    sourceUrl: text("source_url"),
    version: text("version"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    status: text("status").notNull().default("uploaded"),
    visibility: text("visibility").notNull().default("all_users"),
    originalFileName: text("original_file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    sha256Hash: text("sha256_hash").notNull(),
    objectPath: text("object_path").notNull(),
    textExtracted: boolean("text_extracted").notNull().default(false),
    // True, pokud byl text získán přes OCR (naskenované PDF bez textové vrstvy).
    ocrApplied: boolean("ocr_applied").notNull().default(false),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    // SET NULL: při smazání uživatele zůstane dokument, jen přijde o autora.
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("documents_status_idx").on(t.status),
    categoryIdx: index("documents_category_idx").on(t.categoryId),
    typeIdx: index("documents_type_idx").on(t.documentType),
    hashIdx: uniqueIndex("documents_sha256_idx").on(t.sha256Hash),
  }),
);

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // CASCADE: smazání dokumentu odstraní všechny jeho verze.
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  versionLabel: text("version_label").notNull(),
  originalFileName: text("original_file_name").notNull(),
  objectPath: text("object_path").notNull(),
  sha256Hash: text("sha256_hash").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  changeNote: text("change_note"),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // CASCADE: smazání dokumentu odstraní všechny jeho chunky (a přes ně embeddingy).
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id"),
    chunkIndex: integer("chunk_index").notNull().default(0),
    pageNumber: integer("page_number"),
    sectionTitle: text("section_title"),
    headingPath: text("heading_path"),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    metadataJson: jsonb("metadata_json"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index("document_chunks_document_idx").on(t.documentId),
    currentIdx: index("document_chunks_current_idx").on(t.isCurrent),
  }),
);

export const documentEmbeddings = pgTable(
  "document_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // CASCADE: smazání chunku (při reindexaci nebo smazání dokumentu) odstraní embedding.
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => documentChunks.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chunkIdx: index("document_embeddings_chunk_idx").on(t.chunkId),
    // HNSW index pro rychlé vyhledávání (vytvořen v migraci).
    embeddingIdx: index("document_embeddings_vector_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);

export const documentTags = pgTable("document_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentTagLinks = pgTable(
  "document_tag_links",
  {
    // CASCADE: smazání dokumentu nebo štítku odstraní příslušné vazby.
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => documentTags.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.tagId] }),
  }),
);

export const searchQueries = pgTable("search_queries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  query: text("query").notNull(),
  mode: text("mode").notNull().default("search"),
  sourceMode: text("source_mode"),
  resultCount: integer("result_count").notNull().default(0),
  promptVersion: text("prompt_version"),
  model: text("model"),
  usedChunkIds: jsonb("used_chunk_ids"),
  usedWebSearch: boolean("used_web_search").notNull().default(false),
  webResultsJson: jsonb("web_results_json"),
  attachmentIds: jsonb("attachment_ids"),
  // Tvrdý zámek ČSN: zda byl dotaz vynuceně přepnut na csn_only a co to spustilo
  // (klíčové slovo nebo vestavěný vzor) - pro ladění seznamu klíčových slov adminem.
  csnLockTriggered: boolean("csn_lock_triggered").notNull().default(false),
  csnLockTrigger: text("csn_lock_trigger"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // CASCADE: smazání uživatele odstraní jeho chat sessions (a přes ně zprávy).
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Nová konverzace"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  // CASCADE: smazání session odstraní všechny zprávy v ní.
  sessionId: uuid("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant | system
  content: text("content").notNull(),
  citationsJson: jsonb("citations_json"),
  webCitationsJson: jsonb("web_citations_json"),
  sourceMode: text("source_mode"),
  usedWebSearch: boolean("used_web_search").notNull().default(false),
  promptVersion: text("prompt_version"),
  model: text("model"),
  usedChunkIds: jsonb("used_chunk_ids"),
  attachmentIds: jsonb("attachment_ids"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatAttachments = pgTable("chat_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatMessageId: uuid("chat_message_id"),
  chatSessionId: uuid("chat_session_id"),
  uploadedByUserId: uuid("uploaded_by_user_id").notNull(),
  attachmentType: text("attachment_type").notNull().default("image"),
  originalFileName: text("original_file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  sha256Hash: text("sha256_hash").notNull(),
  objectPath: text("object_path").notNull(),
  width: integer("width"),
  height: integer("height"),
  exifRemoved: boolean("exif_removed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  metadataJson: jsonb("metadata_json"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appSettings = pgTable("app_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Vlastní (adminem upravené) verze promptů. Vestavěné verze žijí v kódu
// (src/server/ai/prompts) a slouží jako fallback; zde uložené verze je
// rozšiřují a lze je vybrat jako aktivní stejně jako vestavěné.
export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: text("version").notNull().unique(),
  description: text("description").notNull().default(""),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const indexingJobs = pgTable("indexing_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // CASCADE: smazání dokumentu odstraní i jeho indexovací joby.
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  jobType: text("job_type").notNull().default("reindex"),
  // Pokud true, worker po extrakci textu spustí AI klasifikaci (typ/kategorie/
  // název/štítky) a výsledek uloží do dokumentu. Používá hromadný import (2C).
  autoClassify: boolean("auto_classify").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Hromadný import na pozadí (1A): celý upload se uloží na disk, založí se zde
// job a okamžitě se vrátí odpověď; samostatný worker pak archivy rozbalí a
// soubory založí, aby dlouhé zpracování neshodilo HTTP požadavek na reverzní
// proxy (chyba 502). Počítadla slouží k zobrazení průběhu v UI.
export const bulkImportJobs = pgTable("bulk_import_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("queued"), // queued|processing|completed|failed
  createdByUserId: uuid("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  autoClassify: boolean("auto_classify").notNull().default(false),
  // [{ path, originalName }] – dočasné soubory na disku, worker je po zpracování maže.
  sources: jsonb("sources").notNull(),
  totalFiles: integer("total_files").notNull().default(0),
  processedFiles: integer("processed_files").notNull().default(0),
  accepted: integer("accepted").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  limitReached: boolean("limit_reached").notNull().default(false),
  skipped: jsonb("skipped"), // [{ fileName, reason }]
  errors: jsonb("errors"), // [{ fileName, error }]
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webSearchCache = pgTable("web_search_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  query: text("query").notNull(),
  provider: text("provider").notNull(),
  resultsJson: jsonb("results_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const webCitations = pgTable("web_citations", {
  id: uuid("id").primaryKey().defaultRandom(),
  // CASCADE: smazání zprávy odstraní web citace v ní.
  chatMessageId: uuid("chat_message_id")
    .notNull()
    .references(() => chatMessages.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  url: text("url").notNull(),
  domain: text("domain").notNull(),
  snippet: text("snippet"),
  accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  isOfficialSource: boolean("is_official_source").notNull().default(false),
  sourceType: text("source_type").notNull().default("other"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
