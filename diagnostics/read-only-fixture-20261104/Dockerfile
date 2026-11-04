FROM node:22-alpine
ARG BUILD_REVISION=unknown
ENV NODE_ENV=production AIRANK_BUILD_REVISION=$BUILD_REVISION
WORKDIR /diagnostic
COPY --chown=node:node probe.mjs hold.mjs ./
LABEL org.opencontainers.image.source="https://github.com/purplemediagib/airank.me" org.opencontainers.image.title="AI Rank read-only fixture diagnostic"
USER node
EXPOSE 3003
CMD ["node", "hold.mjs"]
