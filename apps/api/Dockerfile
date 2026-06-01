FROM node:20-alpine AS deps
# better-sqlite3 needs native compilation
RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace @votebroker/domain --workspace @votebroker/api --include-workspace-root

FROM deps AS build
COPY packages/domain packages/domain
COPY apps/api apps/api
RUN npm run build -w @votebroker/domain && npm run build -w @votebroker/api

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

RUN apk add --no-cache dumb-init python3 make g++

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev --workspace @votebroker/domain --workspace @votebroker/api --include-workspace-root && npm cache clean --force

COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/apps/api/dist apps/api/dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
