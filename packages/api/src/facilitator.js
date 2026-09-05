/**
 * Startup check: does the facilitator settle exactly what we quote?
 *
 * This exists because of a specific failure that is invisible until a caller hits
 * a paid route. `x402ResourceServer` matches a route's network against the
 * facilitator's supported kinds by **string equality** — it does not run the
 * `normalizeAlgorandNetwork` the same package ships. So a network string that is
 * semantically correct but spelled differently (truncated CAIP-2 reference vs full
 * genesis hash) produces `missing_facilitator` and a 500 on every paid request,
 * while the service root, health check, and the middleware's own facilitator sync
 * all report success.
 *
 * Comparing verbatim here is therefore the point, not a shortcut: a normalizing
 * comparison would pass on exactly the input that breaks at request time.
 */
export async function assertFacilitatorSupport({ facilitatorUrl, caip2, scheme = "exact" }) {
  let supported;
  try {
    const res = await fetch(`${facilitatorUrl}/supported`, { headers: { accept: "application/json" } });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) {
      throw new Error(`returned ${type || "no content-type"} (${res.status}), not JSON — wrong host?`);
    }
    supported = await res.json();
  } catch (err) {
    throw new Error(`cannot reach facilitator at ${facilitatorUrl}/supported: ${String(err?.message ?? err)}`);
  }

  const kinds = supported.kinds ?? [];
  if (kinds.some((k) => k.scheme === scheme && k.network === caip2)) {
    return { ok: true, kinds: kinds.length };
  }

  // Name the near-miss explicitly. Without this the error is "unsupported
  // network" against a network the facilitator plainly does support, which sends
  // you looking at the facilitator instead of at the string.
  const algorand = kinds.filter((k) => k.network?.startsWith("algorand:")).map((k) => k.network);
  const nearMiss = algorand.find((n) => n.startsWith(caip2) || caip2.startsWith(n));

  throw new Error(
    [
      `facilitator ${facilitatorUrl} does not advertise scheme "${scheme}" on "${caip2}".`,
      nearMiss
        ? `It advertises "${nearMiss}" — the same chain spelled differently. The resource server ` +
          `compares these by exact string, so build the CAIP-2 id from ALGORAND_*_GENESIS_HASH ` +
          `rather than the truncated ALGORAND_*_CAIP2 constants.`
        : `Algorand networks it does advertise: ${algorand.join(", ") || "none"}.`,
    ].join("\n  "),
  );
}
