ALTER TABLE "search_queries" ADD COLUMN "csn_lock_triggered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "search_queries" ADD COLUMN "csn_lock_trigger" text;