# Proton Sieve Service: web login, REST API and MCP server (shares addon/lib with the Thunderbird add-on)
FROM node:22.11.0-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

FROM node:22.11.0-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app
COPY addon/lib ./addon/lib
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server/src/index.js"]
