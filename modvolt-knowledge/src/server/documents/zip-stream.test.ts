import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { streamZipEntries, type StreamedZipEntry } from "./zip-stream.js";

async function makeZip(
  entries: { name: string; content: Buffer }[],
): Promise<string> {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, e.content);
  const dir = await mkdtemp(join(tmpdir(), "zip-stream-test-"));
  const zipPath = join(dir, "archive.zip");
  await writeFile(zipPath, zip.toBuffer());
  return zipPath;
}

async function collect(
  zipPath: string,
  maxEntryBytes: number,
): Promise<{ entries: StreamedZipEntry[]; skipped: { fileName: string; reason: string }[] }> {
  const entries: StreamedZipEntry[] = [];
  const { skipped } = await streamZipEntries(zipPath, { maxEntryBytes }, async (e) => {
    entries.push({ fileName: e.fileName, buffer: e.buffer });
  });
  return { entries, skipped };
}

test("streamZipEntries vrací přijatelné soubory s obsahem", async () => {
  const zipPath = await makeZip([
    { name: "a.txt", content: Buffer.from("ahoj") },
    { name: "slozka/b.md", content: Buffer.from("# nadpis") },
  ]);
  try {
    const { entries, skipped } = await collect(zipPath, 1024 * 1024);
    assert.equal(skipped.length, 0);
    assert.equal(entries.length, 2);
    const byName = Object.fromEntries(entries.map((e) => [e.fileName, e.buffer.toString()]));
    // Vrací se holý název bez cesty.
    assert.equal(byName["a.txt"], "ahoj");
    assert.equal(byName["b.md"], "# nadpis");
  } finally {
    await rm(zipPath, { force: true });
  }
});

test("streamZipEntries přeskočí nepodporované typy", async () => {
  const zipPath = await makeZip([
    { name: "ok.txt", content: Buffer.from("x") },
    { name: "obrazek.png", content: Buffer.from("binarni") },
  ]);
  try {
    const { entries, skipped } = await collect(zipPath, 1024 * 1024);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fileName, "ok.txt");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].fileName, /obrazek\.png$/);
    assert.match(skipped[0].reason, /Nepodporovaný/);
  } finally {
    await rm(zipPath, { force: true });
  }
});

test("streamZipEntries ignoruje skryté soubory a __MACOSX", async () => {
  const zipPath = await makeZip([
    { name: "dobry.txt", content: Buffer.from("x") },
    { name: ".skryty.txt", content: Buffer.from("x") },
    { name: "__MACOSX/._dobry.txt", content: Buffer.from("x") },
  ]);
  try {
    const { entries, skipped } = await collect(zipPath, 1024 * 1024);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fileName, "dobry.txt");
    // Skryté/metadata se tiše ignorují, nehlásí se jako přeskočené.
    assert.equal(skipped.length, 0);
  } finally {
    await rm(zipPath, { force: true });
  }
});

test("streamZipEntries hlásí stopped=false při běžném dokončení", async () => {
  const zipPath = await makeZip([{ name: "a.txt", content: Buffer.from("x") }]);
  try {
    const { stopped, skipped } = await streamZipEntries(
      zipPath,
      { maxEntryBytes: 1024 * 1024 },
      async () => {},
    );
    assert.equal(stopped, false);
    assert.equal(skipped.length, 0);
  } finally {
    await rm(zipPath, { force: true });
  }
});

test("streamZipEntries hlásí stopped=true při předčasném zastavení (limit)", async () => {
  const zipPath = await makeZip([
    { name: "a.txt", content: Buffer.from("1") },
    { name: "b.txt", content: Buffer.from("2") },
    { name: "c.txt", content: Buffer.from("3") },
  ]);
  try {
    const entries: string[] = [];
    // shouldStop se aktivuje po prvním přijatém souboru – zbytek archivu se
    // nezpracuje a metoda musí ohlásit předčasné zastavení.
    const { stopped } = await streamZipEntries(
      zipPath,
      { maxEntryBytes: 1024 * 1024, shouldStop: () => entries.length >= 1 },
      async (e) => {
        entries.push(e.fileName);
      },
    );
    assert.equal(entries.length, 1);
    assert.equal(stopped, true);
  } finally {
    await rm(zipPath, { force: true });
  }
});

test("streamZipEntries přeskočí položku nad limitem velikosti", async () => {
  const big = Buffer.alloc(2048, 65);
  const zipPath = await makeZip([
    { name: "maly.txt", content: Buffer.from("x") },
    { name: "velky.txt", content: big },
  ]);
  try {
    const { entries, skipped } = await collect(zipPath, 1024);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fileName, "maly.txt");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].fileName, /velky\.txt$/);
    assert.match(skipped[0].reason, /příliš velký/);
  } finally {
    await rm(zipPath, { force: true });
  }
});
