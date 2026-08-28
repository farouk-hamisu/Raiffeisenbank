// marvintlc — Live exchange rate module (Frankfurter API)
// Shared by bitcoin.js and dashboard.js
var ExchangeRates = (function () {
  var cache = {};
  var CACHE_TTL = 300000; // 5 minutes

  function cacheKey(from, to) { return from + '-' + to; }

  function isFresh(entry) {
    return entry && (Date.now() - entry.fetched_at) < CACHE_TTL;
  }

  function formatAge(ts) {
    var sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 30) return 'just now';
    if (sec < 60) return sec + 's ago';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    var hr = Math.floor(min / 60);
    return hr + 'h ago';
  }

  return {
    getRate: async function (from, to) {
      if (from === to) throw new Error('SAME_CURRENCY');
      var key = cacheKey(from, to);
      var cached = cache[key];
      if (isFresh(cached)) return cached;

      var url = APP_CONFIG.exchangeRateApi + '/rate/' + encodeURIComponent(from) + '/' + encodeURIComponent(to);
      var res = await fetch(url);
      if (!res.ok) {
        var err;
        try { err = await res.json(); } catch (_) { err = {}; }
        throw new Error(err.message || 'Rate fetch failed (' + res.status + ')');
      }
      var data = await res.json();
      var entry = { rate: data.rate, fetched_at: Date.now(), source: 'live' };
      cache[key] = entry;
      return entry;
    },

    getRates: async function (base, quotes) {
      var url = APP_CONFIG.exchangeRateApi + '/rates?base=' + encodeURIComponent(base) + '&quotes=' + quotes.map(encodeURIComponent).join(',');
      var res = await fetch(url);
      if (!res.ok) {
        var err;
        try { err = await res.json(); } catch (_) { err = {}; }
        throw new Error(err.message || 'Rates fetch failed (' + res.status + ')');
      }
      var data = await res.json();
      return data.rates || {};
    },

    convert: function (amount, fromCurrency, toCurrency, rates) {
      if (fromCurrency === toCurrency) return Number(amount) || 0;
      var rate = rates[fromCurrency];
      if (!rate) return null; // unsupported pair
      return (Number(amount) || 0) * rate;
    },

    formatAge: formatAge,
    clearCache: function () { cache = {}; }
  };
})();
