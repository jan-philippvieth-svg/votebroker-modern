# Architecture

VoteBroker Modern separates business rules from transport, storage, and blockchain adapters.

## Layers

### Domain

`packages/domain` contains pure TypeScript logic:

- quote a target USD vote into a vote weight
- calculate the fee invoice
- assess whether the automated fee-post vote can settle the invoice
- move accounts through `active`, `warning`, `paused`, and `payment_required`

This package should stay free of HTTP, database, and chain dependencies.

### API

`apps/api` exposes the domain as HTTP endpoints.

- `POST /api/votes/quote`: creates a post-vote quote and fee invoice
- `POST /api/fees/settle`: assesses the fee-post vote settlement
- `GET /health`: service health check

The current store is intentionally in-memory. Replace it with Postgres repositories before production use.

### Web

`apps/web` is a focused React interface for the main workflow:

1. user enters account, post, and desired USD vote value
2. system calculates the vote weight
3. system shows the fee invoice and required fee-post vote
4. warnings show when the target vote is not currently possible

## Adapter Boundaries

Production integrations should live behind interfaces:

- `PriceProvider`: token and reward-fund prices
- `AccountPowerProvider`: current voting power and estimated full-power vote value
- `VoteBroadcaster`: submit post votes and fee-post votes
- `InvoiceRepository`: persist invoices and status changes
- `ConsentRepository`: store user authorization for automated fee-post votes

Keeping these boundaries small avoids repeating the old coupling between routes, DB entities, and bot code.
