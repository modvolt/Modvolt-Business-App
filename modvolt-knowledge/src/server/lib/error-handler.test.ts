import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

// Zachytíme logy, abychom mohli ověřit, že se incidentId zaloguje a že se
// neočekávané chyby logují přes logger.error (s detailem/stackem), zatímco
// operační chyby přes logger.warn.
const warnCalls: Array<{ msg: string; meta: unknown }> = [];
const errorCalls: Array<{ msg: string; meta: unknown }> = [];

mock.module("./logger.js", {
  namedExports: {
    logger: {
      warn: (msg: string, meta?: unknown) => warnCalls.push({ msg, meta }),
      error: (msg: string, meta?: unknown) => errorCalls.push({ msg, meta }),
      info: () => {},
      debug: () => {},
    },
  },
});

const { apiErrorHandler } = await import("./error-handler.js");
const { BadRequestError } = await import("./errors.js");

interface FakeRes {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function makeReq(): Request {
  return { method: "POST", originalUrl: "/api/documents" } as unknown as Request;
}

function makeRes(headersSent = false): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    headersSent,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  warnCalls.length = 0;
  errorCalls.length = 0;
});

test("operační chyba: konkrétní status + hláška, logováno jako warn, žádný incidentId", () => {
  const res = makeRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  apiErrorHandler(
    new BadRequestError("Neplatná metadata dávky."),
    makeReq(),
    res as unknown as Response,
    next,
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Neplatná metadata dávky." });
  assert.equal(nextCalled, false);
  assert.equal(warnCalls.length, 1);
  assert.equal(errorCalls.length, 0);
  // Operační hláška se NEdoplňuje o kód incidentu.
  assert.equal((res.body as { incidentId?: string }).incidentId, undefined);
});

test("neočekávaná chyba: obecná hláška + incidentId, neúniká stack/detail", () => {
  const res = makeRes();
  const leak = new Error("connect ECONNREFUSED 127.0.0.1:5432");
  leak.stack = "Error: connect ECONNREFUSED\n    at Socket.emit (node:events)";

  apiErrorHandler(leak, makeReq(), res as unknown as Response, () => {});

  assert.equal(res.statusCode, 500);
  const body = res.body as { error: string; incidentId: string };
  assert.match(body.error, /^Interní chyba serveru\. \(kód incidentu: [0-9a-f]{8}\)$/);
  assert.match(body.incidentId, /^[0-9a-f]{8}$/);

  // Hláška ani odpověď nesmí prozradit interní detail/stack.
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /ECONNREFUSED/);
  assert.doesNotMatch(serialized, /Socket\.emit/);
  assert.equal(serialized.includes("stack"), false);

  // incidentId v odpovědi se musí shodovat s tím v logu (spárování s logem).
  assert.equal(errorCalls.length, 1);
  assert.equal(warnCalls.length, 0);
  const meta = errorCalls[0].meta as { incidentId: string; stack?: string };
  assert.equal(meta.incidentId, body.incidentId);
  // Log naopak detail/stack obsahovat má (pro dohledání).
  assert.ok(meta.stack && meta.stack.includes("ECONNREFUSED"));
});

test("incidentId je pokaždé jiný", () => {
  const a = makeRes();
  const b = makeRes();
  apiErrorHandler(new Error("boom A"), makeReq(), a as unknown as Response, () => {});
  apiErrorHandler(new Error("boom B"), makeReq(), b as unknown as Response, () => {});
  const idA = (a.body as { incidentId: string }).incidentId;
  const idB = (b.body as { incidentId: string }).incidentId;
  assert.notEqual(idA, idB);
});

test("headersSent: deleguje na next a neposílá další odpověď", () => {
  const res = makeRes(true);
  let forwarded: unknown = null;
  const err = new BadRequestError("Pozdě.");

  apiErrorHandler(err, makeReq(), res as unknown as Response, (e?: unknown) => {
    forwarded = e;
  });

  assert.equal(res.statusCode, 0);
  assert.equal(res.body, undefined);
  assert.equal(forwarded, err);
});
