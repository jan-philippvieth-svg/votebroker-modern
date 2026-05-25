# Vote-Funded Billing Model

The goal is to avoid direct upfront payment. Users pay VoteBroker by allowing an automated vote on a designated fee post.

## Flow

1. User chooses a desired USD vote value for a post.
2. VoteBroker estimates the required vote weight.
3. VoteBroker calculates a fee invoice from the expected vote value.
4. VoteBroker broadcasts the user's post vote.
5. VoteBroker broadcasts a second vote from the user to the configured fee post.
6. The invoice is settled when the fee-post vote value covers the invoice amount.

## Account States

- `active`: account can vote and fee votes are settling
- `warning`: fee votes have been underfunded repeatedly
- `paused`: VoteBroker stops new automated post votes until voting power recovers
- `payment_required`: automated recovery has failed for too long and manual unlock is required

## Important Product Rules

- The user must explicitly authorize automated fee-post votes.
- The fee post must be visible and auditable.
- Every invoice should reference the original post vote.
- Every settlement should verify the actual chain transaction, not just an estimate.
- Users should see upcoming fee votes before enabling automation.

## Suggested Defaults

- Platform fee: `3%` of expected vote value
- Minimum fee: `$0.05`
- Warning after `2` underfunded fee attempts
- Pause after `4` underfunded fee attempts
- Manual unlock after additional sustained underfunding

These values are configurable in `apps/api/src/config.ts`.

## Risk Notes

Vote value is not a guaranteed USD payment. It depends on reward pool state, token price, voting power, curation rules, post payout timing, and chain-specific behavior. The UI should call this an estimated fee settlement, not a guaranteed cash payment.
