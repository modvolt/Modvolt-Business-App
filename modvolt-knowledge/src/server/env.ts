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

/**
 * Doplní schéma k S3 endpointu, pokud chybí. Mnoho poskytovatelů
 * (např. Hetzner Object Storage) uvádí endpoint bez "https://"
 * (např. "fsn1.your-objectstorage.com") a AWS SDK pak hlásí "Invalid URL".
 */
function normalizeEndpoint(value: string): string {
  const v = value.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

// Jeden OpenAI API klíč pro všechny modely (chat, klasifikaci, embeddingy
// i vizi). Pro jiného OpenAI-kompatibilního poskytovatele lze přesměrovat
// endpoint přes OPENAI_BASE_URL níže.
const openaiApiKey = str("OPENAI_API_KEY");

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
    endpoint: normalizeEndpoint(str("S3_ENDPOINT")),
    publicEndpoint: normalizeEndpoint(str("S3_PUBLIC_ENDPOINT")),
    region: str("S3_REGION", "us-east-1"),
    bucket: str("S3_BUCKET"),
    accessKeyId: str("S3_ACCESS_KEY_ID"),
    secretAccessKey: str("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: bool("S3_FORCE_PATH_STYLE", true),
  },

  openai: {
    // Jeden klíč pro všechny modely.
    apiKey: openaiApiKey,
    // Volitelný OpenAI-kompatibilní endpoint. Prázdné = výchozí api.openai.com.
    baseUrl: normalizeEndpoint(str("OPENAI_BASE_URL", "")),
    // Jeden chat model obsluhuje chat, klasifikaci i popis fotek (pro analýzu
    // obrázků musí být multimodální). Embeddingy vyžadují samostatný embedding
    // model – chat model embeddingy spočítat neumí.
    chatModel: str("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
    embeddingModel: str("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    enabled: bool("OPENAI_ENABLED", false),
    imageAnalysisEnabled: bool("OPENAI_IMAGE_ANALYSIS_ENABLED", false),
    maxContextChunks: num("OPENAI_MAX_CONTEXT_CHUNKS", 8),
    maxUploadMb: num("OPENAI_MAX_UPLOAD_MB", 15),
    requestTimeoutMs: num("OPENAI_REQUEST_TIMEOUT_MS", 60000),
    // Počet opakování při přechodných síťových chybách (např. "Premature close").
    // Týká se embeddingů i chatu. Omezeno 0–10.
    maxRetries: Math.max(0, Math.min(10, num("OPENAI_MAX_RETRIES", 4))),
    // Velikost dávky pro embeddingy. Menší dávka = menší request/response a nižší
    // pravděpodobnost přerušení spojení na nestabilní síti.
    embeddingBatchSize: num("OPENAI_EMBEDDING_BATCH_SIZE", 16),
  },

  image: {
    maxUploadMb: num("MAX_IMAGE_UPLOAD_MB", 15),
    // STRIP_IMAGE_EXIF je zachován pro zpětnou kompatibilitu v konfiguraci,
    // ale nemá efekt — EXIF je vždy odstraněn (viz image-processing.ts).
    stripExif: bool("STRIP_IMAGE_EXIF", true),
  },

  upload: {
    // Maximální počet souborů v jedné dávce (hromadný import).
    maxBatchFiles: num("MAX_BATCH_FILES", 10),
    // Maximální velikost ZIP archivu v MB.
    maxZipMb: num("MAX_ZIP_MB", 100),
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

/** OpenAI je použitelné, je-li povolené a je nastaven API klíč. */
export function isOpenAiUsable(): boolean {
  return env.openai.enabled && env.openai.apiKey.length > 0;
}

/** Chat, klasifikace i popis fotek – vše běží na jednom klíči a chat modelu. */
export function isChatUsable(): boolean {
  return isOpenAiUsable();
}

/** Embeddingy (indexace) běží na stejném klíči, ale embedding modelu. */
export function isEmbeddingsUsable(): boolean {
  return isOpenAiUsable();
}

/** Vize navíc vyžaduje zapnutou analýzu obrázků (a multimodální chat model). */
export function isVisionUsable(): boolean {
  return isOpenAiUsable() && env.openai.imageAnalysisEnabled;
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
