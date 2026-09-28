// Sinks are chosen from environment variables. Configure any number of them at once.
//
//   Redis (Upstash / Vercel KV):  KV_REST_API_URL + KV_REST_API_TOKEN
//                                 (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//   Tinybird:                     ZT_TINYBIRD_TOKEN (+ ZT_TINYBIRD_HOST, ZT_TINYBIRD_DATASOURCE)
//   Any HTTP endpoint:            ZT_WEBHOOK_URL (+ ZT_WEBHOOK_SECRET sent as Bearer token)
//   Function logs / log drains:   ZT_LOG=1 (default when nothing else is configured)

const env = (k) => process.env[k];

export function redisConfig() {
  const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
  return url && token ? { url, token } : null;
}

export async function redis(commands) {
  const cfg = redisConfig();
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return res.json();
}

const TTL = 60 * 60 * 24 * 400; // keep daily rollups ~13 months

// Raw events go to a capped stream; rollups are pre-aggregated so dashboards
// read a handful of keys instead of scanning events.
const redisSink = {
  name: 'redis',
  async write(events) {
    const cmds = [];
    const touched = new Set();
    for (const e of events) {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      const k = `zt:${e.site}:${day}`;
      touched.add(k);
      cmds.push(['XADD', `zt:${e.site}:events`, 'MAXLEN', '~', '200000', '*', 'e', JSON.stringify(e)]);
      cmds.push(['HINCRBY', `${k}:types`, e.type, 1]);
      cmds.push(['PFADD', `${k}:visitors`, e.visitor_id]);
      if (e.session_id) cmds.push(['PFADD', `${k}:sessions`, e.session_id]);
      if (e.type === 'pageview') {
        cmds.push(['ZINCRBY', `${k}:pages`, 1, e.props.path || e.url || '/']);
        if (e.props.referrer) cmds.push(['ZINCRBY', `${k}:referrers`, 1, safeHost(e.props.referrer)]);
        if (e.country) cmds.push(['ZINCRBY', `${k}:countries`, 1, e.country]);
        cmds.push(['ZINCRBY', `${k}:devices`, 1, e.device]);
        cmds.push(['ZINCRBY', `${k}:browsers`, 1, e.browser]);
      }
      if (e.type !== 'pageview' && e.type !== 'page_leave') {
        cmds.push(['ZINCRBY', `${k}:labels`, 1, e.name.slice(0, 160)]);
      }
      if (e.type === 'scroll') cmds.push(['HINCRBY', `${k}:scroll`, String(e.props.depth), 1]);
    }
    for (const k of touched) {
      for (const suffix of ['types', 'visitors', 'sessions', 'pages', 'referrers', 'countries', 'devices', 'browsers', 'labels', 'scroll']) {
        cmds.push(['EXPIRE', `${k}:${suffix}`, TTL]);
      }
    }
    cmds.push(['SADD', 'zt:sites', events[0].site]);
    await redis(cmds);
  }
};

function safeHost(u) {
  try { return new URL(u).host; } catch { return u.slice(0, 80); }
}

const tinybirdSink = {
  name: 'tinybird',
  async write(events) {
    const host = env('ZT_TINYBIRD_HOST') || 'https://api.tinybird.co';
    const ds = env('ZT_TINYBIRD_DATASOURCE') || 'zerotag_events';
    const ndjson = events.map((e) => JSON.stringify({ ...e, props: JSON.stringify(e.props) })).join('\n');
    const res = await fetch(`${host}/v0/events?name=${encodeURIComponent(ds)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('ZT_TINYBIRD_TOKEN')}` },
      body: ndjson
    });
    if (!res.ok) throw new Error(`tinybird ${res.status}`);
  }
};

const webhookSink = {
  name: 'webhook',
  async write(events) {
    const headers = { 'Content-Type': 'application/json' };
    if (env('ZT_WEBHOOK_SECRET')) headers.Authorization = `Bearer ${env('ZT_WEBHOOK_SECRET')}`;
    const res = await fetch(env('ZT_WEBHOOK_URL'), { method: 'POST', headers, body: JSON.stringify({ events }) });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
  }
};

const logSink = {
  name: 'log',
  async write(events) {
    for (const e of events) console.log(JSON.stringify({ zerotag: e }));
  }
};

export function sinks() {
  const list = [];
  if (redisConfig()) list.push(redisSink);
  if (env('ZT_TINYBIRD_TOKEN')) list.push(tinybirdSink);
  if (env('ZT_WEBHOOK_URL')) list.push(webhookSink);
  if (env('ZT_LOG') === '1' || !list.length) list.push(logSink);
  return list.map((s) => ({
    name: s.name,
    write: (events) => s.write(events).catch((err) => console.error(`[zerotag] sink ${s.name} failed:`, err.message))
  }));
}
