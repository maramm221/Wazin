# Wazin: one small container, no runtime dependencies.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 WAZIN_DB=/data/wazin.db
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
COPY public ./public
COPY data ./data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
