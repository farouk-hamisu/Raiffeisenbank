export function toMs(value) {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

export function sumOutputsToAddress(tx, address) {
  if (!tx || !Array.isArray(tx.vout)) return 0;
  let total = 0;
  for (const vout of tx.vout) {
    if (vout && vout.scriptpubkey_address === address && typeof vout.value === 'number') {
      total += vout.value;
    }
  }
  return total;
}

export function confirmationsFor(tx, tipHeight) {
  const status = tx && tx.status;
  if (!status || status.confirmed !== true || typeof status.block_height !== 'number') return 0;
  if (typeof tipHeight !== 'number' || tipHeight < status.block_height) return 1;
  return tipHeight - status.block_height + 1;
}

export function txSeenAt(tx) {
  if (!tx) return null;
  const status = tx.status || {};
  return toMs(status.block_time) ?? toMs(status.first_seen) ??
    toMs(tx.first_seen) ?? toMs(tx.last_broadcast_time) ?? null;
}

export function planActions(options) {
  const deposits = (options && options.deposits) || [];
  const txs = (options && options.txs) || [];
  const graceMs = typeof (options && options.graceMs) === 'number' ? options.graceMs : 60000;

  const pool = txs
    .filter(function (tx) { return tx && tx.txid && Number(tx.valueSats) > 0; })
    .map(function (tx) {
      return {
        txid: tx.txid,
        valueSats: Number(tx.valueSats),
        confirmations: Number(tx.confirmations) || 0,
        seenAt: typeof tx.seenAt === 'number' ? tx.seenAt : null,
        claimed: false
      };
    });

  const active = deposits
    .filter(function (d) { return d && (d.status === 'awaiting' || d.status === 'processing'); })
    .slice()
    .sort(function (a, b) {
      return (new Date(a.created_at).getTime() || 0) - (new Date(b.created_at).getTime() || 0);
    });

  const matches = [];
  const matchedHashes = new Set();

  for (const deposit of active) {
    const expected = Number(deposit.expected_sats);
    if (!expected) continue;
    const createdMs = new Date(deposit.created_at).getTime() || 0;
    const cutoff = createdMs - graceMs;

    const candidates = pool.filter(function (tx) {
      if (tx.claimed || tx.valueSats !== expected) return false;
      if (tx.seenAt === null) return true;
      return tx.seenAt >= cutoff;
    });
    if (!candidates.length) continue;

    candidates.sort(function (a, b) {
      if (a.confirmations !== b.confirmations) return b.confirmations - a.confirmations;
      return (b.seenAt || 0) - (a.seenAt || 0);
    });

    const pick = candidates[0];
    pick.claimed = true;
    matchedHashes.add(pick.txid);
    matches.push({
      depositId: deposit.id,
      reference: deposit.reference,
      expectedSats: expected,
      txHash: pick.txid,
      valueSats: pick.valueSats,
      confirmations: pick.confirmations,
      existingTxHash: deposit.tx_hash || null
    });
  }

  const unmatched = pool
    .filter(function (tx) { return !tx.claimed; })
    .map(function (tx) {
      return {
        txHash: tx.txid,
        valueSats: tx.valueSats,
        confirmations: tx.confirmations,
        seenAt: tx.seenAt
      };
    });

  return { matches: matches, unmatched: unmatched };
}
