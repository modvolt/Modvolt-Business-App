import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { SessionUser } from "../../shared/types.js";

// --- Ovladatelný stav sdílený mezi mocky a testy ---------------------------
// document-routes.ts má při importu vedlejší efekty (db pool, audit, worker,
// úložiště, document-service), proto jsou tyto moduly nahrazeny lehkými
// atrapami. Stav je mutovatelný, takže si každý test nastaví vlastní podmínky
// (řádky dokumentu, dostupnost úložiště) a ověří vedlejší efekty (zařazení do
// fronty, zápis do audit logu, smazání, vydání předpodepsané URL).
let docRows: Array<Record<string, unknown>> = [];
let downloadShouldFail = false;
let downloadUrl = "https://signed.example/object?token=abc";
const enqueued: Array<{ id: string; kind: string }> = [];
const audited: Array<{ action: string; entityType: string; entityId?: string }> = [];
const deleted: string[] = [];
const downloadArgs: Array<{ key: string; expires: number }> = [];

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
const realDocService = await import("../documents/document-service.js");
const realS3 = await import("../storage/s3.js");

const { mock } = await import("node:test");

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
mock.module("../env.js", { namedExports: { ...realEnv } });
mock.module("../storage/s3.js", {
  namedExports: {
    ...realS3,
    getDownloadUrl: async (key: string, expires: number) => {
      downloadArgs.push({ key, expires });
      if (downloadShouldFail) throw new Error("storage down");
      return downloadUrl;
    },
  },
});
mock.module("../documents/document-service.js", {
  namedExports: {
    ...realDocService,
    deleteDocument: async (id: string) => {
      deleted.push(id);
    },
  },
});

const { documentRouter } = await import("./document-routes.js");

// Dokument viditelný všem (typický cíl reindex/download/delete).
const publicDoc = {
  id: "doc-1",
  mimeType: "application/pdf",
  originalFileName: "norma.pdf",
  objectPath: "documents/doc-1.pdf",
  visibility: "all_users",
  uploadedByUserId: "user-1",
};
// Dokument jen pro adminy (ne-admin nesmí ani číst/stahovat).
const adminOnlyDoc = {
  ...publicDoc,
  id: "doc-admin",
  visibility: "admin_only",
};

const admin: SessionUser = {
  id: "admin-1",
  name: "Admin",
  email: "admin@example.com",
  role: "admin",
};
const writer: SessionUser = {
  id: "user-1",
  name: "Writer",
  email: "writer@example.com",
  role: "user",
};
const readOnly: SessionUser = {
  id: "ro-1",
  name: "ReadOnly",
  email: "ro@example.com",
  role: "read_only",
};

// Postaví minimální Express app: vloží daného uživatele a připojí router.
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

async function call(
  currentUser: SessionUser | null,
  method: string,
  path: string,
) {
  const { base, close } = await startApp(currentUser);
  try {
    const res = await fetch(`${base}${path}`, { method });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await close();
  }
}

beforeEach(() => {
  docRows = [];
  downloadShouldFail = false;
  downloadUrl = "https://signed.example/object?token=abc";
  enqueued.length = 0;
  audited.length = 0;
  deleted.length = 0;
  downloadArgs.length = 0;
});

// --- POST /:id/reindex -----------------------------------------------------

test("reindex: success enqueues a 'reindex' job and writes an audit entry", async () => {
  docRows = [publicDoc];
  const res = await call(admin, "POST", "/doc-1/reindex");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(enqueued, [{ id: "doc-1", kind: "reindex" }]);
  assert.equal(audited.length, 1);
  assert.deepEqual(audited[0], {
    action: "reindex",
    entityType: "document",
    entityId: "doc-1",
  });
});

test("reindex: returns 404 when the document does not exist (no job queued)", async () => {
  docRows = [];
  const res = await call(admin, "POST", "/missing/reindex");
  assert.equal(res.status, 404);
  assert.equal(enqueued.length, 0);
  assert.equal(audited.length, 0);
});

test("reindex: read_only user is rejected with 403 (no job queued)", async () => {
  docRows = [publicDoc];
  const res = await call(readOnly, "POST", "/doc-1/reindex");
  assert.equal(res.status, 403);
  assert.equal(enqueued.length, 0);
  assert.equal(audited.length, 0);
});

test("reindex: non-admin cannot reindex an admin_only document (403, no job queued)", async () => {
  docRows = [adminOnlyDoc];
  const res = await call(writer, "POST", "/doc-admin/reindex");
  assert.equal(res.status, 403);
  assert.equal(enqueued.length, 0);
  assert.equal(audited.length, 0);
});

test("reindex: anonymous request is rejected with 401", async () => {
  docRows = [publicDoc];
  const res = await call(null, "POST", "/doc-1/reindex");
  assert.equal(res.status, 401);
  assert.equal(enqueued.length, 0);
});

// --- GET /:id/download -----------------------------------------------------

test("download: success returns a signed URL and writes an audit entry", async () => {
  docRows = [publicDoc];
  const res = await call(admin, "GET", "/doc-1/download");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { url: downloadUrl });
  assert.deepEqual(downloadArgs, [{ key: "documents/doc-1.pdf", expires: 300 }]);
  assert.equal(audited.length, 1);
  assert.deepEqual(audited[0], {
    action: "download",
    entityType: "document",
    entityId: "doc-1",
  });
});

test("download: returns 404 when the document does not exist", async () => {
  docRows = [];
  const res = await call(admin, "GET", "/missing/download");
  assert.equal(res.status, 404);
  assert.equal(downloadArgs.length, 0);
  assert.equal(audited.length, 0);
});

test("download: non-admin gets 403 for an admin_only document (no URL, no audit)", async () => {
  docRows = [adminOnlyDoc];
  const res = await call(writer, "GET", "/doc-admin/download");
  assert.equal(res.status, 403);
  assert.equal(downloadArgs.length, 0);
  assert.equal(audited.length, 0);
});

test("download: returns 503 when storage is unavailable (no audit)", async () => {
  docRows = [publicDoc];
  downloadShouldFail = true;
  const res = await call(admin, "GET", "/doc-1/download");
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "Úložiště není dostupné.");
  assert.equal(audited.length, 0);
});

test("download: anonymous request is rejected with 401", async () => {
  docRows = [publicDoc];
  const res = await call(null, "GET", "/doc-1/download");
  assert.equal(res.status, 401);
  assert.equal(downloadArgs.length, 0);
});

// --- DELETE /:id -----------------------------------------------------------

test("delete: admin success deletes the document and writes an audit entry", async () => {
  const res = await call(admin, "DELETE", "/doc-1");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(deleted, ["doc-1"]);
  assert.equal(audited.length, 1);
  assert.deepEqual(audited[0], {
    action: "delete",
    entityType: "document",
    entityId: "doc-1",
  });
});

test("delete: non-admin 'user' is rejected with 403 (nothing deleted)", async () => {
  const res = await call(writer, "DELETE", "/doc-1");
  assert.equal(res.status, 403);
  assert.equal(deleted.length, 0);
  assert.equal(audited.length, 0);
});

test("delete: read_only user is rejected with 403 (nothing deleted)", async () => {
  const res = await call(readOnly, "DELETE", "/doc-1");
  assert.equal(res.status, 403);
  assert.equal(deleted.length, 0);
  assert.equal(audited.length, 0);
});

test("delete: anonymous request is rejected with 401 (nothing deleted)", async () => {
  const res = await call(null, "DELETE", "/doc-1");
  assert.equal(res.status, 401);
  assert.equal(deleted.length, 0);
});
