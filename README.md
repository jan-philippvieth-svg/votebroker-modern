# VoteBroker Modern

VoteBroker Modern is a TypeScript reference architecture for USD-targeted social blockchain voting.

Instead of asking users to choose an abstract vote percentage, VoteBroker lets them choose the desired USD value of a vote. The system estimates the required vote weight, creates a fee invoice, and settles that fee through an automated vote on a transparent fee post. The result is a payment flow where users do not transfer money directly; they pay with voting power.

This repository is structured as a portfolio-grade example of modern TypeScript architecture: domain-first business rules, explicit service boundaries, a typed API layer, and a focused React interface.

![VoteBroker dashboard](docs/assets/dashboard.png)

## Highlights

- **USD-targeted voting**: users enter a desired vote value such as `$2.50`; the system calculates the required vote weight.
- **Vote timing recommendation**: users can pick fixed vote delays or let Auto Timing recommend a slot from historical performance buckets.
- **Vote-funded billing**: platform fees are settled through an automated vote on a configured fee post.
- **Fair-use payment rules**: small accounts can use the platform for free or support it voluntarily until fee-by-vote billing becomes fair.
- **Community pool foundation**: shared curation pools expose member status, pool policy, fee ratio, and account health.
- **Explicit consent layer**: SteemConnect login does not silently authorize fee-post votes.
- **Domain-first architecture**: core business rules live in a framework-independent package.
- **Typed API surface**: Fastify + Zod validate requests before calling workflows.
- **Modern frontend**: Vite + React UI for the main quote workflow.
- **Explicit integration ports**: blockchain, pricing, invoices, and consent can be replaced independently.
- **Tested core logic**: unit tests cover USD quote calculation and billing state transitions.

## Product Model

VoteBroker has two coordinated vote flows:

1. **Post vote**: the user chooses how much USD value they want to give to a target post and when the vote should execute.
2. **Fee-post vote**: VoteBroker calculates its fee and settles it by casting a second vote from the user to a designated fee post.

If voting power is too low to settle fees over time, the account moves through billing states:

- `active`: account can use automated voting
- `warning`: fee votes have been underfunded repeatedly
- `paused`: new automated post votes are stopped until voting power recovers
- `payment_required`: manual unlock or payment is required

Vote timing is modeled as a recommendation layer. The user can choose a fixed delay such as `5`, `10`, `15`, `20`, `25`, or `30` minutes after post creation, or use `auto`. Auto Timing scores observed timing buckets by curation efficiency, author reward stability, competing vote density, reversal risk, sample size, and voting-power context.

Payment is modeled as a fair-use policy, not a debt trap. Very small votes run in `free` mode, small or underpowered accounts can enter `donation` mode, healthy accounts use `billable` mode, temporary undercoverage uses `grace`, and unhealthy accounts can be `paused`. The quote response always explains why a mode was selected and whether a fee is required.

## Architecture

```mermaid
flowchart LR
  User["User"] --> Web["React Web App"]
  Web --> API["Fastify API"]
  API --> Workflow["VoteBroker Workflow"]
  Workflow --> Domain["Domain Package"]
  Workflow --> Ports["Integration Ports"]

  Domain --> VoteMath["USD Vote Math"]
  Domain --> Timing["Vote Timing Recommendation"]
  Domain --> Billing["Fee Invoice + Billing State"]
  Domain --> Pool["Community Pool + Health Score"]

  Ports --> AccountPower["Account Power Provider"]
  Ports --> VoteBroadcaster["Vote Broadcaster"]
  Ports --> InvoiceRepo["Invoice Repository"]
  Ports --> ConsentRepo["Consent Repository"]

  AccountPower -. future .-> Chain["Hive / Steem / Blurt"]
  VoteBroadcaster -. future .-> Chain
  InvoiceRepo -. future .-> Postgres["Postgres"]
  ConsentRepo -. future .-> Postgres
```

### Recommendation Layer

