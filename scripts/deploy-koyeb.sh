#!/usr/bin/env bash
#
# Deploy the IndexFeed API to Koyeb.
#
# Two-pass on purpose. The public domain is assigned by Koyeb when the app is
# created, and PUBLIC_BASE_URL has to carry that domain — without it the x402
# middleware derives the resource URL from the request, which behind Koyeb's
# router is an internal host. Payments still settle, but the Bazaar catalog
# advertises a URL no agent can reach, so the endpoint is invisible to exactly
# the traffic it exists to attract. So: create, read the domain back, redeploy
# with it set.
#
# Secrets are pushed as Koyeb secrets rather than plain env vars, and read from
# the local .env rather than passed as arguments, so the attestation private key
# never lands in a shell history or a CI log.
#
# Usage:  KOYEB_TOKEN=… scripts/deploy-koyeb.sh
#     or: koyeb login  &&  scripts/deploy-koyeb.sh
set -euo pipefail

APP=${APP:-indexfeed}
SERVICE=${SERVICE:-api}
REGION=${REGION:-was}
INSTANCE=${INSTANCE:-free}
PORT=${PORT:-8000}
REPO=${REPO:-github.com/greyw0rks/indexfeed-algorand}
BRANCH=${BRANCH:-main}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
KOYEB=${KOYEB:-$HOME/.koyeb/bin/koyeb}
cd "$ROOT"

# .env is the single source of truth for what the service runs with, so the
# deploy reads it rather than taking its own arguments — a deploy configured by
# hand is a deploy that drifts from the local one it was tested against.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^[A-Z_]+=' .env)
  set +a
fi

: "${X402_PAY_TO:?X402_PAY_TO must be set (in .env or the environment)}"
NETWORK=${ALGORAND_NETWORK:-testnet}

echo "==> app $APP / service $SERVICE  ($NETWORK, payTo ${X402_PAY_TO:0:8}…)"

"$KOYEB" app get "$APP" >/dev/null 2>&1 || "$KOYEB" app create "$APP"

# Attestation key as a secret. Recreated every run so a rotated local key is
# actually deployed; without the delete, `secret create` fails on the second run
# and the service keeps signing with the previous key.
if [[ -n "${ATTEST_PRIVATE_KEY:-}" ]]; then
  "$KOYEB" secret delete indexfeed-attest-key >/dev/null 2>&1 || true
  "$KOYEB" secret create indexfeed-attest-key --value "$ATTEST_PRIVATE_KEY" >/dev/null
  ATTEST_ENV=(--env "ATTEST_PRIVATE_KEY=@indexfeed-attest-key")
  echo "==> attestation key uploaded as a secret"
else
  ATTEST_ENV=()
  echo "==> WARNING: no ATTEST_PRIVATE_KEY — epochs will serve unsigned"
fi

deploy() {
  local public_base_url=$1
  local -a env_flags=(
    --env "ALGORAND_NETWORK=$NETWORK"
    --env "X402_PAY_TO=$X402_PAY_TO"
    --env "X402_FACILITATOR_URL=${X402_FACILITATOR_URL:-https://facilitator.goplausible.xyz}"
    --env "X402_CHALLENGE_TAG=${X402_CHALLENGE_TAG:-x402-global-challenge}"
    --env "PRICE_TTL_SECONDS=${PRICE_TTL_SECONDS:-20}"
    --env "PRICE_MAX_STALE_SECONDS=${PRICE_MAX_STALE_SECONDS:-180}"
    --env "PORT=$PORT"
    "${ATTEST_ENV[@]+"${ATTEST_ENV[@]}"}"
  )
  [[ -n $public_base_url ]] && env_flags+=(--env "PUBLIC_BASE_URL=$public_base_url")

  local verb=create
  "$KOYEB" service get "$SERVICE" --app "$APP" >/dev/null 2>&1 && verb=update

  "$KOYEB" service "$verb" "$SERVICE" --app "$APP" \
    --type web \
    --git "$REPO" \
    --git-branch "$BRANCH" \
    --git-builder buildpack \
    --git-buildpack-run-command "npm start --workspace @indexfeed-algorand/api" \
    --instance-type "$INSTANCE" \
    --regions "$REGION" \
    --ports "$PORT:http" \
    --routes "/:$PORT" \
    `# / and not /health: /health 503s on a stale price snapshot, which is right` \
    `# for a caller deciding whether to spend and wrong for a liveness probe —` \
    `# a bad ten minutes upstream would restart the container in a loop.` \
    --checks "$PORT:http:/" \
    `# Cold starts refetch four price feeds, so a sleeping service answers its` \
    `# first request with a freshness 503. The whole design assumes it is warm.` \
    --deep-sleep-delay 0 \
    "${env_flags[@]}"
}

deploy ""

DOMAIN=$("$KOYEB" app get "$APP" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["domains"][0]["name"])')
echo "==> domain https://$DOMAIN"
deploy "https://$DOMAIN"

cat <<EOF

Deployed. Verify in this order — each one catches a different silent failure:

  curl -s https://$DOMAIN/ | head -c 400
      payment.network must be the full genesis hash, not the 32-char truncation.

  curl -sD - -o /dev/null https://$DOMAIN/v1/index/tick | grep -i payment-required
      a 402 without that header is unpayable.

  curl -s https://$DOMAIN/ | python3 -c 'import json,sys; print(json.load(sys.stdin)["routes"][0]["resource"])'
      must be the public domain above, not an internal host.

Then settle once for real, which is what actually lists you in the catalog:

  npm run pay -- https://$DOMAIN/v1/index/tick
  curl -s "\${X402_FACILITATOR_URL:-https://facilitator.goplausible.xyz}/discovery/resources" \\
    | grep -c '$DOMAIN'
EOF
