# IndexFeed — Algorand edition

Pay-per-request crypto market and index data for AI agents. Every route is metered
in USDC over [x402](https://x402.org) on Algorand: no API key, no account, no
subscription. A caller gets `402 Payment Required`, pays a fraction of a cent, and
receives the data on the retry.

Built for the [Global x402 Challenge](https://algorand.co/blog/the-x402-global-challenge-is-live-how-to-build-submit-your-entry).

```
                          INDEXFEED
                       Algorand edition
                              │
              ┌───────────────┴───────────────┐
              │                               │
        Index engine                    x402 gateway
              │                               │
   4 price feeds, reconciled          USDC, ASA 31566704
   by median with a 500bps trim       GoPlausible facilitator
              │                               │
   Rules-based screen + cap           Algorand MainNet
              │                               │
   Signed, append-only epochs        Bazaar discovery
              │                               │
              └───────────────┬───────────────┘
                              ▼
                     8 paid HTTP routes
                              │
                              ▼
                          AI agents
```

This is a sibling of, not a fork of, the Stellar/Soroban
[IndexFeed](https://github.com/greyw0rks/indexfeed). One chain, one payment rail,
one use case, and nothing here knows about Soroban.

The index engine started as the same rulebook, hash for hash, and it no longer is:
this edition runs methodology **v1.2.0** (`f1aeadd8a1d9…`) against the Soroban
edition's v1.1.0 (`65a4bcc8943d…`). The difference is one rule. Classifying a
stablecoin from 24h and 7d volatility alone cannot tell a peg from a quiet week, and
on 2026-09-05 it did not: ETH moved 0.42% and 0.40% over those two windows and was
excluded as a stablecoin, which would have published a top-20 crypto index with no
ETH in it. v1.2.0 adds a 30-day veto — the same day, stables sat at 0.1% while ETH
had moved 28.5%. The hash moving is the mechanism working; the rulebook changed, so
the identifier for the rulebook had to change with it.

## Routes

| Route | Price | What you get |
|---|---|---|
| `GET /v1/index/tick` | $0.001 | Live index level marked to current prices, with drifted weights |
| `GET /v1/index/latest` | $0.01 | Latest published epoch: committed level, target weights, digest |
| `GET /v1/index/constituents` | $0.01 | Composition of the latest epoch and the rules it was screened under |
| `GET /v1/index/history` | $0.02 | Every published epoch number, with head and cadence |
| `GET /v1/index/history/:epoch` | $0.02 | One historical epoch, as published |
| `GET /v1/assets/quote?symbols=` | $0.005 | Reconciled USD price per asset, with agreeing venues and discarded outliers |
| `GET /v1/assets/market?limit=` | $0.01 | Ranked market table with turnover and index membership |
| `GET /v1/asset/:symbol` | $0.005 | One asset in full, including why it is or is not in the index |

Free, and deliberately so — a caller cannot decide to pay without them:
`GET /` (service + prices + network), `GET /health`, `GET /.well-known/x402`,
`GET /llms.txt`.

## Why the tick route is a tenth of the price

The leaderboard number is **USDC settled to the endpoint** — volume, not call count —
measured over an undisclosed window in October. Taken literally that argues for
raising every price, since the same traffic then reports a bigger number.

This is priced the other way on purpose, for two reasons.

The first is that volume is trivially manufacturable here and therefore weak
evidence. The facilitator pays the Algorand transaction fee, so a loop that pays
from a wallet we own to a wallet we own nets to zero cost and can print an arbitrary
leaderboard figure. Ten finalists are chosen from submitted material *together with*
leaderboard activity, by people who can read a payer address — so the number worth
having is one that third parties produced, and the way to get that is to be worth
polling.

The second is what the live field actually shows. Filtering `/discovery/merchants`
to Algorand MainNet: the top merchant runs **one** endpoint with ~299k settlements,
while a merchant with **593** endpoints sits sixth on 2% of that volume. Median
merchant: 247 settlements. Breadth does not buy usage — a standing reason to poll
does.

So `/v1/index/tick` is a distinct product rather than a cheap alias for `latest`. It
is the basket marked to current prices, so it genuinely changes between reads, and
at $0.001 an agent polling it every thirty seconds is buying data rather than making
a donation. The other seven routes are the credibility of the offering; the tick is
the part something has a reason to call again in thirty seconds.

## What makes the index checkable

IFX20 is rules-based, never curated. Candidates are screened on free-float market
cap, 24h turnover, and listing age; stablecoins, wrapped/staked duplicates, and
commodity tokens are excluded by classification rather than by denylist; survivors
are weighted by market cap under a 25% single-name cap, applied iteratively;
rebalance cadence is 7 days.

Prices come from four feeds — Bitstamp and Bitfinex (independent exchanges) plus
CoinGecko and CoinPaprika (composites) — reconciled by median with any source more
than 500bps away discarded. An asset with fewer than two agreeing sources is *not
priced* rather than priced badly. At least one real exchange is required in the mix,
because a consensus built only from aggregators agrees with itself while being
wrong in the same direction.

Two independent digests ship with every epoch. `methodologyHash` covers the
rulebook, so a consumer can tell whether two epochs were computed under the same
rules. `attestation.digest` covers the epoch payload, signed Ed25519 by a key that
exists only to attest and cannot move funds. `GET /` publishes that key under
`attestation.publicKey` alongside the recipe: delete the `attestation` block,
re-canonicalize with keys sorted, sha256, then check the signature over the digest.

**Be precise about the guarantee.** The Soroban edition writes epochs to a
contract, so a reader trusts no one. Here `epochStore.append` reproduces the
contract's invariant — epoch N is accepted only when N equals head + 1, never
overwritten — but it is enforced by this server, not by a chain. The signature
narrows the gap; it does not close it. With no key loaded, `/` reports
`attestation.signed: false` and drops the public key rather than implying otherwise.

## Getting it running

```bash
npm install
cp .env.example .env

# 1. Generate the payout account. Save the mnemonic; it is printed once and
#    written nowhere. The API never needs it — receiving an ASA needs no signature.
npm run account:new

# 2. Put the address in .env as X402_PAY_TO, fund it with ~0.3 ALGO, then opt in.
#    Without the opt-in, /verify passes and only /settle fails, so the integration
#    looks healthy right up to the first real payment.
ALGORAND_NETWORK=mainnet npm run account:optin -- "<25 words>"
ALGORAND_NETWORK=mainnet npm run account:check

# 3. Confirm the facilitator will settle what we quote.
ALGORAND_NETWORK=mainnet npm run probe

# 4. Publish the first epoch, then serve.
npm run rebalance --workspace @indexfeed-algorand/engine
npm start
```

Offline, with no network and no wallet:

```bash
USE_FIXTURE_PRICES=1 npm run rebalance --workspace @indexfeed-algorand/engine
USE_FIXTURE_PRICES=1 X402_PAY_TO=<any valid address> npm start
```

Buying data as an agent:

```bash
# PAYER_MNEMONIC in .env — a different wallet from X402_PAY_TO
npm run pay -- https://<host>/v1/index/tick
npm run poll          # sustained consumer, hard-capped by MAX_SPEND_USDC
```

Tests: `npm test` — 108 across the three workspaces, all offline. The paid path is
covered with a stubbed facilitator; real settlement is proven by `npm run probe`
plus a live paid read.

## Integration notes worth knowing before you copy the docs

Both of these were found by probing the live service, not by reading the guides.
Both fail in the way that costs the most time: everything looks healthy.

**Build the CAIP-2 id from the genesis hash, not from `ALGORAND_*_CAIP2`.**
`@x402/avm` 2.24 exports the network id truncated to 32 characters per the CAIP-2
reference limit (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k`), while the facilitator
advertises the full base64 genesis hash (`…N73ktiC1qzkkit8=`). The package ships
`normalizeAlgorandNetwork`, but `x402ResourceServer` does **not** apply it when
matching routes against supported kinds — it compares strings. Quote the constant
and every paid route returns 500 `missing_facilitator` while `/`, `/health`, and the
middleware's own startup sync all report success. `assertFacilitatorSupport` turns
that into a boot failure with the near-miss spelled out.

**Every `pathParams` needs a `pathParamsSchema`; every `input` needs an
`inputSchema`.** Supply the data without the schema and `declareDiscoveryExtension`
emits an extension its own validator rejects with `/input: must NOT have additional
properties`. The route still serves and still takes payment — it just never enters
the Bazaar catalog, so the leaderboard never sees it. The middleware logs this at
warning level; `assertRoutesDiscoverable` throws instead.

Also: use `@x402/extensions` (2.24.x), not `@x402-avm/extensions` (2.6.1, untouched
since March). The published walkthrough imports the stale one and papers over the
resulting type mismatch with `as unknown as ResourceServerExtension`.

## Two honest caveats

**First-party traffic is first-party.** `npm run poll` settles real USDC on MainNet,
but from a wallet we control to a wallet we control, with the facilitator absorbing
the fee — so it costs float and nothing else. That is exactly why it is treated as
the reference consumer and the demo rather than as the strategy: a leaderboard
position built on it is a number we chose, and it is fragile in a way one built on
third-party callers is not.

**The poller spends real money.** At $0.001 a tick, one call every five seconds is
about $17/day. `MAX_SPEND_USDC` is checked before every request, because x402
settles *inside* the fetch and an unattended loop with a wallet is exactly the thing
that empties an account over a weekend.

The same reasoning drives the freshness gate: the payment settles before the handler
runs, so anything that could refuse a request has to refuse it while the request is
still free. `/v1/index/tick` returns an unpaid 503 when the price snapshot is stale
rather than selling a level the caller has no way to identify as out of date.

## Deploying

`railway.json` ships the service config; deploy from the repo root, because the API
workspace resolves `@indexfeed-algorand/engine` through the root `node_modules`.

```bash
railway up
railway variables --set ALGORAND_NETWORK=mainnet \
  --set X402_PAY_TO=<address> \
  --set PUBLIC_BASE_URL=https://<service>.up.railway.app \
  --set ATTEST_PRIVATE_KEY=<base64 from npm run attest-key>
```

Three parts of that config are load-bearing:

**`PUBLIC_BASE_URL` is not optional in production.** Without it the middleware
derives the resource URL from the request, which behind Railway's proxy is the
internal host — so the Bazaar catalog lists an address no caller can reach while
payments settle perfectly well.

**The healthcheck points at `/`, not `/health`.** `/health` returns 503 when the
price snapshot goes stale, which is correct for a caller deciding whether to spend
and wrong for a liveness probe: an upstream feed having a bad ten minutes would
otherwise put the container into a restart loop and take down the routes that were
still fine. `/` answers "is the process up", which is what the platform is asking.

**One replica.** Epochs are published by running the rebalancer locally and
committing `state/`, so replicas would be read-only and identical — but nothing in
the epoch store enforces a single writer, and the divisor that makes epoch N+1
continuous with epoch N lives in that same directory. Scaling out is a schema
change, not a slider.

## Layout

```
packages/engine   chain-free: price reconciliation, screening, index math,
                  epoch store, attestation. Knows nothing about Algorand or HTTP.
packages/api      x402-metered express surface, Bazaar declarations, freshness gate
packages/client    paying fetch + the reference consumer / poller
scripts           account generation, USDC opt-in, readiness and facilitator probes
state             published epochs + continuity divisor (tracked in git on purpose:
                  there is no contract holding the divisor on this rail)
```
