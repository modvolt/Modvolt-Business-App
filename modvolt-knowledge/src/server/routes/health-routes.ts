import { createRouter } from "../lib/async-router.js";
import { pool } from "../db/index.js";
import { checkS3Health } from "../storage/s3.js";
import {
  isOpenAiUsable,
  isVisionUsable,
  isWebSearchUsable,
  isS3Configured,
} from "../env.js";
import { APP_VERSION } from "../env.js";
import { webSearchAvailable } from "../search/web-search-service.js";

export const healthRouter = createRouter();

healthRouter.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const s3Ok = isS3Configured() ? await checkS3Health() : false;

  const status = dbOk ? "ok" : "degraded";
  res.status(dbOk ? 200 : 503).json({
    status,
    version: APP_VERSION,
    time: new Date().toISOString(),
    checks: {
      database: dbOk,
      s3Configured: isS3Configured(),
      s3Reachable: s3Ok,
      openaiEnabled: isOpenAiUsable(),
      visionEnabled: isVisionUsable(),
      webSearchEnabled: isWebSearchUsable() && webSearchAvailable(),
    },
  });
});
