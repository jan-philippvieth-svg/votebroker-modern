# VoteBroker Production Deployment

This deployment is intentionally isolated from existing server stacks such as Umami. VoteBroker uses its own Docker Compose project name, network, volumes, and containers.

## Files

- `apps/api/Dockerfile`: Fastify API production image
- `apps/web/Dockerfile`: React build served by Nginx
- `docker-compose.prod.yml`: isolated production stack named `votebroker`
- `Caddyfile`: HTTPS reverse proxy for `votebroker.org` and `www.votebroker.org` only
- `.env.production.example`: production environment template

## DNS

Point the domain to the VPS:

```text
A      votebroker.org      82.165.216.47
CNAME  www                 votebroker.org
```

Open ports `80` and `443` in the STRATO firewall. Caddy needs them for HTTP-01 certificate issuance and HTTPS traffic.

## Environment

Create the production env file:

```bash
cp .env.production.example .env
nano .env
```

Set at least:

```env
VOTEBROKER_OPERATOR_TOKEN=use-a-long-random-secret
STEEMCONNECT_HOST=https://hivesigner.com
STEEMCONNECT_CLIENT_ID=votebroker
STEEMCONNECT_RESPONSE_TYPE=token
STEEMCONNECT_REDIRECT_URI=https://votebroker.org/auth/callback
STEEMCONNECT_SCOPES=login,vote
```

`STEEMCONNECT_CLIENT_SECRET` is only required when `STEEMCONNECT_RESPONSE_TYPE=code` is used, typically together with an `offline` scope. The default production mode is token/implicit flow, because HiveSigner redirects the browser back with an `access_token`.

## HiveSigner / SteemConnect App Setup

Create or configure the OAuth app in the HiveSigner/SteemConnect app dashboard for the account used as `STEEMCONNECT_CLIENT_ID`.

Use exactly this redirect URL:

```text
https://votebroker.org/auth/callback
```

Required scopes for the current VoteBroker production flow:

```text
login,vote
```

Optional code/offline flow:

```text
STEEMCONNECT_RESPONSE_TYPE=code
STEEMCONNECT_SCOPES=offline,login,vote
STEEMCONNECT_CLIENT_SECRET=<server-side-secret>
```

Keep the client secret only in `.env` on the server. Never put it into frontend code.

## Production Readiness Matrix

Production-ready:

- Login URL generation with one-time OAuth state.
- Callback handling for HiveSigner/SteemConnect `access_token`.
- Optional server-side `code` exchange when explicitly configured.
- State/CSRF validation before session creation.
- Token verification through signer `/api/me`.
- Manual target vote broadcast through signer `/api/broadcast`.
- Fee-post settlement broadcast through signer `/api/broadcast`, gated by `fee_post_vote` consent.

Stub/mock:

- Account voting power and full-power vote value still come from the in-memory demo account provider.
- Invoice, consent history, and session storage are in-memory.
- Community pool metrics are demo snapshots.

Not live yet:

- Persistent Postgres/Redis storage.
- Real chain account-power/reward-fund pricing adapter.
- Scheduled auto-vote worker.
- Durable vote execution history and retry queue.

## Start

Run the stack from the repository root:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Check status:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy
docker compose -f docker-compose.prod.yml logs -f api
```

Health check:

```bash
curl https://votebroker.org/health
```

## Isolation From Umami

This stack does not attach to any external network and does not reference any Umami container, volume, or database.

VoteBroker creates only these named resources:

```text
votebroker_internal
votebroker_caddy_data
votebroker_caddy_config
```

Caddy in this stack is configured only for:

```text
votebroker.org
www.votebroker.org
```

Important: if another stack already binds host ports `80` or `443`, Docker will refuse to start VoteBroker's Caddy. That does not modify the other stack, but you must then either stop the other public proxy or route `votebroker.org` through that existing proxy instead.

## Update

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker image prune -f
```

## Stop VoteBroker Only

```bash
docker compose -f docker-compose.prod.yml down
```

To also remove VoteBroker's Caddy certificate/config volumes:

```bash
docker compose -f docker-compose.prod.yml down -v
```

This affects only the `votebroker` stack resources.
