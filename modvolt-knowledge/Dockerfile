# ---------------------------------------------------------------------------
# Modvolt Knowledge - produkční Dockerfile (použitelný mimo Replit)
#
# Base image node:24-slim (npm 11). Pozor: node:22-slim dodává npm 10.9.x,
# které trpí chybou "Exit handler never called!" a build na něm padá na konci
# `npm ci` (chyba v samotném npm, ne nedostatek paměti). node:24 je zároveň
# shodné s vývojovým prostředím.
#
# Závislosti se instalují POUZE JEDNOU v build fázi. Runtime fáze už jen
# zkopíruje hotové (a od dev-závislostí očištěné) node_modules. Tím se
# nezdvojuje instalace nativních modulů (sharp) ani spotřeba paměti.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Méně upovídané/křehké npm (update-notifier umí shodit exit handler).
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# POZN.: žádný apt-get / python3 / make / g++ není potřeba. sharp i esbuild
# se instalují jako PŘEDKOMPILOVANÉ binárky (optional deps @img/* a @esbuild/*),
# nic se nekompiluje ze zdroje. Ověřeno: `npm ci` v čistém node:24-slim projde
# bez build nástrojů. Vynecháním apt-get mizí závislost na Debian mirrorech
# (častý zdroj zaseknutí buildu při "redeploy without cache").

COPY package.json package-lock.json* ./

# Replit zapisuje do package-lock.json svůj interní proxy registr
# (http://package-firewall.replit.local/npm/...) místo registry.npmjs.org.
# Tyto URL jsou mimo Replit NEDOSTUPNÉ (ENOTFOUND) a způsobují selhání
# `npm ci` ve Docker buildu. Přepíšeme je na skutečný registr.
# Integrity hash (sha512) zůstane stejný — npm ci ho ověřuje proti obsahu
# staženého tgz, ne proti URL.
RUN if [ -f package-lock.json ]; then \
      sed -i 's|http://package-firewall\.replit\.local/npm/|https://registry.npmjs.org/|g' package-lock.json; \
      echo "Lockfile URL rewrite: $(grep -c registry.npmjs.org package-lock.json) entries -> registry.npmjs.org"; \
    fi

# Rychlý test, zda je npm registry z build kontejneru vůbec dosažitelná.
RUN node -e "const t=Date.now();fetch('https://registry.npmjs.org/-/ping',{signal:AbortSignal.timeout(15000)}).then(r=>console.log('npm registry OK',r.status,(Date.now()-t)+'ms')).catch(e=>console.error('npm registry NEDOSTUPNA:',e.message))" || true

# Instalace závislostí. Když selže, vypiš npm debug log + stav disku.
RUN npm config set fetch-timeout 120000 \
 && npm config set fetch-retries 3 \
 && npm config set fetch-retry-mintimeout 10000 \
 && npm config set fetch-retry-maxtimeout 60000 \
 && npm config set maxsockets 5 \
 && npm ci \
 || { echo "================ NPM CI SELHALO ================" >&2; \
      tail -n 100 /root/.npm/_logs/*-debug-0.log 2>/dev/null || true; \
      df -h || true; \
      exit 1 ; }

COPY . .
RUN npm run build

# Z node_modules odstraň dev-závislosti, ať je runtime image malý a
# nemusí se znovu nic instalovat.
RUN npm prune --omit=dev

# --- Runtime image ---
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Hotové produkční node_modules + manifesty (žádný npm install už neběží).
# --chown=node:node: soubory patří neprivilegovanému uživateli node (uid 1000),
# který je v node:24-slim předpřipravený.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/package-lock.json* ./

# Zkompilovaný backend, postavený frontend, migrace a zdroj pro tsx skripty
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/drizzle ./drizzle
COPY --chown=node:node --from=build /app/src ./src
COPY --chown=node:node --from=build /app/tsconfig.json ./tsconfig.json
COPY --chown=node:node --from=build /app/drizzle.config.ts ./drizzle.config.ts

# Neprivilegovaný uživatel: kontejner NESMÍ běžet jako root.
# node user (uid 1000) může zapisovat do /tmp (session import temp files).
USER node

# Port je vždy z env (Coolify / reverzní proxy)
ENV PORT=3000
EXPOSE 3000

# Healthcheck pro Coolify / Docker
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Server sám aplikuje čekající migrace při startu (před servírováním provozu).
# Pokud migrace selžou, proces skončí s nenulovým kódem a Coolify/Docker
# nasazení selže hlasitě místo běhu proti zastaralému schématu. Není tedy
# potřeba samostatný deploy krok pro `npm run db:migrate`.
CMD ["node", "dist/server/index.js"]
