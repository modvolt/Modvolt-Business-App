# ---------------------------------------------------------------------------
# Modvolt Knowledge - produkční Dockerfile (použitelný mimo Replit)
#
# Závislosti se instalují POUZE JEDNOU v build fázi. Runtime fáze už jen
# zkopíruje hotové (a od dev-závislostí očištěné) node_modules. Tím se
# nezdvojuje instalace nativních modulů (sharp) a hlavně se nespotřebuje
# dvojnásobek paměti při paralelním buildu (BuildKit jinak staví obě fáze
# současně -> npm byl zabíjen kvůli nedostatku paměti / "Exit handler never
# called!").
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Nativní závislosti pro případný build sharp / pdf-parse
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .
RUN npm run build

# Z node_modules odstraň dev-závislosti, ať je runtime image malý a
# nemusí se znovu nic instalovat.
RUN npm prune --omit=dev

# --- Runtime image ---
FROM node:22-slim AS runtime
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
