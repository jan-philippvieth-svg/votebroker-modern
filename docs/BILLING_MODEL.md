# Vote-Funded Billing And Fair Use Model

The goal is to avoid direct upfront payment. Healthy accounts pay VoteBroker by allowing an automated vote on a designated fee post. Small or underpowered accounts should not be pushed into hidden debt; they can use the platform for free or support it voluntarily until fee-by-vote billing becomes fair.

## Flow

1. User chooses a desired USD vote value for a post.
2. VoteBroker estimates the required vote weight.
3. VoteBroker evaluates fair-use payment rules.
4. VoteBroker either waives the fee, offers optional donation, or creates a fee invoice.
5. VoteBroker broadcasts the user's post vote.
6. If required and explicitly consented, VoteBroker broadcasts a second vote from the user to the configured fee post.
7. The invoice is settled when the fee-post vote value covers the invoice amount.

## Fair Use Billing Modes

### `free`

Very small votes run without mandatory billing.

- no fee invoice amount
- no hidden unpaid balance
- optional support vote can be shown
- intended for new or tiny users

### `donation`

The account may use VoteBroker without mandatory payment because the fee would be unfair relative to the user's current voting power.

- no required fee-post vote
- voluntary support vote is allowed
- useful while a user is growing
- should be communicated as support, not debt

### `billable`

The account can reasonably cover the platform fee.

- invoice amount is calculated from expected vote value
- fee-post vote is required before settlement
- consent for fee-post votes must be active
- the UI shows required fee weight and fee post target

### `grace`

The account was recently underfunded but is not blocked yet.

- fee is still required
- the user receives a transparent warning
- automation can continue for a limited number of failures
- prevents punishing temporary voting-power dips

### `paused`

The account should not create new mandatory billing actions until it recovers.

- no new required fee invoice
- optional donation can still be allowed
- automation should stop or require manual review
- protects both the user and the platform from unfair accumulation

## Mode Selection

VoteBroker currently evaluates:

- expected vote value
- configured free threshold
- configured donation threshold
- available full-vote USD value
- required fee vote weight
- maximum fair fee-vote weight
- previous underfunded fee attempts
- current account billing status

Default configuration:

```env
VOTEBROKER_FEE_BPS=300
VOTEBROKER_MIN_FEE_USD=0.05
VOTEBROKER_FREE_UNTIL_VOTE_USD=0.25
VOTEBROKER_DONATION_UNTIL_VOTE_USD=1
VOTEBROKER_MAX_FEE_VOTE_WEIGHT_BPS=2000
VOTEBROKER_GRACE_CONSECUTIVE_FAILURES=2
VOTEBROKER_WARNING_AFTER_FAILURES=2
VOTEBROKER_PAUSE_AFTER_FAILURES=4
```

## Transparency Contract

Every quote response includes billing transparency:

```json
{
  "billingMode": "donation",
  "transparency": {
    "headline": "Donation Mode",
    "detail": "Eine Pflichtgebuehr waere fuer diesen Account aktuell nicht fair.",
    "userMessage": "Du kannst VoteBroker freiwillig per Support-Vote helfen, musst aber nicht.",
    "donationAllowed": true,
    "feeRequired": false,
    "reasons": [
      "Die faire Gebuehr waere im Verhaeltnis zur aktuellen Voting Power zu teuer.",
      "Der Nutzer kann freiwillig per Support-Vote helfen, muss aber nicht zahlen."
    ]
  }
}
```

The UI should always communicate:

- whether a fee is required
- whether donation is optional
- which fee post would be used
- why the mode was selected
- that no hidden fee debt is accumulated in `free` or `donation` mode

## Account States

- `active`: account can vote and fee votes are settling
- `warning`: fee votes have been underfunded repeatedly
- `paused`: VoteBroker stops new automated post votes until voting power recovers
- `payment_required`: automated recovery has failed for too long and manual unlock is required

## Important Product Rules

- The user must explicitly authorize automated fee-post votes.
- The fee post must be visible and auditable.
- Every invoice should reference the original post vote.
- `free` and `donation` mode must never silently accumulate unpaid fees.
- Every settlement should verify the actual chain transaction, not just an estimate.
- Users should see upcoming fee votes before enabling automation.

## Suggested Defaults

- Platform fee: `3%` of expected vote value
- Minimum fee: `$0.05`
- Free mode until vote value: `$0.25`
- Donation mode until vote value: `$1.00`
- Maximum fair fee-vote weight: `20%`
- Grace failures: `2`
- Warning after `2` underfunded fee attempts
- Pause after `4` underfunded fee attempts
- Manual unlock after additional sustained underfunding

These values are configurable in `apps/api/src/config.ts`.

## Risk Notes

Vote value is not a guaranteed USD payment. It depends on reward pool state, token price, voting power, curation rules, post payout timing, and chain-specific behavior. The UI should call this an estimated fee settlement, not a guaranteed cash payment.
