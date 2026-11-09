// Public pool stats — masked, powers the contributors page / 公开的池统计——脱敏，供贡献者页
//
// GET /api/token/stats -> {
//   count, contributors: [{ login, use_count, remaining, status }],
//   storage: { records, bytes, quota_bytes }
// }
// Only masked fields: login (public by design), use count, last-known remaining quota.
// No token material, no IPs. `remaining` is null unless the record was revalidated
// within QUOTA_TTL_MS — never shown stale. / 只含脱敏字段：login（本就是公开信息）、
// 使用次数、最近一次验活的剩余额度。无 token 明文、无 IP。remaining 仅在保鲜期内
// 有值（否则为 null），绝不展示过期数字。
//
// Storage usage is measured from the records themselves: record count + approximate
// byte size of every stored value (key + JSON body). EdgeOne does NOT expose
// platform-level quota counters to the runtime, so the quota denominator comes from
// the KV_QUOTA_MB environment variable — set it in the console to the namespace's
// real cap to get a percentage; without it only absolute usage is reported.
// 存储用量直接由记录本身测得：记录条数 + 全部记录的估算字节数（键名 + JSON 值体）。
// EdgeOne 不向运行时暴露平台级配额计数器，配额分母来自环境变量 KV_QUOTA_MB——
// 在控制台把它设成命名空间的实际容量即可得到百分比；未设置时只返回绝对用量。
// Response cached 60s: this endpoint is public and unauthenticated, caching spares
// the KV read quota. / 响应缓存 60 秒：公开端点，用缓存省 KV 读配额。

import { poolKv, loadPool, QUOTA_TTL_MS } from '../../lib/kv-pool.js';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=60',
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { ...jsonHeaders } });
}

export async function onRequestGet(context) {
  const kvb = poolKv();
  if (!kvb) {
    return json(200, { count: 0, contributors: [], storage: { records: 0, bytes: 0, quota_bytes: null } });
  }
  try {
    const entries = await loadPool(kvb);
    const now = Date.now();
    const contributors = entries
      .map((e) => {
        const fresh = e.rec.checked_at && now - e.rec.checked_at < QUOTA_TTL_MS;
        return {
          login: e.rec.login || 'anonymous',
          use_count: e.rec.use_count || 0,
          remaining: !e.rec.disabled && fresh ? (e.rec.remaining || 0) : null,
          status: e.rec.disabled ? 'disabled' : 'active',
        };
      })
      .sort((a, b) => b.use_count - a.use_count);

    // Approximate stored bytes: JSON value body + key name per record (token strings
    // and logins are ASCII, so string length ≈ byte length). / 估算存储字节：每条记录
    // 的 JSON 值体 + 键名（token 与 login 均为 ASCII，字符串长度≈字节数）。
    let bytes = 0;
    for (const e of entries) bytes += JSON.stringify(e.rec).length + e.key.length;

    // Optional quota denominator via env (see header comment). / 可选配额分母（见头部注释）。
    const quotaMb = Number(context && context.env && context.env.KV_QUOTA_MB);
    const quotaBytes = Number.isFinite(quotaMb) && quotaMb > 0 ? Math.round(quotaMb * 1024 * 1024) : null;

    return json(200, {
      count: contributors.length,
      contributors,
      storage: { records: entries.length, bytes, quota_bytes: quotaBytes },
    });
  } catch (e) {
    return json(502, { error: 'kv error' });
  }
}
