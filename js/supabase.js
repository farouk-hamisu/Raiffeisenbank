// Raiffeisen Bank — Supabase client bootstrap
// Assumes the Supabase JS client is loaded globally (see <script> tags in HTML).

function createSupabaseClient() {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    return supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey);
  }
  // fallback: window.supabase.createClient exposed by the v2 UMD build
  if (window.supabase && window.supabase.createClient) {
    return window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey);
  }
  throw new Error('Supabase client library not loaded.');
}

const SB = createSupabaseClient();