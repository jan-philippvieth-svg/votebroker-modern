# Security Notes

## Server-Side Steem Broadcasting

VoteBroker follows the SteemDunk production pattern for automated votes:

- SteemConnect code flow is the production default.
- Users authorize the `VOTEBROKER_BROADCAST_ACCOUNT` with posting authority.
- VoteBroker stores no private user keys.
- `VOTEBROKER_POSTING_WIF` is read only by the API process from server-side environment variables.
- The web app never imports `dsteem` and never receives the posting WIF.

Before a server-side vote is broadcast, the API checks:

- a valid VoteBroker session exists
- the required consent is active
- the user has authorized `VOTEBROKER_BROADCAST_ACCOUNT` in posting authority
- `VOTEBROKER_POSTING_WIF` is configured
- the account is not paused or payment-required
- the vote weight and quote inputs are plausible

The optional access-token broadcast path is only for manual fallback mode and is disabled unless `VOTEBROKER_MANUAL_TOKEN_FALLBACK=true`.

## dsteem Runtime Dependency

`dsteem` is installed only in `@votebroker/api` and is used only server-side for signing and broadcasting Steem operations.

Local dependency inspection shows this runtime chain:

```text
dsteem@0.11.3
+-- bs58@4.0.1
+-- core-js@2.6.12
+-- secp256k1@3.8.1
    +-- elliptic@6.6.1
```

`core-js@2` is deprecated. In this project it is a transitive server-side dependency of `dsteem`; it is not shipped in the Vite web bundle. The current runtime exposure is therefore limited to the API container.

`npm audit --omit=dev` could not be completed in this workspace because the npm audit endpoint returned an error. Before production launch, run this on the deployment machine:

```bash
npm audit --omit=dev
```

If runtime vulnerabilities are reported for `dsteem` or its cryptographic dependencies, prefer replacing the broadcaster with a maintained Steem-compatible signing library or a minimal audited RPC signer rather than exposing the optional token fallback as the default.
