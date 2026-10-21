ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY guard.mjs ./
ENV NODE_ENV=production
USER node
CMD ["node", "guard.mjs"]
