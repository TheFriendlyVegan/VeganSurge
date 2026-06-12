async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  chart: (symbol, tf, day) =>
    getJSON(
      `/api/chart?symbol=${encodeURIComponent(symbol)}&tf=${tf}` +
        (day ? `&day=${day}` : "")
    ),
  financials: (symbol) => getJSON(`/api/financials?symbol=${encodeURIComponent(symbol)}`),
  rsrating: (symbol) => getJSON(`/api/rsrating?symbol=${encodeURIComponent(symbol)}`),
  quote: (symbol) => getJSON(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
  profile: (symbol) => getJSON(`/api/profile?symbol=${encodeURIComponent(symbol)}`),
  search: (q) => getJSON(`/api/search?q=${encodeURIComponent(q)}`),
};
