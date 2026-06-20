# ---------------------------------------------------------------------------
# Modvolt Knowledge - produkční Dockerfile (použitelný mimo Replit)
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Nativní závislosti pro sharp / pdf-parse build
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build

# --- Runtime image ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

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

CMD ["node", "dist/server/index.js"]
