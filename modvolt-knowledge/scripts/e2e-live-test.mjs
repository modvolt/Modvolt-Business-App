import "dotenv/config";
import ExcelJS from "exceljs";
import sharp from "sharp";
import pg from "pg";

const BASE = process.env.E2E_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@modvolt.cz";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin12345";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let cookie = "";
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // Session cookie je Secure+SameSite=None; přes trust proxy musíme
      // simulovat HTTPS, jinak express-session cookie nenastaví/nepřijme.
      "x-forwarded-proto": "https",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, data, res };
}

async function login() {
  const { status, data } = await api("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  record("Admin login", status === 200, `status=${status}`);
  if (status !== 200) throw new Error("Login failed: " + JSON.stringify(data));
}

async function checkHealth(label) {
  const { status, data } = await api("/health");
  const c = data.checks || {};
  record(
    `${label}: /api/health`,
    status === 200 && c.s3Reachable && c.openaiEnabled && c.visionEnabled,
    `db=${c.database} s3Configured=${c.s3Configured} s3Reachable=${c.s3Reachable} openaiEnabled=${c.openaiEnabled} visionEnabled=${c.visionEnabled}`,
  );
  return c;
}

async function checkCapabilities() {
  const { data } = await api("/api/capabilities");
  record(
    "/api/capabilities",
    data.aiChat === true && data.vision === true,
    JSON.stringify(data),
  );
}

async function buildXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Dimenzování");
  ws.addRow(["Veličina", "Hodnota", "Poznámka"]);
  ws.addRow(["Jmenovité napětí instalace", "230/400 V", "TN-S síť"]);
  ws.addRow([
    "Maximální dovolený úbytek napětí",
    "3 %",
    "pro světelné obvody dle doporučení",
  ]);
  ws.addRow([
    "Průřez vodiče pro zásuvkový obvod 16 A",
    "2,5 mm2 Cu",
    "měděný vodič, jištění 16 A",
  ]);
  ws.addRow([
    "Magická testovací konstanta MODVOLT",
    "XK-4719-ZETA",
    "unikátní řetězec pro ověření citace",
  ]);
  ws.addRow([
    "Doporučený typ proudového chrániče",
    "RCD typ A, 30 mA",
    "ochrana koncových obvodů",
  ]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function uploadDocument() {
  const xlsx = await buildXlsx();
  const form = new FormData();
  form.append(
    "file",
    new Blob([xlsx], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "modvolt-dimenzovani.xlsx",
  );
  form.append("title", "Modvolt dimenzování vodičů (E2E test)");
  form.append("documentType", "internal_procedure");
  form.append("visibility", "all_users");
  const { status, data } = await api("/api/documents", {
    method: "POST",
    body: form,
  });
  record("Upload XLSX document", status === 201, `status=${status}`);
  if (status !== 201) throw new Error("Upload failed: " + JSON.stringify(data));
  return data.document.id;
}

async function verifyS3Stored(docId) {
  const { rows } = await pool.query(
    "select object_path from documents where id=$1",
    [docId],
  );
  const objectPath = rows[0]?.object_path;
  const { status } = await api(`/api/documents/${docId}/download`);
  record(
    "Document stored in S3 (presigned download)",
    status === 200 && Boolean(objectPath),
    `objectPath=${objectPath}`,
  );
}

async function waitForIndexed(docId, timeoutMs = 90000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const { data } = await api(`/api/documents/${docId}`);
    last = data.document?.status;
    if (last === "indexed") break;
    if (last === "failed") throw new Error("Indexing failed");
    await new Promise((r) => setTimeout(r, 2000));
  }
  record("Document reaches status=indexed", last === "indexed", `status=${last}`);
}

async function verifyChunksEmbeddings(docId) {
  const { rows: cr } = await pool.query(
    "select count(*)::int n from document_chunks where document_id=$1",
    [docId],
  );
  const { rows: er } = await pool.query(
    `select count(*)::int n from document_embeddings e
     join document_chunks c on c.id=e.chunk_id
     where c.document_id=$1`,
    [docId],
  );
  const chunks = cr[0].n;
  const emb = er[0].n;
  record(
    "document_chunks + document_embeddings populated",
    chunks > 0 && emb > 0 && emb === chunks,
    `chunks=${chunks} embeddings=${emb}`,
  );
}

async function verifySearch() {
  const { status, data } = await api("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "dimenzování vodičů a proudový chránič RCD" }),
  });
  const hits = data.hits || [];
  record(
    "Hybrid search returns relevant results",
    status === 200 && hits.length > 0,
    `status=${status} hits=${hits.length}`,
  );
  return hits;
}

async function verifyAiChat(docId) {
  const { status, data } = await api("/api/ask", (() => {
    const form = new FormData();
    // Záměrně dotaz BEZ normových klíčových slov (proudový chránič/RCD apod.),
    // aby se neaktivoval tvrdý zámek ČSN, který by interní postup vyfiltroval.
    form.append(
      "query",
      "Jaká je hodnota magické testovací konstanty MODVOLT uvedená v interním dokumentu?",
    );
    form.append("sourceMode", "internal_only");
    return { method: "POST", body: form };
  })());
  const ans = data.answer || {};
  const citations = ans.citations || [];
  const usedChunkIds = data.usedChunkIds || [];
  // Verify at least one citation maps to a chunk of our uploaded document.
  let citationMatchesDoc = false;
  if (usedChunkIds.length) {
    const { rows } = await pool.query(
      "select count(*)::int n from document_chunks where document_id=$1 and id = ANY($2::uuid[])",
      [docId, usedChunkIds],
    );
    citationMatchesDoc = rows[0].n > 0;
  }
  record(
    "AI chat returns an answer",
    status === 200 && typeof ans.answer === "string" && ans.answer.length > 0,
    `status=${status} confidence=${ans.confidence} hasSufficientSources=${ans.hasSufficientSources}`,
  );
  record(
    "AI answer has valid citations pointing to uploaded document",
    citations.length > 0 && citationMatchesDoc,
    `citations=${citations.length} usedChunkIds=${usedChunkIds.length} matchesDoc=${citationMatchesDoc}`,
  );
  if (typeof ans.answer === "string") {
    console.log("   ↳ answer preview:", ans.answer.slice(0, 280).replace(/\s+/g, " "));
  }
}

async function buildPhotoWithExif() {
  // Vytvoř JPEG s EXIF (vč. GPS), abychom ověřili jeho odstranění.
  const base = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 60, g: 120, b: 180 },
    },
  })
    .jpeg()
    .toBuffer();
  const withExif = await sharp(base)
    .withMetadata({
      exif: {
        IFD0: { Make: "ModvoltCam", Model: "TestRig" },
        GPS: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" },
      },
    })
    .jpeg()
    .toBuffer();
  return withExif;
}

