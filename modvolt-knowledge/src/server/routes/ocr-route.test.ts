import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { SessionUser } from "../../shared/types.js";

// --- Ovladatelný stav sdílený mezi mocky a jednotlivými testy --------------
// document-routes.ts má při importu vedlejší efekty (db pool, audit, worker),
// proto je tyto moduly nahrazeny lehkými atrapami. Stav je mutovatelný, takže
// každý test si nastaví vlastní podmínky (OCR zapnuto/vypnuto, řádky dokumentu)
// a ověří vedlejší efekty (zařazení úlohy do fronty, zápis do audit logu).
let ocrUsable = true;
let docRows: Array<Record<string, unknown>> = [];
const enqueued: Array<{ id: string; kind: string }> = [];
const audited: Array<{ action: string; entityType: string; entityId?: string }> = [];

// Řetězitelná atrapa drizzle dotazu: select().from().where().limit() -> řádky.
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(docRows),
      }),
    }),
  }),
};

const realEnv = await import("../env.js");

mock.module("../db/index.js", {
  namedExports: { db: fakeDb, schema: {}, pool: {} },
});
mock.module("../indexing/worker.js", {
  namedExports: {
    enqueueDocument: async (id: string, kind: string) => {
      enqueued.push({ id, kind });
    },
    startIndexingWorker: () => {},
    stopIndexingWorker: () => {},
  },
});
mock.module("../lib/audit.js", {
  namedExports: {
    audit: async (
      _req: unknown,
      action: string,
      entityType: string,
      entityId?: string,
    ) => {
      audited.push({ action, entityType, entityId });
    },
  },
});
mock.module("../env.js", {
  namedExports: {
    ...realEnv,
    isOcrUsable: () => ocrUsable,
  },
});

const { documentRouter } = await import("./document-routes.js");

// Pomocné: dokument, který projde kontrolou typu (PDF), resp. neprojde.
const pdfDoc = {
  id: "doc-pdf",
  mimeType: "application/pdf",
  originalFileName: "norma.pdf",
  visibility: "all_users",
  uploadedByUserId: "user-1",
};
const nonPdfDoc = {
  id: "doc-img",
  mimeType: "image/png",
  originalFileName: "sken.png",
  visibility: "all_users",
  uploadedByUserId: "user-1",
};

const admin: SessionUser = {
  id: "admin-1",
  name: "Admin",
  email: "admin@example.com",
  role: "admin",
};
const readOnly: SessionUser = {
  id: "ro-1",
  name: "ReadOnly",
  email: "ro@example.com",
  role: "read_only",
};

// Postaví minimální Express app: vloží daného uživatele a připojí router.
// Vrací base URL běžícího serveru (na náhodném portu) a funkci pro vypnutí.
async function startApp(currentUser: SessionUser | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentUser) req.currentUser = currentUser;
    next();
  });
  app.use(documentRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function postOcr(currentUser: SessionUser | null, id: string) {
  const { base, close } = await startApp(currentUser);
  try {
    const res = await fetch(`${base}/${id}/ocr`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await close();
  }
}

beforeEach(() => {
  ocrUsable = true;
  docRows = [];
  enqueued.length = 0;
  audited.length = 0;
});

test("returns 503 when OCR is disabled (no job queued)", async () => {
  ocrUsable = false;
  docRows = [pdfDoc];
  const res = await postOcr(admin, "doc-pdf");
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "OCR není povolené.");
  assert.equal(enqueued.length, 0);
  assert.equal(audited.length, 0);
});

test("returns 400 for a non-PDF document (no job queued)", async () => {
  docRows = [nonPdfDoc];
  const res = await postOcr(admin, "doc-img");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "OCR je dostupné jen pro PDF dokumenty.");
  assert.equal(enqueued.length, 0);
  assert.equal(audited.length, 0);
});

test("success path enqueues an 'ocr' job and writes an audit entry", async () => {
  docRows = [pdfDoc];
  const res = await postOcr(admin, "doc-pdf");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(enqueued, [{ id: "doc-pdf", kind: "ocr" }]);
  assert.equal(audited.length, 1);
  assert.deepEqual(audited[0], {
    action: "ocr",
    entityType: "document",
    entityId: "doc-pdf",
  });
});

test("requires write access: read_only user is rejected with 403 (no job queued)", async () => {
  docRows = [pdfDoc];
  const res = await postOcr(readOnly, "doc-pdf");
  assert.equal(res.status, 403);
  assert.equal(enqueued.length, 0);
  assert.equal(audited.length, 0);
});

test("requires authentication: anonymous request is rejected with 401", async () => {
  docRows = [pdfDoc];
  const res = await postOcr(null, "doc-pdf");
  assert.equal(res.status, 401);
  assert.equal(enqueued.length, 0);
});

test("returns 404 when the document does not exist (no job queued)", async () => {
  docRows = [];
  const res = await postOcr(admin, "missing");
  assert.equal(res.status, 404);
  assert.equal(enqueued.length, 0);
  assert.equal(audited.length, 0);
});
