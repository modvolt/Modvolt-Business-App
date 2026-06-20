import dotenv from "dotenv";

dotenv.config();

function str(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  nodeEnv: str("NODE_ENV", "development"),
  isProduction: str("NODE_ENV", "development") === "production",
  port: num("PORT", 3000),
  appBaseUrl: str("APP_BASE_URL", ""),
  logLevel: str("LOG_LEVEL", "info"),

  databaseUrl: str("DATABASE_URL"),
  sessionSecret: str("SESSION_SECRET", "insecure-dev-secret-change-me"),
  // Řízení session cookie. Výchozí "lax" + secure dle NODE_ENV je vhodné pro
  // běžné nasazení na vlastní doméně (Hetzner/Coolify). Pokud aplikace běží
  // vložená v cross-site iframe (např. náhled na platformě), je nutné nastavit
  // COOKIE_SAMESITE=none a COOKIE_SECURE=true, jinak prohlížeč cookie neuloží.
  cookieSameSite: str("COOKIE_SAMESITE", "lax").toLowerCase(),
  cookieSecure: bool("COOKIE_SECURE", str("NODE_ENV", "development") === "production"),

  s3: {
    endpoint: str("S3_ENDPOINT"),
    publicEndpoint: str("S3_PUBLIC_ENDPOINT"),
    region: str("S3_REGION", "us-east-1"),
    bucket: str("S3_BUCKET"),
    accessKeyId: str("S3_ACCESS_KEY_ID"),
    secretAccessKey: str("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: bool("S3_FORCE_PATH_STYLE", true),
  },

  openai: {
    apiKey: str("OPENAI_API_KEY"),
    embeddingModel: str("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    chatModel: str("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
    visionModel: str("OPENAI_VISION_MODEL", "gpt-4o-mini"),
    enabled: bool("OPENAI_ENABLED", false),
    imageAnalysisEnabled: bool("OPENAI_IMAGE_ANALYSIS_ENABLED", false),
    maxContextChunks: num("OPENAI_MAX_CONTEXT_CHUNKS", 8),
    maxUploadMb: num("OPENAI_MAX_UPLOAD_MB", 50),
    requestTimeoutMs: num("OPENAI_REQUEST_TIMEOUT_MS", 60000),
  },

  image: {
    maxUploadMb: num("MAX_IMAGE_UPLOAD_MB", 15),
    stripExif: bool("STRIP_IMAGE_EXIF", true),
  },

  webSearch: {
    enabled: bool("WEB_SEARCH_ENABLED", false),
    provider: str("WEB_SEARCH_PROVIDER"),
    apiKey: str("WEB_SEARCH_API_KEY"),
    maxResults: num("WEB_SEARCH_MAX_RESULTS", 5),
    timeoutMs: num("WEB_SEARCH_TIMEOUT_MS", 10000),
  },

  admin: {
    email: str("ADMIN_EMAIL"),
    password: str("ADMIN_PASSWORD"),
    name: str("ADMIN_NAME", "Administrátor"),
  },
};

export const APP_VERSION = "1.0.0";

const INSECURE_SESSION_SECRET = "insecure-dev-secret-change-me";

/**
 * Ověří kritickou konfiguraci. V produkci selže rychle, pokud chybí
 * databáze nebo je použit nezabezpečený výchozí SESSION_SECRET.
 */
export function validateEnv(): void {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL není nastaveno.");
  }
  if (env.isProduction) {
    if (
      !env.sessionSecret ||
      env.sessionSecret === INSECURE_SESSION_SECRET ||
      env.sessionSecret.length < 16
    ) {
      throw new Error(
        "V produkci musí být nastaven bezpečný SESSION_SECRET (alespoň 16 znaků).",
      );
    }
  }
}

/** Vrací true, pokud je OpenAI prakticky použitelná (klíč + povoleno). */
export function isOpenAiUsable(): boolean {
  return env.openai.enabled && env.openai.apiKey.length > 0;
}

export function isVisionUsable(): boolean {
  return (
    isOpenAiUsable() &&
    env.openai.imageAnalysisEnabled &&
    env.openai.visionModel.length > 0
  );
}

export function isS3Configured(): boolean {
  const s = env.s3;
  return Boolean(
    s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey,
  );
}

export function isWebSearchUsable(): boolean {
  return (
    env.webSearch.enabled &&
    env.webSearch.provider.length > 0 &&
    env.webSearch.apiKey.length > 0
  );
}
