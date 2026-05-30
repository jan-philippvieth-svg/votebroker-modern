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
STEEMCONNECT_AUTH_HOST=https://v2.steemconnect.com
STEEMCONNECT_API_HOST=https://api.steemconnect.com
STEEMCONNECT_CLIENT_ID=votebroker
STEEMCONNECT_CLIENT_SECRET=your-secret
STEEMCONNECT_RESPONSE_TYPE=code
STEEMCONNECT_REDIRECT_URI=https://votebroker.org/auth/callback
STEEMCONNECT_SCOPES=offline,vote
STEEM_NODE_URL=https://api.steemit.com
VOTEBROKER_BROADCAST_ACCOUNT=votebroker
VOTEBROKER_POSTING_WIF=your-votebroker-posting-wif
VOTEBROKER_FEE_POST_AUTHOR=votebroker
VOTEBROKER_FEE_POST_PERMLINK=monthly-fees
```

The production default mirrors SteemDunk: code flow plus server-side broadcasting by the authorized VoteBroker account. User private keys are never stored.

Optional manual token fallback:

```env
STEEMCONNECT_RESPONSE_TYPE=token
STEEMCONNECT_SCOPES=login,vote
VOTEBROKER_MANUAL_TOKEN_FALLBACK=true
```

## HiveSigner / SteemConnect

Register or configure the app in the HiveSigner/SteemConnect app dashboard for the account configured as `STEEMCONNECT_CLIENT_ID`.

Use this exact redirect URL:

```text
https://votebroker.org/auth/callback
```

Required scopes:

```text
offline,vote
```

The default VoteBroker production flow expects SteemConnect to redirect back with `code` and `state`. VoteBroker validates the one-time `state`, exchanges the code server-side through `STEEMCONNECT_CLIENT_SECRET`, verifies the returned token through `/api/me`, and then creates a local session.

## Live Versus Mock

Production-ready:

- OAuth state creation and validation.
- `code` callback handling with server-side secret.
- optional `access_token` callback for manual/fallback mode.
- target vote broadcasting with server-side VoteBroker posting key.
- fee-post vote broadcasting with server-side VoteBroker posting key, gated by explicit fee-post consent.
- posting authority validation before broadcasting.
- in-memory audit log for attempts, blocks, and successful broadcasts.

Still mock/stub:

- account power data
- full vote USD value
- community pool stats
- in-memory sessions, consents, and invoices

Not live yet:

- persistent database
- real chain pricing/reward-fund adapter
- scheduled auto-vote worker
- durable retry/audit queue

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
