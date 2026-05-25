# Consent Model

VoteBroker separates technical login permissions from product-level consent.

SteemConnect scopes such as `login,vote` are necessary for signed blockchain actions, but they do not automatically authorize VoteBroker to execute every possible vote. The application maintains its own explicit consent layer for user trust, auditability, and revocation.

## Consent Types

### Login-Consent

Allows VoteBroker to identify the user through SteemConnect and create a local session.

Scope:

- read account identity
- create local VoteBroker session

### Vote-Consent

Allows VoteBroker to execute target votes that the user requested or confirmed.

Scope:

- calculate vote weight from USD target value
- vote the selected target post
- record the action in VoteBroker history

### Fee-Post-Consent

Allows VoteBroker to settle transparent platform fees through a vote on the configured fee post.

Scope:

- show the fee post before execution
- calculate fee vote weight
- execute fee vote only for an open invoice

This consent is required before VoteBroker may perform fee-post votes. A SteemConnect `vote` scope alone is not sufficient.

### Optional Auto-Vote-Consent

Allows VoteBroker to execute matching votes automatically under configured limits.

Scope:

- follow user-defined automation rules
- respect account status and voting-power limits
- stop immediately after revoke

## Revoke

Every consent can be revoked. A revoke creates a history entry and removes the consent from the active set. Future operations must check active consent before executing blockchain actions.

## History

The consent history records:

- consent type
- status: `granted` or `revoked`
- timestamp
- user
- scope shown at the time of consent

Production persistence should store this in Postgres or an append-only audit table.

## Enforcement

Current enforcement:

- `fee_post_vote` is required before `/api/fees/settle` can proceed.

Planned enforcement:

- `target_vote` required before broadcasting a target post vote.
- `auto_vote` required before scheduled or rule-based votes.
- `login` granted automatically after successful SteemConnect login, or explicitly confirmed during onboarding.
