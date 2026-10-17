import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FRANKFURTER_API = "https://api.frankfurter.dev/v2";
// Display currencies supported by the platform (must match js/fx.js).
const DISPLAY_CURRENCIES = ["USD", "HUF", "EUR", "GBP", "NGN", "CAD"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Only sync pairs whose codes actually exist (and are enabled) in the
    // currencies table — exchange_rates has an FK to currencies(code).
    const { data: currencyRows, error: currencyError } = await supabase
      .from("currencies")
      .select("code, enabled");
    if (currencyError) {
      throw new Error(`Could not load currencies: ${currencyError.message}`);
    }
    const enabled = new Set(
      (currencyRows || [])
        .filter((c) => c.enabled)
        .map((c) => String(c.code).toUpperCase())
    );
    const currencies = DISPLAY_CURRENCIES.filter((c) => enabled.has(c));
    if (!currencies.includes("USD")) {
      throw new Error("USD is not an enabled currency");
    }

    // Fetch rates from Frankfurter for each base currency. A base the API
    // does not support is skipped instead of failing the whole sync.
    const allRates: Array<{
      base_currency: string;
      quote_currency: string;
      rate: number;
      fee_percent: number;
    }> = [];
    const skipped: string[] = [];

    for (const base of currencies) {
      const quotes = currencies.filter((c) => c !== base).join(",");
      if (!quotes) continue;
      const url = `${FRANKFURTER_API}/rates?base=${encodeURIComponent(base)}&quotes=${encodeURIComponent(quotes)}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          skipped.push(`${base} (HTTP ${res.status})`);
          continue;
        }
        const data = await res.json();

        if (!Array.isArray(data)) {
          skipped.push(`${base} (unexpected response)`);
          continue;
        }

        for (const row of data as Array<{ quote?: string; rate?: number }>) {
          const quote = row.quote;
          const rate = row.rate;
          if (!quote || typeof rate !== "number") continue;
          // Fee: 0.50% for USD pairs, 1.00% for cross-currency pairs
          const feePercent = base === "USD" || quote === "USD" ? 0.5 : 1.0;
          allRates.push({
            base_currency: base,
            quote_currency: quote,
            rate: rate,
            fee_percent: feePercent,
          });
        }
      } catch (baseErr) {
        skipped.push(`${base} (${(baseErr as Error).message})`);
      }
    }

    // Upsert into exchange_rates table
    if (allRates.length) {
      const { error } = await supabase
        .from("exchange_rates")
        .upsert(allRates, { onConflict: "base_currency,quote_currency" });

      if (error) {
        throw new Error(`Database upsert failed: ${error.message}`);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        synced: allRates.length,
        currencies,
        skipped,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