async function verifyPhotoVision() {
  const photo = await buildPhotoWithExif();
  // Potvrď, že vstupní foto má EXIF.
  const inMeta = await sharp(photo).metadata();
  const hadExif = Boolean(inMeta.exif);

  const form = new FormData();
  form.append(
    "query",
    "Popiš stručně, co je na této fotografii (barva a typ).",
  );
  form.append("sourceMode", "internal_only");
  form.append("images", new Blob([photo], { type: "image/jpeg" }), "test-photo.jpg");
  const { status, data } = await api("/api/ask", { method: "POST", body: form });
  const attIds = data.attachmentIds || [];
  record(
    "Photo upload analyzed by vision (AI answered)",
    status === 200 && typeof data.answer?.answer === "string" && data.answer.answer.length > 0,
    `status=${status} attachments=${attIds.length} inputHadExif=${hadExif}`,
  );

  if (attIds.length) {
    const { rows } = await pool.query(
      "select exif_removed, object_path, mime_type from chat_attachments where id=$1",
      [attIds[0]],
    );
    const att = rows[0];
    // Stáhni uložený objekt (binárně, mimo JSON helper) a ověř, že nemá EXIF.
    const fetched = await fetch(`${BASE}/api/attachments/${attIds[0]}`, {
      headers: { "x-forwarded-proto": "https", cookie },
    });
    let storedHasExif = true;
    if (fetched.ok) {
      const ab = await fetched.arrayBuffer();
      const storedMeta = await sharp(Buffer.from(ab)).metadata();
      storedHasExif = Boolean(storedMeta.exif);
    }
    record(
      "Photo stored to S3 with EXIF stripped",
      att?.exif_removed === true && fetched.ok && !storedHasExif,
      `exif_removed=${att?.exif_removed} storedHasExif=${storedHasExif} path=${att?.object_path}`,
    );
  } else {
    record("Photo stored to S3 with EXIF stripped", false, "no attachment id returned");
  }
}

async function main() {
  try {
    await login();
    await checkCapabilities();
    await checkHealth("Before upload");
    const docId = await uploadDocument();
    await verifyS3Stored(docId);
    await waitForIndexed(docId);
    await verifyChunksEmbeddings(docId);
    await verifySearch();
    await verifyAiChat(docId);
    await verifyPhotoVision();
    await checkHealth("After");
  } catch (err) {
    record("FATAL", false, String(err?.stack || err));
  } finally {
    await pool.end();
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
