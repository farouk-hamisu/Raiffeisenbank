// marvintlc — Shared BTC/USD price module
// Single authoritative source for BTC price used by bitcoin.js, crypto-withdrawal.js, dashboard.js
window.BtcPrice = (function () {
  let cached = null;
  let cacheTime = 0;
  const CACHE_TTL = 60000; // 60 seconds

  async function get() {
    const now = Date.now();
    if (cached && (now - cacheTime) < CACHE_TTL) return cached;

    const cfg = window.APP_CONFIG || {};
    const api = cfg.btcPriceApi || 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

    try {
      const res = await fetch(api);
      const data = await res.json();
      const price = parseFloat(data && data.bitcoin && data.bitcoin.usd);
      if (price && price > 0) {
        cached = price;
        cacheTime = now;
        return cached;
      }
    } catch (_) {}

    // Fallback: Supabase exchange_rates table
    try {
      const r = await SB.from('exchange_rates').select('rate').eq('base_currency', 'BTC').eq('quote_currency', 'USD').single();
      if (r.data && r.data.rate > 0) {
        cached = parseFloat(r.data.rate);
        cacheTime = now;
        return cached;
      }
    } catch (_) {}

    // Last resort: stale cache
    if (cached) return cached;

    // Hard fallback (should never reach here in production)
    cached = 83000;
    cacheTime = now;
    return cached;
  }

  function clear() { cached = null; cacheTime = 0; }

  return { get: get, clear: clear };
})();
