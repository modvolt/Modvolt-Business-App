DROP INDEX IF EXISTS "documents_sha256_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_sha256_idx" ON "documents" USING btree ("sha256_hash");