import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FRANKFURTER_API = "https://api.frankfurter.dev/v2";
const CURRENCIES = ["USD", "EUR", "GBP", "NGN", "CAD"];

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

    // Fetch rates from Frankfurter for each base currency
    const allRates: Array<{
      base_currency: string;
      quote_currency: string;
      rate: number;
      fee_percent: number;
    }> = [];

    for (const base of CURRENCIES) {
      const quotes = CURRENCIES.filter((c) => c !== base).join(",");
      const url = `${FRANKFURTER_API}/rates?base=${encodeURIComponent(base)}&quotes=${encodeURIComponent(quotes)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Frankfurter API returned ${res.status} for base=${base}`);
      }
      const data = await res.json();

      if (!Array.isArray(data)) {
        throw new Error(`Unexpected Frankfurter response for base=${base}`);
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
    }

    // Upsert into exchange_rates table
    const { error } = await supabase
      .from("exchange_rates")
      .upsert(allRates, { onConflict: "base_currency,quote_currency" });

    if (error) {
      throw new Error(`Database upsert failed: ${error.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        synced: allRates.length,
        currencies: CURRENCIES,
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