```mermaid
flowchart TD
  Request["Vote Quote Request"] --> TimingMode{"Timing Mode"}
  TimingMode -->|manual| Manual["Selected Delay\n5-30 minutes"]
  TimingMode -->|auto| Buckets["Historical Timing Buckets"]
  Buckets --> Score["Recommendation Scoring"]
  Manual --> Result["Vote Timing Recommendation"]
  Score --> Result
  Account["Voting Power Snapshot"] --> Score
  Score --> Factors["Efficiency\nStability\nCompetition\nRisk\nSample Confidence"]
  Result --> Quote["USD Vote Quote + Fee Invoice"]
```

## Workspace Layout

```text
VoteBroker_modern/
  apps/
    api/              Fastify API and workflow orchestration
    web/              React/Vite user interface
  packages/
    domain/           Pure TypeScript domain logic
  docs/
    ARCHITECTURE.md   Technical architecture notes
    BILLING_MODEL.md  Vote-funded billing model
    MIGRATION.md      Migration plan from the legacy project
```

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js 20+
- **API**: Fastify, Zod
- **Frontend**: React, Vite, lucide-react
- **Testing**: Node test runner
- **Build**: npm workspaces, TypeScript compiler, Vite

## Setup

```bash
npm install
npm run build
npm test
```

## Docker Deployment

```bash
docker compose up -d --build
```

The web container serves the React app and proxies `/api` to the Fastify service. Production notes for `votebroker.org` live in [Deployment](docs/DEPLOYMENT.md).

Start the API:

```bash
npm run dev:api
```

Start the web app:

```bash
npm run dev:web
```

Default local URLs:

- API: `http://localhost:3000`
- Web: `http://localhost:5173`
- Production preview: `npm run preview -w @votebroker/web`

## Environment

Copy `.env.example` and adjust values as needed.

```env
PORT=3000
HOST=0.0.0.0
VOTEBROKER_FEE_BPS=300
VOTEBROKER_MIN_FEE_USD=0.05
VOTEBROKER_FEE_POST_AUTHOR=votebroker
VOTEBROKER_FEE_POST_PERMLINK=monthly-fees
VOTEBROKER_WARNING_AFTER_FAILURES=2
VOTEBROKER_PAUSE_AFTER_FAILURES=4
VOTEBROKER_FREE_UNTIL_VOTE_USD=0.25
VOTEBROKER_DONATION_UNTIL_VOTE_USD=1
VOTEBROKER_MAX_FEE_VOTE_WEIGHT_BPS=2000
VOTEBROKER_GRACE_CONSECUTIVE_FAILURES=2
VOTEBROKER_OPERATOR_TOKEN=change-me
VITE_API_BASE=http://localhost:3000
STEEMCONNECT_HOST=https://api.steemconnect.com
STEEMCONNECT_CLIENT_ID=votebroker
STEEMCONNECT_CLIENT_SECRET=
STEEMCONNECT_REDIRECT_URI=http://localhost:5173/auth/callback
STEEMCONNECT_SCOPES=login,vote
```

## API Examples

### Health Check

```bash
curl http://localhost:3000/health
```

Response:

```json
{
  "status": "ok",
  "service": "votebroker-api"
}
```

### SteemConnect Login URL

```bash
curl http://localhost:3000/api/auth/steemconnect/url
```

Response:

```json
{
  "url": "https://api.steemconnect.com/oauth2/authorize?client_id=votebroker&..."
}
```

## Consent Model

VoteBroker treats SteemConnect permissions as technical capability, not as blanket product consent.

The user must separately confirm:

- `login`: local VoteBroker session and identity
- `target_vote`: user-requested post votes
- `fee_post_vote`: transparent service-fee votes on the configured fee post
- `auto_vote`: optional automation under user-defined limits

Every consent can be revoked and every change is written to consent history. Fee-post settlement is blocked unless `fee_post_vote` consent is active.

See [Consent Model](docs/CONSENT_MODEL.md).

