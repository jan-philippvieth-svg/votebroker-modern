# Migration From The Current Project

The current RAR contains useful code, but it mixes older Steemdunk-era routes, TypeORM entities, bot logic, and a newer minimal Koa entrypoint.

## Keep

- Entity concepts: users, premium/settings, authors, vote logs, vote tasks
- Existing bot responsibilities: comment, transfer, claim rewards
- API-v2 concepts if the existing frontend still depends on them
- The price-script idea as a temporary external adapter

## Replace Or Refactor

- Use one application entrypoint.
- Move route business rules into domain/services.
- Replace direct TypeORM `BaseEntity` usage with repositories.
- Upgrade Node runtime to current LTS.
- Pick one package manager.
- Replace `tslint`/old Mocha setup with current TypeScript tooling.
- Fix README encoding and document local setup.

## Price Script Integration

The old `scripts/beem_price.py` can stay temporarily as a `PriceProvider` implementation, but production should add:

- configurable Python executable
- timeout
- cached responses
- Docker installation for Python and `beem`
- structured errors
- tests for parse failure and provider outage

Long term, prefer a native TypeScript provider or a separate worker service.

## Suggested Order

1. Port the USD vote and billing domain into the existing backend.
2. Add database tables for invoices and account billing status.
3. Add consent screens and signed authorization.
4. Connect live chain adapters.
5. Replace the old start path with the modern API entrypoint.
6. Add the React UI or adapt the existing frontend to the new endpoints.
