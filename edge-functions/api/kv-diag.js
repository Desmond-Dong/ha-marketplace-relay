// TEMPORARY KV diagnostic v2 — REMOVE once /api/token/stats is confirmed healthy.
// Live findings so far: the runtime KV global works (put/get/delete fine, string or
// {type} get forms both OK), but list() WITH a prefix returns a result WITHOUT the
// keys array — only option-less list() returns keys. This probe dumps real list
// results per invocation style (key NAMES only — never values) and calls the real
// loadPool() so any remaining mismatch surfaces with its exact error.
// 临时 KV 诊断 v2——/api/token/stats 确认健康后删除。已确认：运行时 KV 的
// put/get/delete 正常（get 的字符串与 {type} 形式都可用），但带 prefix 的 list()
// 返回值缺 keys 数组——只有不带参数的 list() 返回 keys。本探针输出各调用形态的
// 真实 list 结果（仅键名，绝不含值），并直接调用真实的 loadPool()，让任何剩余
// 不匹配带着确切错误现形。
import { poolKv, loadPool, POOL_PREFIX } from '../../lib/kv-pool.js';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { ...jsonHeaders } });
}

// Key names only, never values / 只取键名，绝不含值
function namesOf(res) {
  if (!res || typeof res !== 'object') return { malformed: String(res) };
  const raw = Array.isArray(res.keys) ? res.keys : null;
  return {
    has_keys: raw !== null,
    complete: res.complete,
    cursor: res.cursor == null ? null : String(res.cursor).slice(0, 20),
    names: raw ? raw.map((k) => (k && (k.key || k.name)) || '?') : null,
  };
}

export async function onRequestGet() {
  const kvb = poolKv();
  if (!kvb) return json(200, { note: 'no KV binding resolved' });
  const probes = {};

  // invocation-style matrix / 调用形态矩阵
  try { probes.list_noargs = namesOf(await kvb.list()); }
  catch (e) { probes.list_noargs = { error: String(e && e.message || e) }; }

  try { probes.list_prefix_pool = namesOf(await kvb.list({ prefix: POOL_PREFIX, limit: 256 })); }
  catch (e) { probes.list_prefix_pool = { error: String(e && e.message || e) }; }

  try { probes.list_limit_only = namesOf(await kvb.list({ limit: 10 })); }
  catch (e) { probes.list_limit_only = { error: String(e && e.message || e) }; }

  try { probes.list_prefix_limit = namesOf(await kvb.list({ prefix: 'diag_', limit: 10 })); }
  catch (e) { probes.list_prefix_limit = { error: String(e && e.message || e) }; }

  // the real lib, probed directly / 直接调用真实的库函数
  try {
    const entries = await loadPool(kvb);
    probes.loadpool_direct = { count: entries.length, keys: entries.map((e) => e.key) };
  } catch (e) {
    probes.loadpool_direct = { error: String(e && e.message || e), stack_head: String(e && e.stack || '').split('\n').slice(0, 3) };
  }

  // scratch write/read/delete sanity (diag_* keys only) / 临时键读写删自检（仅 diag_*）
  try {
    await kvb.put('diag_sanity', '1');
    probes.scratch_roundtrip = (await kvb.get('diag_sanity', 'text')) === '1' ? 'ok' : 'mismatch';
    await kvb.delete('diag_sanity');
  } catch (e) {
    probes.scratch_roundtrip = String(e && e.message || e);
  }

  return json(200, { probes });
}
