// Raiffeisen Bank — Client configuration
// Replace these values with your Supabase project credentials.
// ONLY the public anon key belongs here. Never expose the service_role key.
const APP_CONFIG = {
  supabaseUrl: 'https://kmfdpkmccnmebcjkaanv.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImttZmRwa21jY25tZWJjamthYW52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMTcxMDAsImV4cCI6MjEwNjg5MzEwMH0.FnEZn52sf9y_RKJvVZ4BuHPSM5upc6IqpJb87YuAI5s',
  bankName: 'Raiffeisen Bank',
  currencySymbols: {
    USD: '$',
    BTC: '\u20BF'
  },
  pageSize: 10,
  // Offline fallback for the USD/HUF display rate (live rates come from the
  // exchange_rates table via js/fx.js).
  usdHufRate: 392.5,
  btcPriceApi: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
};
