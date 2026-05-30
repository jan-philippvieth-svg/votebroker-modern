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
STEEMCONNECT_CLIENT_ID=votebroker
STEEMCONNECT_CLIENT_SECRET=your-steemconnect-secret
STEEMCONNECT_REDIRECT_URI=https://votebroker.org/auth/callback
```

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
