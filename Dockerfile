# Deployment still requires real GCP, OAuth and 165 acceptance receipts.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
COPY templates/ ./templates/
COPY assets/ ./assets/
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    ESSAY_MCP_ANSWER_DIR=/tmp/essay/answers ESSAY_MCP_EXPORT_DIR=/tmp/essay/exports \
    ESSAY_MCP_PDF_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
    ESSAY_MCP_PDF_BOLD_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/templates ./templates
COPY --from=build --chown=node:node /app/assets ./assets
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
