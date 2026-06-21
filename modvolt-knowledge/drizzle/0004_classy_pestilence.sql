-- Migrace přidává FK (cizí klíče) s CASCADE/SET NULL do existujícího schématu.
-- Před přidáním omezení odstraníme sirotky (orphan rows), aby ALTER TABLE
-- neselhal na existujících datech.

-- == Cleanup sirotků před přidáním FK ==

-- SET NULL: dokumenty s neexistující kategorií → kategorie = NULL
UPDATE documents SET category_id = NULL
  WHERE category_id IS NOT NULL
    AND category_id NOT IN (SELECT id FROM document_categories);

-- SET NULL: dokumenty nahrané smazaným uživatelem → autor = NULL
UPDATE documents SET uploaded_by_user_id = NULL
  WHERE uploaded_by_user_id IS NOT NULL
    AND uploaded_by_user_id NOT IN (SELECT id FROM users);

-- SET NULL: verze dokumentu nahrané smazaným uživatelem → autor = NULL
UPDATE document_versions SET uploaded_by_user_id = NULL
  WHERE uploaded_by_user_id IS NOT NULL
    AND uploaded_by_user_id NOT IN (SELECT id FROM users);

-- CASCADE sirotci: záznamy odkazující na neexistující rodičovský dokument
DELETE FROM document_embeddings
  WHERE chunk_id NOT IN (SELECT id FROM document_chunks);
DELETE FROM document_chunks
  WHERE document_id NOT IN (SELECT id FROM documents);
DELETE FROM document_versions
  WHERE document_id NOT IN (SELECT id FROM documents);
DELETE FROM document_tag_links
  WHERE document_id NOT IN (SELECT id FROM documents)
     OR tag_id NOT IN (SELECT id FROM document_tags);
DELETE FROM indexing_jobs
  WHERE document_id NOT IN (SELECT id FROM documents);

-- CASCADE sirotci: chat zprávy, sessions, citace
DELETE FROM web_citations
  WHERE chat_message_id NOT IN (SELECT id FROM chat_messages);
DELETE FROM chat_messages
  WHERE session_id NOT IN (SELECT id FROM chat_sessions);
DELETE FROM chat_sessions
  WHERE user_id NOT IN (SELECT id FROM users);

--> statement-breakpoint

-- == Přidání FK constraintů ==

DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_chunk_id_document_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."document_chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_tag_links" ADD CONSTRAINT "document_tag_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_tag_links" ADD CONSTRAINT "document_tag_links_tag_id_document_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."document_tags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_document_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."document_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "indexing_jobs" ADD CONSTRAINT "indexing_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_citations" ADD CONSTRAINT "web_citations_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
