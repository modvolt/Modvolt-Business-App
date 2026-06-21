# Modvolt Knowledge

Interní znalostní databáze firmy **Modvolt s.r.o.** s vyhledáváním a AI asistentem
(RAG) nad firemními dokumenty — normy ČSN, návody, revize, interní postupy, technické listy.

Aplikace je **plně přenositelná** a **nezávislá na Replitu**. Lze ji nasadit přes
Docker / Coolify na vlastním serveru (např. Hetzner) s běžnými službami:

- **PostgreSQL + pgvector** (vektorové vyhledávání)
- **S3-kompatibilní úložiště** (Hetzner Object Storage nebo jiné)
- **OpenAI API** (volitelné — bez něj funguje vyhledávání i správa dokumentů)
- **Web search** (volitelné, pluggable: Brave / Bing / Google / Tavily)

Veškerá konfigurace probíhá přes standardní proměnné prostředí (`.env`).

---

## Klíčové vlastnosti

- **Autentizace a role**: `admin`, `user`, `read_only` (hesla hashovaná přes bcrypt,
  session v PostgreSQL, tajný klíč v `SESSION_SECRET`).
- **Správa dokumentů**: nahrávání PDF, DOCX, XLSX, TXT, MD, CSV → uložení do S3 →
  extrakce textu → chunkování → embeddingy → pgvector.
- **Hybridní vyhledávání**: kombinace fulltextu (PostgreSQL) a vektorového vyhledávání.
- **AI asistent s povinnými citacemi**: každá odpověď odkazuje na konkrétní zdroje.
- **Režimy zdrojů** (`sourceMode`):
  - `internal_only` — pouze interní dokumenty,
  - `internal_then_web` — interní, web jen jako doplněk,
  - `web_allowed` — interní i web,
  - `csn_only` — **tvrdý zámek** pro dotazy na elektrické normy / ČSN (nikdy se
    nepoužívá web, pouze interní normové dokumenty).
- **Správa promptů v kódu** (verzované, NE přes OpenAI Platform agenty).
- **Foto / vision dotazy**: nahrání fotografie, **automatické odstranění EXIF** (vč. GPS),
  zmenšení obrázku. Model popisuje jen to, co je vidět, a navrhuje potřebná měření.
- **Audit log**, **/health endpoint**, **Dockerfile**, **docker-compose.yml**.

> Aplikace funguje **i bez OpenAI** (AI funkce se skryjí) a **i bez web search providera**.

---

## Architektura

- **Backend**: Node.js + Express + Drizzle ORM (PostgreSQL).
- **Frontend**: React + Vite (jednostránková aplikace, servírovaná stejným serverem).
- **Indexace**: jednoduchá fronta v DB (`indexing_jobs`) zpracovávaná workerem v procesu
  (žádný externí broker — plně přenositelné).
- **Embeddingy**: `text-embedding-3-small` (dimenze **1536**). Při změně modelu je nutné
  upravit dimenzi ve schématu a přegenerovat embeddingy.

---

## Lokální spuštění (vývoj)

Požadavky: Node.js 20+ a PostgreSQL s rozšířením `pgvector`.

```bash
cp .env.example .env      # vyplň DATABASE_URL, SESSION_SECRET, příp. S3/OpenAI
npm install
npm run db:migrate        # vytvoří rozšíření pgvector, tabulky, výchozí kategorie
npm run db:seed-admin     # vytvoří admina dle ADMIN_EMAIL / ADMIN_PASSWORD
npm run dev               # vývojový server (Vite middleware + API) na portu PORT
```

Aplikace poběží na `http://localhost:${PORT}` (výchozí 3000).

---

## Produkční build

```bash
npm run build             # postaví frontend (dist/public) i backend (dist/server)
npm start                 # spustí produkční server (servíruje statický frontend)
```

---

## Nasazení přes Docker

```bash
docker build -t modvolt-knowledge .
docker run --env-file .env -p 3000:3000 modvolt-knowledge
```

Po startu kontejneru jednorázově spusť migrace a vytvoření admina:

```bash
docker run --env-file .env modvolt-knowledge npm run db:migrate
docker run --env-file .env modvolt-knowledge npm run db:seed-admin
```

> **Pozor:** migrace se **nespouštějí automaticky** při startu serveru —
> je nutné je spustit ručně (viz výše) po každém nasazení nové verze,
> pokud obsahuje nové SQL soubory ve složce `drizzle/`.
> `db:seed-admin` je jednorázový bootstrap; opakované spuštění je bezpečné
> (existujícího admina nepřepíše).

---

## Nasazení přes Coolify (Hetzner)

1. **Databáze**: vytvoř PostgreSQL službu s rozšířením `pgvector`
   (např. image `pgvector/pgvector:pg16`) nebo použij externí PostgreSQL.
   Připojení nastav do `DATABASE_URL`.
2. **Úložiště**: vytvoř bucket v Hetzner Object Storage a vyplň `S3_*` proměnné.
   Bucket nech **privátní** — soubory se stahují přes krátkodobá předpodepsaná URL.
3. **Aplikace**: nasaď tento repozitář jako Docker aplikaci.
   - Coolify sestaví image podle `Dockerfile`.
   - Nastav všechny proměnné prostředí (viz `.env.example`).
   - Port aplikace se řídí proměnnou `PORT` (Coolify ji obvykle nastaví sám).
   - Healthcheck: `GET /health`.
