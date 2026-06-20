import type { Request } from "express";
import { db } from "../db/index.js";
import { auditLogs } from "../db/schema.js";
import { logger } from "./logger.js";

export async function audit(
  req: Request,
  action: string,
  entityType: string,
  entityId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      userId: req.currentUser?.id ?? null,
      action,
      entityType,
      entityId: entityId ?? null,
      metadataJson: metadata ?? null,
      ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
  } catch (err) {
    logger.warn("Zápis do audit logu selhal", String(err));
  }
}
