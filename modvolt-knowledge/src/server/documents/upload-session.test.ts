import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUploadSession,
  readUploadSession,
  writeChunk,
  receivedChunks,
  assembleFile,
  deleteUploadSession,
  cleanupStaleUploadSessions,
  UPLOAD_SESSION_DIR,
} from "./upload-session.js";

function uid(): string {
  return `test-${Math.random().toString(36).slice(2)}`;
}

test("upload session: chunky se spojí do souboru ve správném pořadí", async () => {
  const uploadId = uid();
  const parts = [Buffer.from("Ahoj "), Buffer.from("svete "), Buffer.from("!")];
  const size = parts.reduce((n, p) => n + p.length, 0);
  await createUploadSession({
    uploadId,
    userId: "u1",
    autoClassify: false,
    createdAt: Date.now(),
    files: [{ name: "a.txt", size }],
  });
  try {
    // Nahrání mimo pořadí – assembleFile musí spojit podle indexu.
    await writeChunk(uploadId, 0, 2, parts[2]);
    await writeChunk(uploadId, 0, 0, parts[0]);
    await writeChunk(uploadId, 0, 1, parts[1]);

    assert.deepEqual(await receivedChunks(uploadId, 0), [0, 1, 2]);

    const dir = await mkdtemp(join(tmpdir(), "upload-session-out-"));
    const dest = join(dir, "out.txt");
    const total = await assembleFile(uploadId, 0, dest);
    assert.equal(total, size);
    assert.equal(await readFile(dest, "utf8"), "Ahoj svete !");
    // Části se po spojení smažou.
    assert.deepEqual(await receivedChunks(uploadId, 0), []);
    await rm(dir, { recursive: true, force: true });
  } finally {
    await deleteUploadSession(uploadId);
  }
});

test("upload session: opakované zaslání části je idempotentní", async () => {
  const uploadId = uid();
  await createUploadSession({
    uploadId,
    userId: "u1",
    autoClassify: false,
    createdAt: Date.now(),
    files: [{ name: "a.txt", size: 3 }],
  });
  try {
    await writeChunk(uploadId, 0, 0, Buffer.from("xxx"));
    await writeChunk(uploadId, 0, 0, Buffer.from("abc")); // přepis
    assert.deepEqual(await receivedChunks(uploadId, 0), [0]);
    const dir = await mkdtemp(join(tmpdir(), "upload-session-out-"));
    const dest = join(dir, "out.txt");
    await assembleFile(uploadId, 0, dest);
    assert.equal(await readFile(dest, "utf8"), "abc");
    await rm(dir, { recursive: true, force: true });
  } finally {
    await deleteUploadSession(uploadId);
  }
});

test("upload session: chybějící část vyhodí chybu", async () => {
  const uploadId = uid();
  await createUploadSession({
    uploadId,
    userId: "u1",
    autoClassify: false,
    createdAt: Date.now(),
    files: [{ name: "a.txt", size: 6 }],
  });
  try {
    await writeChunk(uploadId, 0, 0, Buffer.from("abc"));
    // index 1 chybí
    await writeChunk(uploadId, 0, 2, Buffer.from("ghi"));
    const dir = await mkdtemp(join(tmpdir(), "upload-session-out-"));
    const dest = join(dir, "out.txt");
    await assert.rejects(() => assembleFile(uploadId, 0, dest), /Chybí část 1/);
    await rm(dir, { recursive: true, force: true });
  } finally {
    await deleteUploadSession(uploadId);
  }
});

test("upload session: cleanup smaže staré relace, ponechá čerstvé", async () => {
  const oldId = uid();
  const freshId = uid();
  await createUploadSession({
    uploadId: oldId,
    userId: "u1",
    autoClassify: false,
    createdAt: Date.now() - 48 * 60 * 60 * 1000,
    files: [{ name: "a.txt", size: 1 }],
  });
  await createUploadSession({
    uploadId: freshId,
    userId: "u1",
    autoClassify: false,
    createdAt: Date.now(),
    files: [{ name: "b.txt", size: 1 }],
  });
  try {
    await cleanupStaleUploadSessions(24 * 60 * 60 * 1000);
    assert.equal(await readUploadSession(oldId), null);
    assert.notEqual(await readUploadSession(freshId), null);
    // Adresář starší relace musí zmizet.
    const entries = await readdir(UPLOAD_SESSION_DIR).catch(
      () => [] as string[],
    );
    assert.equal(entries.includes(oldId), false);
  } finally {
    await deleteUploadSession(oldId);
    await deleteUploadSession(freshId);
  }
});
