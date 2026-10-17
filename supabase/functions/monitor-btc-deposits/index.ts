import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { confirmationsFor, planActions, sumOutputsToAddress, txSeenAt } from "./logic.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface EsploraVout {
  value?: number;
  scriptpubkey_address?: string;
}

interface EsploraTx {
  txid?: string;
  vout?: EsploraVout[];
  status?: {
    confirmed?: boolean;
    block_height?: number;
    block_time?: number;
    first_seen?: number;
  };
  first_seen?: number;
  last_broadcast_time?: number;
}

interface DepositRow {
  id: string;
  reference: string;
  created_at: string;
  status: string;
  expected_sats: number | null;
  tx_hash?: string | null;
}

interface PlannedTx {
  txid: string;
  valueSats: number;
  confirmations: number;
  seenAt?: number | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonResponse({ success: false, error: "UNAUTHORIZED" }, 401);
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData?.user) {
      return jsonResponse({ success: false, error: "UNAUTHORIZED" }, 401);
    }
    const userId = authData.user.id;

    const { data: config, error: configError } = await admin.rpc("btc_deposit_config");
    if (configError || !config || !config.address) {
      return jsonResponse({ success: false, error: "NOT_CONFIGURED" }, 503);
    }
    const address = String(config.address);

    const { data: settingsRows } = await admin
      .from("system_settings")
      .select("value")
      .eq("key", "btc_esplora_api")
      .limit(1);
    const configuredApi = settingsRows && settingsRows[0]
      ? String(settingsRows[0].value ?? "").replace(/^"|"$/g, "")
      : "";
    const esplora = configuredApi || "https://mempool.space/api";

    await admin.rpc("expire_btc_deposits");

    const { data: depositRows, error: depositError } = await admin
      .from("deposits")
      .select("id, reference, created_at, status, expected_sats, tx_hash")
      .eq("user_id", userId)
      .eq("method", "crypto")
      .in("status", ["awaiting", "processing"])
      .order("created_at", { ascending: true });
    if (depositError) throw new Error(depositError.message);
    const deposits = (depositRows ?? []) as DepositRow[];

    let mempoolTxs: EsploraTx[] = [];
    let confirmedTxs: EsploraTx[] = [];
    let tipHeight = 0;
    try {
      const [mempoolRes, confirmedRes, tipRes] = await Promise.all([
        fetch(`${esplora}/address/${address}/txs/mempool`),
        fetch(`${esplora}/address/${address}/txs`),
        fetch(`${esplora}/blocks/tip/height`),
      ]);
      if (!mempoolRes.ok || !confirmedRes.ok || !tipRes.ok) {
        throw new Error(
          `explorer HTTP ${mempoolRes.status}/${confirmedRes.status}/${tipRes.status}`,
        );
      }
      mempoolTxs = await mempoolRes.json() as EsploraTx[];
      confirmedTxs = await confirmedRes.json() as EsploraTx[];
      tipHeight = Number(await tipRes.json());
      if (!Array.isArray(mempoolTxs)) mempoolTxs = [];
      if (!Array.isArray(confirmedTxs)) confirmedTxs = [];
      if (!Number.isFinite(tipHeight)) tipHeight = 0;
    } catch (chainErr) {
      return jsonResponse({
        success: false,
        error: "EXPLORA_UNAVAILABLE",
        message: (chainErr as Error).message,
      }, 502);
    }

    const seen = new Map<string, EsploraTx>();
    for (const tx of [...mempoolTxs, ...confirmedTxs]) {
      if (tx && typeof tx.txid === "string" && tx.txid) seen.set(tx.txid, tx);
    }
    const txs: PlannedTx[] = [...seen.values()].map((tx) => ({
      txid: tx.txid as string,
      valueSats: sumOutputsToAddress(tx, address),
      confirmations: confirmationsFor(tx, tipHeight),
      seenAt: txSeenAt(tx),
    }));

    const plan = planActions({ deposits, txs, graceMs: 60000 });

    const applied: Array<Record<string, unknown>> = [];
    for (const match of plan.matches) {
      const record = await admin.rpc("record_btc_tx", {
        p_tx_hash: match.txHash,
        p_address: address,
        p_value_sats: match.valueSats,
        p_confirmations: match.confirmations,
        p_in_block: match.confirmations > 0,
        p_matched_deposit_id: match.depositId,
      });
      if (record.error) {
        applied.push({ reference: match.reference, error: record.error.message });
        continue;
      }
      const credit = await admin.rpc("credit_btc_deposit", {
        p_deposit_id: match.depositId,
        p_tx_hash: match.txHash,
        p_confirmations: match.confirmations,
        p_value_sats: match.valueSats,
      });
      if (credit.error) {
        applied.push({ reference: match.reference, error: credit.error.message });
      } else {
        applied.push({ reference: match.reference, ...(credit.data as Record<string, unknown>) });
      }
    }

    for (const unmatched of plan.unmatched) {
      await admin.rpc("record_btc_tx", {
        p_tx_hash: unmatched.txHash,
        p_address: address,
        p_value_sats: unmatched.valueSats,
        p_confirmations: unmatched.confirmations,
        p_in_block: unmatched.confirmations > 0,
        p_matched_deposit_id: null,
      });
    }

    const { data: freshDeposits } = await admin
      .from("deposits")
      .select(
        "reference, status, confirmations, required_confirmations, tx_hash, credited_at, completed_at, expires_at, expected_sats, expected_amount, amount, currency, created_at, monitor_note, method",
      )
      .eq("user_id", userId)
      .eq("method", "crypto")
      .order("created_at", { ascending: false })
      .limit(20);

    return jsonResponse({
      success: true,
      checked: deposits.length,
      observedTxs: txs.length,
      applied,
      deposits: freshDeposits ?? [],
    });
  } catch (err) {
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
