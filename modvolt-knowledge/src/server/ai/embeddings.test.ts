import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- Co testujeme ----------------------------------------------------------
// Embeddingová vrstva má vlastní opakování (isRetryable + withRetry): přechodné
// síťové chyby ("Premature close", ECONNRESET, timeout, 429, 5xx) se opakují s
// backoffem až do env.openai.maxRetries, kdežto konfigurační/„bad request" chyby
// (4xx kromě 429) se vyhodí hned bez dalších pokusů. Mockujeme OpenAI klienta,
// takže žádné reálné síťové volání neproběhne, a neutralizujeme backoff (0 ms),
// aby testy běžely rychle.

// Backoff bez čekání: deleguj na reálný setTimeout, ale s nulovým zpožděním.
// Zachová asynchronní semantiku časovačů, jen vynuluje sekundové prodlevy.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
  realSetTimeout(fn, 0, ...args)) as typeof globalThis.setTimeout;

// Kolik pokusů povolíme nad rámec prvního (env.openai.maxRetries).
let maxRetries = 3;
// Počítadlo skutečných volání embeddings.create (= počet pokusů).
let createCalls = 0;
// Chování jednoho pokusu: pro dané číslo pokusu (0-based) buď vyhodí, nebo vrátí
// úspěšnou odpověď ve tvaru, jaký createEmbeddings očekává.
let onCreate: (attempt: number) => Promise<{ data: { embedding: number[] }[] }>;

mock.module("./openai-client.js", {
  namedExports: {
    getOpenAi: () => ({
      embeddings: {
        create: (args: { input: string[] }) => {
          const attempt = createCalls;
          createCalls += 1;
          return onCreate(attempt).then((res) =>
            // Když test nevrátí explicitní data, dopočti je podle počtu vstupů.
            res.data
              ? res
              : { data: args.input.map(() => ({ embedding: [0.1, 0.2] })) },
          );
        },
      },
    }),
  },
});

mock.module("../env.js", {
  namedExports: {
    env: {
      openai: {
        get maxRetries() {
          return maxRetries;
        },
        embeddingModel: "text-embedding-3-small",
      },
    },
    isEmbeddingsUsable: () => true,
  },
});

mock.module("../lib/logger.js", {
  namedExports: {
    logger: { info() {}, warn() {}, error() {} },
  },
});

const { createEmbeddings } = await import("./embeddings.js");

// Sestaví chybu s volitelným name/status/message (napodobuje OpenAI SDK chyby).
function makeError(opts: { name?: string; status?: number; message?: string }): Error {
  const e = new Error(opts.message ?? "boom") as Error & { status?: number };
  if (opts.name) e.name = opts.name;
  if (opts.status !== undefined) e.status = opts.status;
  return e;
}

// Vyhoď zadanou chybu na prvních `failTimes` pokusech, pak vrať úspěch.
function failThenSucceed(failTimes: number, error: Error) {
  return (attempt: number) =>
    attempt < failTimes
      ? Promise.reject(error)
      : Promise.resolve({ data: [{ embedding: [0.1, 0.2] }] });
}

beforeEach(() => {
  maxRetries = 3;
  createCalls = 0;
  onCreate = () => Promise.resolve({ data: [{ embedding: [0.1, 0.2] }] });
});

// --- Přechodné chyby se opakují --------------------------------------------

test("zpráva 'Premature close' se opakuje a nakonec uspěje", async () => {
  onCreate = failThenSucceed(2, makeError({ message: "Premature close" }));

  const res = await createEmbeddings(["a"]);

  // Dva pády + třetí úspěšný pokus.
  assert.equal(createCalls, 3);
  assert.deepEqual(res, [[0.1, 0.2]]);
});

test("429 (rate limit) se opakuje a nakonec uspěje", async () => {
  onCreate = failThenSucceed(1, makeError({ status: 429, message: "Too Many Requests" }));

  const res = await createEmbeddings(["a"]);

  assert.equal(createCalls, 2);
  assert.deepEqual(res, [[0.1, 0.2]]);
});

test("5xx (chyba serveru) se opakuje a nakonec uspěje", async () => {
  onCreate = failThenSucceed(2, makeError({ status: 503, message: "Service Unavailable" }));

  const res = await createEmbeddings(["a"]);

  assert.equal(createCalls, 3);
  assert.deepEqual(res, [[0.1, 0.2]]);
});

test("ECONNRESET se opakuje a nakonec uspěje", async () => {
  onCreate = failThenSucceed(1, makeError({ message: "read ECONNRESET" }));

  const res = await createEmbeddings(["a"]);

  assert.equal(createCalls, 2);
  assert.deepEqual(res, [[0.1, 0.2]]);
});

test("trvalá přechodná chyba se opakuje až do maxRetries a pak vyhodí poslední chybu", async () => {
  maxRetries = 2;
  const lastError = makeError({ name: "APIConnectionError", message: "fetch failed" });
  onCreate = () => Promise.reject(lastError);

  await assert.rejects(createEmbeddings(["a"]), (e) => e === lastError);

  // První pokus + 2 opakování = 3 volání celkem.
  assert.equal(createCalls, 3);
});

// --- Konfigurační / bad-request chyby se neopakují --------------------------

test("400 (bad request) se vyhodí hned bez opakování", async () => {
  onCreate = () => Promise.reject(makeError({ status: 400, message: "Bad Request" }));

  await assert.rejects(createEmbeddings(["a"]), /Bad Request/);

  assert.equal(createCalls, 1);
});

test("401 (neautorizováno) se vyhodí hned bez opakování", async () => {
  onCreate = () => Promise.reject(makeError({ status: 401, message: "Unauthorized" }));

  await assert.rejects(createEmbeddings(["a"]), /Unauthorized/);

  assert.equal(createCalls, 1);
});

test("403 (zakázáno) se vyhodí hned bez opakování", async () => {
  onCreate = () => Promise.reject(makeError({ status: 403, message: "Forbidden" }));

  await assert.rejects(createEmbeddings(["a"]), /Forbidden/);

  assert.equal(createCalls, 1);
});

// --- Drobnost: prázdný vstup nevolá API ------------------------------------

test("prázdný vstup nevyvolá žádné volání API", async () => {
  const res = await createEmbeddings([]);

  assert.deepEqual(res, []);
  assert.equal(createCalls, 0);
});
