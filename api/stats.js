// Read rollups for a site: GET /api/stats?site=example.com&days=7
// Requires the Redis sink. Protected by ZT_STATS_KEY (Authorization: Bearer <key> or ?key=).
import { redis, redisConfig } from '../lib/sinks.js';

export const config = { runtime: 'edge' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function pairs(arr) {
  const out = [];
  for (let i = 0; i < (arr || []).length; i += 2) out.push({ key: arr[i], count: Number(arr[i + 1]) });
  return out;
}
function merge(lists, limit = 20) {
  const m = new Map();
  for (const l of lists) for (const { key, count } of l) m.set(key, (m.get(key) || 0) + count);
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

export default async function handler(req) {
  const url = new URL(req.url);
  const key = process.env.ZT_STATS_KEY;
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key');
  if (!key || given !== key) return json({ error: 'unauthorized (set ZT_STATS_KEY)' }, 401);
  if (!redisConfig()) return json({ error: 'stats need the Redis sink (KV_REST_API_URL / KV_REST_API_TOKEN)' }, 501);

  const site = (url.searchParams.get('site') || '').toLowerCase();
  if (!site) {
    const [{ result }] = await redis([['SMEMBERS', 'zt:sites']]);
    return json({ sites: result });
  }
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
  const dates = [...Array(days)].map((_, i) => new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const zsets = ['pages', 'labels', 'referrers', 'countries', 'devices', 'browsers'];

  const cmds = [];
  for (const day of dates) {
    const k = `zt:${site}:${day}`;
    cmds.push(['HGETALL', `${k}:types`], ['HGETALL', `${k}:scroll`]);
    for (const z of zsets) cmds.push(['ZREVRANGE', `${k}:${z}`, 0, 49, 'WITHSCORES']);
  }
  const keys = (s) => dates.map((d) => `zt:${site}:${d}:${s}`);
  cmds.push(['PFCOUNT', ...keys('visitors')], ['PFCOUNT', ...keys('sessions')]);

  const res = (await redis(cmds)).map((r) => r.result);
  const per = 2 + zsets.length;
  const types = {}, scroll = {}, top = Object.fromEntries(zsets.map((z) => [z, []]));
  const daily = [];
  dates.forEach((day, i) => {
    const row = res.slice(i * per, (i + 1) * per);
    const t = pairs(row[0]);
    t.forEach(({ key, count }) => (types[key] = (types[key] || 0) + count));
    pairs(row[1]).forEach(({ key, count }) => (scroll[key] = (scroll[key] || 0) + count));
    zsets.forEach((z, j) => top[z].push(pairs(row[2 + j])));
    daily.push({ day, pageviews: t.find((x) => x.key === 'pageview')?.count || 0 });
  });

  return json({
    site, days,
    visitors: res[res.length - 2],
    sessions: res[res.length - 1],
    events: types,
    scroll_depth: scroll,
    daily: daily.reverse(),
    ...Object.fromEntries(zsets.map((z) => [`top_${z}`, merge(top[z])]))
  });
}
