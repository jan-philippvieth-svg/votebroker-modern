FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @votebroker/web --include-workspace-root

FROM deps AS build
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
COPY apps/web apps/web
RUN npm run build -w @votebroker/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
