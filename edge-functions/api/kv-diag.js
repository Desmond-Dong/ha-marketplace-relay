// TEMPORARY KV diagnostic endpoint — REMOVE once the binding shape is confirmed.
// Probes the runtime `marketplace` global: its type, method names, and how each KV
// method behaves (list/get/put/delete) using scratch keys only (`diag_*`).
// 临时 KV 诊断端点——确认绑定形状后删除。探测运行时 marketplace 全局：类型、方法名、
// 各 KV 方法（list/get/put/delete）的真实行为，仅使用 diag_* 临时键，不触碰池数据。

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { ...jsonHeaders } });
}

// Shallow, value-free shape description / 只描述形状，不输出值
function describe(v, depth = 0) {
  if (v == null) return String(v);
  const t = typeof v;
  if (t !== 'object') return t;
  if (depth > 2) return 'object';
  const out = { type: 'object', own_keys: Object.getOwnPropertyNames(v).slice(0, 30) };
  if (Array.isArray(v)) { out.type = 'array'; out.length = v.length; out.first = v.length ? describe(v[0], depth + 1) : null; }
  const proto = Object.getPrototypeOf(v);
  if (proto && proto !== Object.prototype) out.proto_keys = Object.getOwnPropertyNames(proto).slice(0, 30);
  return out;
}

export async function onRequestGet() {
  const probes = {};
  const info = {};

  // 1. Is the binding there at all? / 绑定是否存在
  info.has_marketplace = typeof marketplace !== 'undefined';
  if (info.has_marketplace) {
    info.describe = describe(marketplace);
  } else {
    return json(200, { info, probes, note: 'marketplace global missing' });
  }
  const kvb = marketplace;

  // 2. list probes: option-name / cursor / result-shape variants
  try { probes.list_underscore_prefix = describe(await kvb.list({ prefix: 'diag_', limit: 10 })); }
  catch (e) { probes.list_underscore_prefix = { error: String(e && e.message || e) }; }

  try { probes.list_no_options = describe(await kvb.list()); }
  catch (e) { probes.list_no_options = { error: String(e && e.message || e) }; }

  try { probes.list_no_cursor = describe(await kvb.list({ prefix: 'diag_' })); }
  catch (e) { probes.list_no_cursor = { error: String(e && e.message || e) }; }

  try { probes.list_colon_prefix = describe(await kvb.list({ prefix: 'diag:', limit: 10 })); }
  catch (e) { probes.list_colon_prefix = { error: String(e && e.message || e) }; }

  // 3. put probes: key charset variants (underscore / colon / hyphen)
  try { await kvb.put('diag_k1', 'v1'); probes.put_underscore = 'ok'; }
  catch (e) { probes.put_underscore = String(e && e.message || e); }

  try { await kvb.put('diag:k1', 'v1'); probes.put_colon = 'ok'; }
  catch (e) { probes.put_colon = String(e && e.message || e); }

  try { await kvb.put('diag-k1', 'v1'); probes.put_hyphen = 'ok'; }
  catch (e) { probes.put_hyphen = String(e && e.message || e); }

  // 4. get probes: text / json / no-type
  try { probes.get_text = describe(await kvb.get('diag_k1', 'text')); }
  catch (e) { probes.get_text = { error: String(e && e.message || e) }; }

  try { probes.get_notype = describe(await kvb.get('diag_k1')); }
  catch (e) { probes.get_notype = { error: String(e && e.message || e) }; }

  try { await kvb.put('diag_json', JSON.stringify({ a: 1 })); probes.get_json = describe(await kvb.get('diag_json', 'json')); }
  catch (e) { probes.get_json = { error: String(e && e.message || e) }; }

  try { probes.get_missing = describe(await kvb.get('diag_missing_key', 'text')); }
  catch (e) { probes.get_missing = { error: String(e && e.message || e) }; }

  // 5. list after writes: does prefix filtering work, what do key entries look like
  try { probes.list_after_put = describe(await kvb.list({ prefix: 'diag_', limit: 10 })); }
  catch (e) { probes.list_after_put = { error: String(e && e.message || e) }; }

  // 6. delete probes + cleanup
  try { await kvb.delete('diag_k1'); await kvb.delete('diag:k1'); await kvb.delete('diag-k1'); await kvb.delete('diag_json'); probes.delete = 'ok'; }
  catch (e) { probes.delete = String(e && e.message || e); }

  try { probes.list_after_delete = describe(await kvb.list({ prefix: 'diag_', limit: 10 })); }
  catch (e) { probes.list_after_delete = { error: String(e && e.message || e) }; }

  return json(200, { info, probes });
}
