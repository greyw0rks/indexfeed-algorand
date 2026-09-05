/**
 * Generate the Algorand account that receives USDC.
 *
 * This address is the competition's attribution key: the leaderboard groups by
 * payTo, and the rules say the same payTo is used for the whole competition. So
 * changing it later does not move volume across — it starts a second merchant with
 * zero history. Generate once, save the mnemonic, and do not regenerate.
 *
 * The mnemonic is printed to stdout and never written to disk. That is deliberate:
 * a file written here would be one `git add .` away from a public repo, and this
 * key controls real USDC on MainNet. Copy it into a password manager, put the
 * address in `.env` as X402_PAY_TO, and keep the mnemonic out of the repo entirely
 * — the API never needs it, because receiving USDC requires no signature.
 *
 * Usage: node scripts/new-account.js
 */
import algosdk from "algosdk";

const account = algosdk.generateAccount();
const address = account.addr.toString();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

console.log(`
Algorand account generated. Nothing has been written to disk.

  ADDRESS   ${address}

  MNEMONIC  ${mnemonic}

Next, in order:

  1. Save the mnemonic somewhere durable and private. It is shown once. The API
     does not need it — receiving an ASA transfer requires no signature — so it
     should not end up in .env or in this repo.

  2. Put the address in .env:

       X402_PAY_TO=${address}

  3. Fund it with a small amount of ALGO. Roughly 0.3 ALGO covers the minimum
     balance plus the opt-in; the facilitator pays the transaction fees on
     payments themselves, so this is a one-off, not a running cost.

  4. Opt in to USDC, or it cannot be paid at all:

       ALGORAND_NETWORK=mainnet node scripts/optin-usdc.js "<mnemonic>"

     An account that is not opted in to the USDC ASA makes every settlement fail
     while /verify still succeeds, so the integration looks healthy right up to
     the first real payment.

  5. Confirm before going live:

       ALGORAND_NETWORK=mainnet node scripts/check-account.js ${address}
`);
