# Staging scaffold only: local FileStore is ephemeral on Cloud Run.
# Production rollout requires durable EssayStore and OAuth as documented.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
COPY templates/ ./templates/
COPY assets/ ./assets/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data/answers /app/exports \
    && chown -R node:node /app/data /app/exports
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/templates ./templates
COPY --from=build --chown=node:node /app/assets ./assets
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
