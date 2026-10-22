FROM node:22-alpine AS runtime
ARG BUILD_REVISION=unknown
ENV AIRANK_BUILD_REVISION=$BUILD_REVISION
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node app/src ./src
COPY --chown=node:node app/data ./data
ENV NODE_ENV=production APP_ENV=staging MONITORING_ENABLED=false CONSUMER_COLLECTION_ENABLED=false PROJECT_SCHEDULER_ENABLED=false
LABEL org.opencontainers.image.source="https://github.com/purplemediagib/airank.me"
USER node

FROM runtime AS api
ENV PORT=3000 EMAIL_AUTH_ENABLED=true
LABEL org.opencontainers.image.title="AI Rank API" org.opencontainers.image.version="0.22.0"
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/app/start-release.mjs"]

FROM runtime AS worker
ENV PORT=3001
LABEL org.opencontainers.image.title="AI Rank Monitoring Worker" org.opencontainers.image.version="0.22.0"
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/worker/worker.mjs"]

FROM runtime AS content
ENV PORT=3002
LABEL org.opencontainers.image.title="AI Rank Content Worker" org.opencontainers.image.version="1.0.0"
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/content/worker.mjs"]

FROM node:24-bookworm-slim AS google
ARG BUILD_REVISION=unknown
ENV AIRANK_BUILD_REVISION=$BUILD_REVISION
WORKDIR /app
COPY google-connector/package.json google-connector/*.mjs ./
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
LABEL org.opencontainers.image.source="https://github.com/purplemediagib/airank.me" org.opencontainers.image.title="AI Rank Google Connector" org.opencontainers.image.version="0.2.0"
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The launcher prepares /data and drops privileges to UID/GID 1000.
CMD ["node", "launch.mjs"]