After SteemConnect redirects back with a `code`, exchange it for a local VoteBroker session:

```bash
curl -X POST http://localhost:3000/api/auth/steemconnect/callback \
  -H "Content-Type: application/json" \
  -d '{
    "code": "steemconnect-code"
  }'
```

Response:

```json
{
  "token": "local-session-token",
  "expiry": "2026-05-28T10:00:00.000Z",
  "user": {
    "username": "demo",
    "provider": "steemconnect"
  }
}
```

### Quote A USD Vote

```bash
curl -X POST http://localhost:3000/api/votes/quote \
  -H "Content-Type: application/json" \
  -d '{
    "username": "demo",
    "author": "alice",
    "permlink": "example-post",
    "desiredVoteUsd": 2.5,
    "timingMode": "auto"
  }'
```

Example response:

```json
{
  "account": {
    "username": "demo",
    "votingPowerBps": 8000,
    "fullPowerVoteUsd": 10,
    "status": "active",
    "consecutiveUnderfundedFees": 0
  },
  "quote": {
    "author": "alice",
    "permlink": "example-post",
    "desiredVoteUsd": 2.5,
    "expectedVoteUsd": 2.5,
    "voteWeightBps": 3125,
    "capped": false,
    "warnings": [],
    "timing": {
      "mode": "auto",
      "selectedDelayMinutes": 15,
      "scheduledAt": null,
      "confidencePct": 100,
      "score": 84,
      "rationale": [
        "15 Minuten ist aktuell der staerkste Slot aus den Erfahrungsdaten.",
        "Score 84/100 bei 100% Datenvertrauen und 18% Timing-Risiko."
      ],
      "options": [
        {
          "delayMinutes": 5,
          "score": 70,
          "confidencePct": 70,
          "expectedCurationPct": 83,
          "riskPct": 30,
          "label": "5 min nach Post-Erstellung"
        },
        {
          "delayMinutes": 10,
          "score": 80,
          "confidencePct": 97,
          "expectedCurationPct": 89,
          "riskPct": 21,
          "label": "10 min nach Post-Erstellung"
        },
        {
          "delayMinutes": 15,
          "score": 84,
          "confidencePct": 100,
          "expectedCurationPct": 92,
          "riskPct": 18,
          "label": "15 min nach Post-Erstellung"
        }
      ]
    }
  },
  "feeInvoice": {
    "amountUsd": 0.08,
    "feePostAuthor": "votebroker",
    "feePostPermlink": "monthly-fees",
    "requiredVoteWeightBps": 94,
    "status": "open",
    "billingMode": "billable",
    "transparency": {
      "headline": "Billable Mode",
      "detail": "Die Fee kann voraussichtlich mit 0.94% Vote-Gewicht gedeckt werden.",
      "userMessage": "Die Plattformgebuehr wird transparent per Fee-Post-Vote beglichen.",
      "donationAllowed": false,
      "feeRequired": true,
      "reasons": [
        "Der Account kann die Fee voraussichtlich mit angemessenem Vote-Gewicht decken.",
        "Die Gebuehr wird transparent ueber den ausgewiesenen Fee-Post-Vote beglichen."
      ]
    }
  }
}
```

### Quote A Vote With Manual Timing

```bash
curl -X POST http://localhost:3000/api/votes/quote \
  -H "Content-Type: application/json" \
  -d '{
    "username": "demo",
    "author": "alice",
    "permlink": "example-post",
    "desiredVoteUsd": 2.5,
    "timingMode": "manual",
    "voteDelayMinutes": 20,
    "postCreatedAt": "2026-05-26T10:00:00.000Z"
  }'
```

The response keeps the selected delay and includes a calculated `scheduledAt` timestamp.

### Settle A Fee Invoice

```bash
curl -X POST http://localhost:3000/api/fees/settle \
  -H "Content-Type: application/json" \
  -d '{
    "invoiceId": "fee-invoice-id"
  }'
```

