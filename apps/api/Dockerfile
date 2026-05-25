FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspaces --include-workspace-root

FROM deps AS build
COPY packages/domain packages/domain
COPY apps/api apps/api
RUN npm run build -w @votebroker/domain && npm run build -w @votebroker/api

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force

COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/apps/api/dist apps/api/dist

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