4. **Migrace a bootstrap**: po každém nasazení s novými migracemi spusť
   `npm run db:migrate` (přes Coolify „Execute command").
   `npm run db:seed-admin` spusť jen jednou při první instalaci —
   vytvoří admin účet z proměnných `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
5. **Doména a TLS**: nastav doménu a Let's Encrypt v Coolify.

### Varianta s vlastní databází v docker-compose

```bash
docker compose --profile with-db up -d
```

Tato varianta spustí i kontejner `pgvector/pgvector:pg16`. Pro produkci na Coolify se
obvykle používá samostatná databázová služba a profil `with-db` se nepoužívá.

---

## Proměnné prostředí

Viz `.env.example`. Nejdůležitější:

| Proměnná | Význam |
| --- | --- |
| `DATABASE_URL` | Připojení k PostgreSQL (s pgvector). **Povinné.** |
| `SESSION_SECRET` | Tajný klíč pro session. **Povinné.** |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3 úložiště. |
| `OPENAI_API_KEY`, `OPENAI_ENABLED` | OpenAI (volitelné). Bez něj jsou AI funkce vypnuté. |
| `OPENAI_IMAGE_ANALYSIS_ENABLED` | Povolení analýzy fotografií (vyžaduje OpenAI). |
| `WEB_SEARCH_ENABLED`, `WEB_SEARCH_PROVIDER`, `WEB_SEARCH_API_KEY` | Web search (volitelné). |
| `MAX_IMAGE_UPLOAD_MB` | Max. velikost nahrané fotografie v MB (výchozí 15). |
| `OPENAI_MAX_UPLOAD_MB` | Max. velikost dokumentu pro OpenAI analýzu v MB (výchozí 15). |
| `MAX_BATCH_FILES` | Max. počet souborů v jedné dávce (výchozí 10). |
| `MAX_ZIP_MB` | Max. velikost ZIP archivu v MB (výchozí 100). |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Bootstrap admina pro `db:seed-admin`. |
| `PORT` | Port aplikace (výchozí 3000). |

---

## Bezpečnost

- Hesla jsou hashovaná (bcrypt). Po prvním přihlášení změň heslo admina.
- S3 bucket měj **privátní**; stahování probíhá přes krátkodobá předpodepsaná URL.
- Z nahraných fotografií se odstraňují EXIF metadata (včetně GPS) — vždy, bez výjimky.
- Dotazy na elektrické normy jsou tvrdě uzamčeny do režimu `csn_only` (bez webu).
- Všechny citlivé akce se zapisují do audit logu.
- HTTP bezpečnostní hlavičky přidává **Helmet** (CSP, X-Frame-Options, HSTS v produkci).
- Přihlášení je chráněno **rate limiterem** (max 10 neúspěšných pokusů / 15 min / IP).
- Mutační API požadavky z cizích origins (CSRF) jsou blokovány Origin guardem.
- Veřejný endpoint `GET /health` vrací jen `{status, version, time}` — interní stav
  infrastruktury (DB, S3, OpenAI) je dostupný pouze na `GET /api/admin/system-health`.

---

## Webové API (přehled)

- `GET /health` — minimální health probe (status/version/time). Pro Docker/Coolify healthcheck.
- `GET /api/admin/system-health` — interní stav (DB, S3, OpenAI, web search). Vyžaduje admin.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- `GET /api/capabilities` — které funkce jsou dostupné (AI, vize, web search).
- `GET/POST/PATCH/DELETE /api/documents` — správa dokumentů, `/:id/download`, `/:id/reindex`.
- `GET /api/categories` — kategorie.
- `POST /api/search` — fulltext/vektorové vyhledávání.
- `POST /api/ask` — AI dotaz (volitelně s fotografiemi).
- `GET/POST/PATCH/DELETE /api/admin/*` — uživatelé, nastavení, audit, statistiky.

---

## Smoke test po nasazení

Po nasazení (Docker / Coolify) ověř základní funkčnost:

```bash
BASE=https://your-domain.com   # nebo http://localhost:3000 lokálně

# 1. Health probe musí vrátit HTTP 200 + {"status":"ok"}
curl -sf "$BASE/health" | grep '"status":"ok"'

# 2. Login — ověř, že přihlášení vrátí user objekt
curl -sf -c cookies.txt -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"changeme"}' | grep '"role":"admin"'

# 3. Capabilities — výčet dostupných funkcí
curl -sf -b cookies.txt "$BASE/api/capabilities"

# 4. Interní health (admin) — stav DB, S3, OpenAI
curl -sf -b cookies.txt "$BASE/api/admin/system-health" | grep '"database":true'

# 5. Logout
curl -sf -b cookies.txt -X POST "$BASE/api/auth/logout"
```

> Pokud krok 1 vrátí 503, databáze není dostupná — zkontroluj `DATABASE_URL`
> a spuštění migrací (`npm run db:migrate`).

---

## Ověření buildu (lokálně nebo v CI)

```bash
# Spustí: npm ci → typecheck → testy → build
npm run verify
```

Nebo z kořene monorepa:

```bash
pnpm run verify:knowledge
```

---

## Licence

Interní software firmy Modvolt s.r.o.
