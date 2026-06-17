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
STEEMCONNECT_AUTH_HOST=https://v2.steemconnect.com
STEEMCONNECT_API_HOST=https://api.steemconnect.com
STEEMCONNECT_CLIENT_ID=votebroker
STEEMCONNECT_CLIENT_SECRET=your-steemconnect-client-secret
STEEMCONNECT_RESPONSE_TYPE=code
STEEMCONNECT_REDIRECT_URI=https://votebroker.org/auth/callback
STEEMCONNECT_SCOPES=offline,vote
STEEM_NODE_URL=https://api.steemit.com
VOTEBROKER_BROADCAST_ACCOUNT=votebroker
VOTEBROKER_POSTING_WIF=your-votebroker-posting-wif
```

Production follows the proven SteemDunk pattern: SteemConnect code flow with `offline,vote`, a server-side client secret, and server-side broadcasting through the VoteBroker account's posting key. VoteBroker never stores private user keys.

## HiveSigner / SteemConnect App Setup

Create or configure the OAuth app in the HiveSigner/SteemConnect app dashboard for the account used as `STEEMCONNECT_CLIENT_ID`.

Use exactly this redirect URL:

```text
https://votebroker.org/auth/callback
```

Required scopes for the current VoteBroker production flow:

```text
offline,vote
```

Optional manual fallback flow:

```text
STEEMCONNECT_RESPONSE_TYPE=token
STEEMCONNECT_SCOPES=login,vote
VOTEBROKER_MANUAL_TOKEN_FALLBACK=true
```

Keep the client secret and `VOTEBROKER_POSTING_WIF` only in `.env` on the server. Never put either value into frontend code or Docker build args.

See `docs/SECURITY.md` for the dsteem runtime dependency notes and the audit checklist.

## Production Readiness Matrix

Live and running:

- Login URL generation with one-time OAuth state.
- SteemConnect code-flow callback with server-side secret.
- Optional access-token callback for manual/fallback mode.
- State/CSRF validation before session creation.
- Token verification through signer `/api/me`.
- Sessions and consent history persisted in SQLite.
- Server-side target vote broadcast using `VOTEBROKER_POSTING_WIF`, gated by `target_vote` consent.
- Server-side fee-post settlement broadcast using `VOTEBROKER_POSTING_WIF`, gated by `fee_post_vote` consent.
- Posting authority check before server-side vote broadcast.
- Audit log for every vote attempt, block, and successful broadcast.
- CoPilot automated curation (requires `auto_vote` consent + active strategy rules).
- Vote outcomes persisted in `vb_global_vote_outcomes` for timing analytics.

Not yet implemented:

- Persistent auth storage for production-grade session management (currently SQLite; Redis or Postgres would add horizontal scaling and proper session expiry management).
- Rate limiting on public and authenticated endpoints.
- Hardened operator authentication (currently single shared token; consider per-operator keys or mTLS).
- Production observability: structured log aggregation, metrics scraping, alerting.

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

## HTTPS Without Caddy

If another reverse proxy already owns ports `80` and `443`, remove the `caddy` service from `docker-compose.prod.yml` and expose the web container on a private port instead:

```yaml
web:
  ports:
    - "127.0.0.1:8080:80"
```

Then proxy `https://votebroker.org` to `http://127.0.0.1:8080` from your existing proxy.

## Resource Fit

The STRATO VPS Linux VC2-4 profile is sufficient for the current stack:

- 2 CPU cores: enough for API, Caddy, and static web serving
- 4 GB RAM: enough for Node runtime and Docker build room
- 120 GB storage: enough for source, images, logs, and the SQLite database volume

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
