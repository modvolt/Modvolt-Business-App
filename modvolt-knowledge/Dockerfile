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

# Nativní závislosti pro případný build sharp / pdf-parse
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Síťově odolná instalace (delší timeouty + opakování při výpadku registru).
# Když instalace přesto selže, vypiš SKUTEČNOU příčinu (npm debug log) a stav
# disku přímo do deploy logu — ať se nehádá, ale vidí (typicky ENOSPC/síť).
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && { npm ci || npm install ; } \
 || { echo "================ NPM INSTALL SELHALO ================" >&2; \
      echo "--- posledních 150 řádků npm debug logu ---" >&2; \
      tail -n 150 /root/.npm/_logs/*-debug-0.log 2>/dev/null || true; \
      echo "--- volné místo na disku (df -h) ---" >&2; df -h || true; \
      echo "--- volné inody (df -i) ---" >&2; df -i || true; \
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

# Hotové produkční node_modules + manifesty (žádný npm install už neběží)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json* ./

# Zkompilovaný backend, postavený frontend, migrace a zdroj pro tsx skripty
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

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
