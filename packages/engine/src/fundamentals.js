/**
 * Fundamentals providers — market cap, volume, and listing age.
 *
 * These are the inputs the eligibility screen reads, and they decide what the
 * index *contains*. Prices decide what it is worth. Both need to be live for the
 * methodology to mean anything, but they fail differently: a bad price moves the
 * level, a bad fundamental changes the constituent set.
 *
 * Two providers, reconciled. Observed agreement on 2026-08-31: market caps within
 * 0.2%, but 24h volumes differing by 8–25% for the same asset on the same day.
 * Volume is therefore treated as a soft screen — a threshold near the boundary is
 * not meaningfully decidable from free data — while market cap is trusted to rank.
 */

const REQUEST_TIMEOUT_MS = 20_000;

async function fetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

/** Days between an ISO timestamp and now, or null if unparseable. */
function daysSince(isoDate) {
  if (!isoDate) return null;
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/**
 * CoinGecko `/coins/markets`. Ranked by market cap, one request per page.
 *
 * `price_change_percentage=24h,7d` is requested explicitly. Without it the
 * response carries only the 24h window, and the stablecoin test needs both — an
 * asset with a null 7d change is excluded as unclassifiable, so omitting the
 * parameter silently drops every CoinGecko-only asset from the universe.
 *
 * Carries no listing date, so `listingAgeDays` is null here and comes from
 * CoinPaprika's `first_data_at` instead.
 */
export function coingeckoFundamentals({ pages = 1, perPage = 100 } = {}) {
  return {
    name: "coingecko",
    async fetch() {
      const rows = [];
      for (let page = 1; page <= pages; page += 1) {
        const batch = await fetchJson(
          "https://api.coingecko.com/api/v3/coins/markets" +
            `?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}` +
            "&price_change_percentage=24h,7d",
        );
        if (!Array.isArray(batch)) throw new Error("coingecko returned a non-array (rate limited?)");
        rows.push(...batch);
      }
      return rows
        .filter((c) => c.market_cap > 0)
        .map((c) => ({
          symbol: c.symbol.toUpperCase(),
          providerId: c.id,
          name: c.name,
          marketCapUsd: c.market_cap,
          volume24hUsd: c.total_volume ?? 0,
          listingAgeDays: null,
          priceUsd: c.current_price,
          change24hPct: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? null,
          change7dPct: c.price_change_percentage_7d_in_currency ?? null,
        }));
    },
  };
}

/**
 * CoinPaprika `/v1/tickers`. One request returns ~2000 assets with listing dates.
 *
 * `percent_change_30d` is present but returns 0 for every asset, so it is not
 * read — only the 24h and 7d windows are usable.
 */
export function coinpaprikaFundamentals({ limit = 200 } = {}) {
  return {
    name: "coinpaprika",
    async fetch() {
      const all = await fetchJson("https://api.coinpaprika.com/v1/tickers");
      if (!Array.isArray(all)) throw new Error("coinpaprika returned a non-array");
      return all
        .filter((t) => t.quotes?.USD?.market_cap > 0)
        .sort((a, b) => b.quotes.USD.market_cap - a.quotes.USD.market_cap)
        .slice(0, limit)
        .map((t) => ({
          symbol: t.symbol.toUpperCase(),
          providerId: t.id,
          name: t.name,
          marketCapUsd: t.quotes.USD.market_cap,
          volume24hUsd: t.quotes.USD.volume_24h ?? 0,
          listingAgeDays: daysSince(t.first_data_at),
          priceUsd: t.quotes.USD.price,
          change24hPct: t.quotes.USD.percent_change_24h ?? null,
          change7dPct: t.quotes.USD.percent_change_7d ?? null,
        }));
    },
  };
}

/** Deterministic provider for tests and offline runs. */
export function fixtureFundamentals(name, rows) {
  return { name, async fetch() { return rows; } };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Merge providers into one universe, keyed by ticker.
 *
 * Numeric fields are medianed across whichever providers reported them.
 * `listingAgeDays` takes the **oldest** claim rather than the median: age is a
 * lower bound on when an asset existed, and a provider that started tracking it
 * late is wrong in a knowable direction. Using the oldest avoids excluding an
 * established asset because one provider only has recent history.
 *
 * An asset reported by only one provider is kept but flagged, so the screen can
 * see how well corroborated each row is.
 *
 * @returns {Promise<{universe: Array, providerErrors: Array}>}
 */
export async function collectFundamentals(providers) {
  const settled = await Promise.allSettled(providers.map((p) => p.fetch()));
  const providerErrors = [];
  const bySymbol = new Map();

  settled.forEach((result, i) => {
    const provider = providers[i].name;
    if (result.status === "rejected") {
      providerErrors.push({ provider, error: String(result.reason?.message ?? result.reason) });
      return;
    }
    for (const row of result.value) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol).push({ ...row, provider });
    }
  });

  const universe = [...bySymbol.entries()].map(([symbol, rows]) => {
    const ages = rows.map((r) => r.listingAgeDays).filter((a) => a !== null);
    return {
      symbol,
      name: rows[0].name,
      marketCapUsd: median(rows.map((r) => r.marketCapUsd)),
      volume24hUsd: median(rows.map((r) => r.volume24hUsd)),
      listingAgeDays: ages.length ? Math.max(...ages) : null,
      priceUsd: median(rows.map((r) => r.priceUsd).filter(Number.isFinite)),
      change24hPct: pickChange(rows, "change24hPct"),
      change7dPct: pickChange(rows, "change7dPct"),
      sources: rows.map((r) => r.provider),
      providerIds: Object.fromEntries(rows.map((r) => [r.provider, r.providerId])),
    };
  });

  universe.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  return { universe, providerErrors };
}

/** Median of a change field across providers that reported it, else null. */
function pickChange(rows, field) {
  const values = rows.map((r) => r[field]).filter((v) => v !== null && Number.isFinite(v));
  return values.length ? median(values) : null;
}