This endpoint currently simulates settlement against the in-memory account snapshot. In production it should verify the actual chain transaction before marking an invoice as settled.

### Internal Operator Overview

The internal operator dashboard is available at `/operator` in the web app and reads only real runtime data from invoices and accounts. It is protected by `VOTEBROKER_OPERATOR_TOKEN`.

```bash
curl http://localhost:3000/api/operator/overview \
  -H "x-operator-token: change-me"
```

If no invoices exist yet, revenue values are `0` and lists are empty. The endpoint does not fabricate demo revenue.

## Domain Example

The core business logic can be used without Fastify, React, or a database:

```ts
import { quoteUsdVote } from "@votebroker/domain";

const quote = quoteUsdVote({
  author: "alice",
  permlink: "example-post",
  desiredVoteUsd: 2.5,
  timing: {
    mode: "auto"
  },
  account: {
    username: "demo",
    votingPowerBps: 8000,
    fullPowerVoteUsd: 10,
    status: "active",
    consecutiveUnderfundedFees: 0
  }
});

console.log(quote.voteWeightBps); // 3125 = 31.25%
console.log(quote.timing.selectedDelayMinutes); // 15
```

## Test Status

Current local verification:

```text
npm run typecheck  PASS
npm run build      PASS
npm test           PASS
```

Covered domain behavior:

- USD vote quote calculation
- auto and manual vote timing recommendation
- fee invoice calculation
- fair-use payment modes for free, donation, billable, grace, and paused accounts
- account pause state after repeated underfunded fee votes
- community pool account health scoring

## Design Principles

- **Business logic is portable**: calculations and billing transitions are plain TypeScript.
- **Infrastructure is replaceable**: chain access, persistence, consent, and broadcasting sit behind ports.
- **User intent is explicit**: the UI models desired USD value instead of exposing raw vote weight first.
- **Billing is auditable**: fee-post settlement creates a visible on-chain payment trail.
- **Failure states are productized**: low voting power becomes warning, pause, and unlock states rather than hidden errors.

## Current Limitations

- Account power, vote value, and invoices are mocked in memory.
- Vote timing uses seeded performance buckets until real execution history is stored.
- Community pool data is currently demo-backed rather than persisted.
- Fee settlement is estimated, not verified against real blockchain transactions.
- Consent storage for automated fee-post votes is represented as a port but not implemented.
- The current UI is a focused workflow prototype, not a complete dashboard.
- Security, rate limiting, authentication, and production observability still need to be added.

## Roadmap

### Phase 1: Production Adapters

- Implement Hive/Steem/Blurt account power provider.
- Implement live price/reward-fund provider.
- Implement vote broadcaster for post votes and fee-post votes.
- Persist vote execution history for timing recommendations.
- Verify real chain transactions before settlement.

### Phase 2: Persistence And Auth

- Add Postgres invoice repository.
- Store account billing status and failure counters.
- Add user authentication and signed consent for automated fee-post votes.
- Add audit log for every vote, invoice, and settlement attempt.
- Persist community pools, memberships, policies, and health score inputs.

### Phase 3: Product UX

- Add account dashboard.
- Add pool administration for member roles, curation rules, budgets, and allowed tags.
- Add timing analytics that compare manual slots with Auto Timing outcomes.
- Add fee-post transparency page.
- Add warnings for low voting power before automation fails.
- Add admin unlock and manual payment workflow.

### Phase 4: Operations

- Add CI pipeline.
- Add Docker image and deployment configuration.
- Add structured logging, metrics, and alerting.
- Add integration tests with mocked chain adapters.

## Related Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Billing Model](docs/BILLING_MODEL.md)
- [Consent Model](docs/CONSENT_MODEL.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Migration Notes](docs/MIGRATION.md)

## Portfolio Note

This project is intentionally structured to demonstrate modern backend design more than raw feature volume: domain isolation, typed boundaries, testable business rules, and clear migration paths from legacy code to a maintainable service architecture.
