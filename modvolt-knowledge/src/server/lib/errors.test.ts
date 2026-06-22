import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppError,
  BadRequestError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  describeError,
} from "./errors.js";
import { DuplicateDocumentError } from "../documents/document-service.js";
import { PromptStoreError } from "../ai/prompts/prompt-store.js";

// --- Typované chyby: status + expose + zachovaná hláška -------------------

test("BadRequestError → 400, expose, vlastní hláška", () => {
  const err = new BadRequestError("Chybný vstup.");
  assert.equal(err.status, 400);
  assert.equal(err.expose, true);
  assert.equal(err.message, "Chybný vstup.");
  assert.equal(err.name, "BadRequestError");
  assert.ok(err instanceof AppError);
});

test("NotFoundError → 404, expose, vlastní hláška", () => {
  const err = new NotFoundError("Nenalezeno.");
  assert.equal(err.status, 404);
  assert.equal(err.expose, true);
  assert.equal(err.message, "Nenalezeno.");
  assert.equal(err.name, "NotFoundError");
  assert.ok(err instanceof AppError);
});

test("ConflictError → 409, expose, vlastní hláška", () => {
  const err = new ConflictError("Konflikt.");
  assert.equal(err.status, 409);
  assert.equal(err.expose, true);
  assert.equal(err.message, "Konflikt.");
  assert.equal(err.name, "ConflictError");
  assert.ok(err instanceof AppError);
});

test("ServiceUnavailableError → 503, expose, vlastní hláška", () => {
  const err = new ServiceUnavailableError("Úložiště nedostupné.");
  assert.equal(err.status, 503);
  assert.equal(err.expose, true);
  assert.equal(err.message, "Úložiště nedostupné.");
  assert.equal(err.name, "ServiceUnavailableError");
  assert.ok(err instanceof AppError);
});

test("AppError výchozí: 500 + expose", () => {
  const err = new AppError("Něco se pokazilo.");
  assert.equal(err.status, 500);
  assert.equal(err.expose, true);
  assert.equal(err.name, "AppError");
});

test("DuplicateDocumentError → 409, expose, hláška nese existující název", () => {
  const err = new DuplicateDocumentError("doc-123", "Manuál.pdf");
  assert.equal(err.status, 409);
  assert.equal(err.expose, true);
  assert.equal(err.existingDocumentId, "doc-123");
  assert.equal(err.existingTitle, "Manuál.pdf");
  assert.match(err.message, /Manuál\.pdf/);
  assert.equal(err.name, "DuplicateDocumentError");
  assert.ok(err instanceof AppError);
});

test("PromptStoreError kind=conflict → 409", () => {
  const err = new PromptStoreError("Verze už existuje.", "conflict");
  assert.equal(err.status, 409);
  assert.equal(err.expose, true);
  assert.equal(err.kind, "conflict");
  assert.equal(err.message, "Verze už existuje.");
  assert.equal(err.name, "PromptStoreError");
  assert.ok(err instanceof AppError);
});

test("PromptStoreError kind=not_found → 404", () => {
  const err = new PromptStoreError("Verze nenalezena.", "not_found");
  assert.equal(err.status, 404);
  assert.equal(err.expose, true);
  assert.equal(err.kind, "not_found");
  assert.equal(err.message, "Verze nenalezena.");
});

// --- describeError: operační vs. neočekávané -----------------------------

test("describeError propustí operační AppError (status + hláška)", () => {
  const out = describeError(new NotFoundError("Dokument nenalezen."));
  assert.deepEqual(out, {
    status: 404,
    message: "Dokument nenalezen.",
    expose: true,
  });
});

test("describeError propustí i prostý objekt se status + expose + message", () => {
  const out = describeError({ status: 400, expose: true, message: "Špatně." });
  assert.deepEqual(out, { status: 400, message: "Špatně.", expose: true });
});

test("describeError: neočekávaná chyba → 500 + obecná hláška, expose=false", () => {
  const out = describeError(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
  assert.deepEqual(out, {
    status: 500,
    message: "Interní chyba serveru.",
    expose: false,
  });
});

test("describeError nepropustí status bez expose=true", () => {
  const out = describeError({ status: 418, message: "I'm a teapot" });
  assert.equal(out.expose, false);
  assert.equal(out.status, 500);
  assert.equal(out.message, "Interní chyba serveru.");
});

test("describeError nepropustí expose=true s prázdnou hláškou", () => {
  const out = describeError({ status: 400, expose: true, message: "" });
  assert.equal(out.expose, false);
  assert.equal(out.status, 500);
});

test("describeError zvládne null/undefined/string", () => {
  for (const v of [null, undefined, "boom", 42]) {
    const out = describeError(v);
    assert.equal(out.expose, false);
    assert.equal(out.status, 500);
    assert.equal(out.message, "Interní chyba serveru.");
  }
});
