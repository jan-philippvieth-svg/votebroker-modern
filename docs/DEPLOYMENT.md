# Deployment

This repository ships two Docker images:

- `apps/api/Dockerfile`: Fastify API
- `apps/web/Dockerfile`: Nginx static web app with `/api` reverse proxy

The default `docker-compose.yml` exposes the web container on port `80` and proxies API calls to the internal API service.

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

## Environment

Create `.env` from `.env.example` and set production values:

```env
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
curl http://votebroker.org/health
```

## HTTPS

For HTTPS, put Caddy, Traefik, Nginx Proxy Manager, or the server's existing reverse proxy in front of this compose stack.

Recommended external proxy target:

```text
http://127.0.0.1:80
```

If the server proxy already owns ports `80` and `443`, change the compose mapping to a private port:

```yaml
ports:
  - "127.0.0.1:8080:80"
```

Then proxy `https://votebroker.org` to `http://127.0.0.1:8080`.

## Production Notes

- The current API uses in-memory sessions, consents, invoices, and demo account data.
- Before public launch, move sessions and consent history to Postgres or Redis.
- Store SteemConnect tokens carefully, or avoid long-term token storage by requiring explicit signed actions.
- Fee-post votes are blocked unless `fee_post_vote` consent is active.
