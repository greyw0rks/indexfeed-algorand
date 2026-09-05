/**
 * Offline fixture universe.
 *
 * Replaces `universe.js`, which held a hardcoded fundamentals snapshot that the
 * live screen read from — a static snapshot silently produced a stale index. This
 * data is now used *only* when `USE_FIXTURE_PRICES=1`, for offline development
 * and tests, and never feeds a real publish.
 *
 * Deliberately includes assets that must be excluded, so an offline run exercises
 * the screen rather than waving everything through: a stablecoin (USDT), a wrapped
 * asset (WBTC), a staking derivative (STETH), a commodity token (PAXG), a mega-cap
 * failing the absolute volume floor (THINV), one passing that floor but failing
 * turnover (ILQD), and a newly listed name (NEWCO).
 *
 * Shape matches what `collectFundamentals` produces, including `providerIds`, so
 * the resolver works offline too.
 */

const ids = (symbol, gecko, paprika) => ({
  "fixture-provider": symbol,
  coingecko: gecko ?? symbol.toLowerCase(),
  coinpaprika: paprika ?? `${symbol.toLowerCase()}-${symbol.toLowerCase()}`,
});

/**
 * @type {Array<{symbol: string, name: string, marketCapUsd: number,
 *   volume24hUsd: number, listingAgeDays: number, priceUsd: number,
 *   change24hPct: number, change7dPct: number, sources: string[], providerIds: object}>}
 */
export const FIXTURE_UNIVERSE = [
  ["BTC", "Bitcoin", 1_563e9, 27_000e6, 5_889, 78_000, -1.09, -2.21],
  ["ETH", "Ethereum", 294e9, 13_300e6, 4_042, 2_441, -1.41, -2.98],
  ["USDT", "Tether", 183e9, 80_000e6, 4_205, 0.9997, -0.03, -0.01],
  ["BNB", "BNB", 91e9, 707e6, 3_324, 685, -0.9, -3.4],
  ["XRP", "XRP", 85e9, 2_086e6, 4_775, 1.3633, -2.51, -10.15],
  ["SOL", "Solana", 60e9, 3_228e6, 2_196, 102.45, -1.8, 6.23],
  ["TRX", "TRON", 31e9, 468e6, 3_274, 0.3328, -0.7, -3.35],
  ["STETH", "Lido Staked Ether", 23e9, 7e6, 1_845, 2_436, -1.51, -3.17],
  ["ZEC", "Zcash", 13e9, 874e6, 3_593, 822, -3.88, -3.2],
  ["DOGE", "Dogecoin", 12e9, 639e6, 4_642, 0.0823, -2.1, -10.67],
  ["XMR", "Monero", 9e9, 282e6, 4_485, 502, -1.2, -4.1],
  ["WBTC", "Wrapped Bitcoin", 9e9, 175e6, 2_769, 77_826, -1.06, -2.16],
  ["THINV", "Thin Volume Mega Cap", 8.9e9, 0.2e6, 2_660, 9.63, 0.59, 3.28],
  ["ILQD", "Illiquid By Turnover", 20e9, 40e6, 2_400, 15.5, -1.1, -4.2],
  ["LINK", "Chainlink", 8.4e9, 373e6, 3_267, 11.18, -1.5, -3.9],
  ["ADA", "Cardano", 7.4e9, 340e6, 3_256, 0.1943, -2.0, -6.1],
  ["XLM", "Stellar", 6.1e9, 125e6, 4_409, 0.1752, -2.59, -11.31],
  ["BCH", "Bitcoin Cash", 4.9e9, 113e6, 3_326, 244, -1.1, -3.3],
  ["PAXG", "PAX Gold", 4.5e9, 60e6, 2_000, 4_429, -0.79, -5.06],
  ["LTC", "Litecoin", 3.7e9, 226e6, 5_436, 48.2, -1.4, -5.2],
  ["HBAR", "Hedera", 3.2e9, 41e6, 2_540, 0.0735, -1.9, -6.4],
  ["UNI", "Uniswap", 3.2e9, 549e6, 2_174, 5.09, -2.2, -7.1],
  ["AVAX", "Avalanche", 3.1e9, 172e6, 2_215, 7.16, -1.7, -5.5],
  ["SUI", "Sui", 2.9e9, 463e6, 1_285, 0.7169, -2.4, -8.2],
  ["NEAR", "NEAR Protocol", 2.4e9, 219e6, 2_085, 1.84, -1.6, -4.8],
  ["AAVE", "Aave", 1.9e9, 230e6, 2_148, 122.88, -2.8, -6.9],
  ["NEWCO", "Newly Listed Co", 1.2e9, 90e6, 12, 3.5, 12.4, 48.2],
].map(([symbol, name, marketCapUsd, volume24hUsd, listingAgeDays, priceUsd, change24hPct, change7dPct]) => ({
  symbol,
  name,
  marketCapUsd,
  volume24hUsd,
  listingAgeDays,
  priceUsd,
  change24hPct,
  change7dPct,
  sources: ["fixture-provider"],
  providerIds: ids(symbol),
}));
