# Deployment

This repository ships a production-ready Docker Compose stack for a small VPS:

- `apps/api/Dockerfile`: Fastify API
- `apps/web/Dockerfile`: Nginx static web app with `/api` reverse proxy
- `caddy`: public HTTPS entrypoint with automatic Let's Encrypt certificates

The default `docker-compose.yml` exposes only Caddy on ports `80`, `443`, and `443/udp`. The API and web containers stay on the private Docker network.

## Domain

Production domain:

```text
votebroker.org
```

Configure DNS:

```text
A     votebroker.org      <server-ip>
CNAME www                votebroker.org
```

For the STRATO VPS shown in the setup screenshot, the current IPv4 target is:

```text
A     votebroker.org      82.165.216.47
CNAME www                votebroker.org
```

Keep ports `80` and `443` open in the STRATO firewall. Caddy needs port `80` for certificate issuance and port `443` for HTTPS traffic.

## Environment

Create `.env` from `.env.example` and set production values:

```bash
cp .env.example .env
nano .env
```

```env
VOTEBROKER_PUBLIC_URL=https://votebroker.org
VOTEBROKER_OPERATOR_TOKEN=use-a-long-random-token
STEEMCONNECT_CLIENT_ID=votebroker
STEEMCONNECT_CLIENT_SECRET=your-secret
STEEMCONNECT_REDIRECT_URI=https://votebroker.org/auth/callback
STEEMCONNECT_SCOPES=login,vote
VOTEBROKER_FEE_POST_AUTHOR=votebroker
VOTEBROKER_FEE_POST_PERMLINK=monthly-fees
```

## Start

```bash
docker compose up -d --build
```

Health check:

```bash
curl https://votebroker.org/health
```

Inspect containers:

```bash
docker compose ps
docker compose logs -f caddy
docker compose logs -f api
```

Update after pulling a new version:

```bash
git pull
docker compose up -d --build
docker image prune -f
```

## HTTPS

Caddy is included in the compose stack and automatically provisions certificates for:

```text
https://votebroker.org
https://www.votebroker.org
```

If another reverse proxy already owns ports `80` and `443`, remove the `caddy` service and expose the web service privately instead:

```yaml
web:
  ports:
    - "127.0.0.1:8080:80"
```

Then proxy `https://votebroker.org` to `http://127.0.0.1:8080`.

## Resource Fit

The STRATO VPS Linux VC2-4 profile is sufficient for the current stack:

- 2 CPU cores: enough for API, Caddy, and static web serving
- 4 GB RAM: enough for Node runtime and Docker build room
- 120 GB storage: enough for source, images, logs, and future database volume

## Production Notes

- The current API uses in-memory sessions, consents, invoices, and demo account data.
- Before public launch, move sessions and consent history to Postgres or Redis.
- Store SteemConnect tokens carefully, or avoid long-term token storage by requiring explicit signed actions.
- Fee-post votes are blocked unless `fee_post_vote` consent is active.
