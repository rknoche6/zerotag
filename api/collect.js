// Edge collector: validates, enriches and fans out event batches to the configured sinks.
// Runs on Vercel's Edge runtime, so it scales horizontally with no servers to manage.
import { waitUntil } from '@vercel/functions';
import { sinks } from '../lib/sinks.js';
import { parseUA, isBot } from '../lib/ua.js';
import { checkLimits } from '../lib/limits.js';

export const config = { runtime: 'edge' };

const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 100;
const TYPES = new Set([
  'pageview', 'click', 'rage_click', 'dead_click', 'scroll', 'section_view', 'form_submit',
  'form_abandon', 'field_change', 'copy', 'media', 'page_leave', 'js_error', 'custom'
]);

const allowed = (process.env.ZT_ALLOWED_SITES || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

async function sha(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);

function sanitizeProps(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (n++ >= 30) break;
    const key = k.slice(0, 40);
    if (typeof v === 'string') out[key] = v.slice(0, 300);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

export default async function handler(req) {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers });

  const text = await req.text();
  if (text.length > MAX_BODY) return new Response('Payload too large', { status: 413, headers });

  let body;
  try { body = JSON.parse(text); } catch { return new Response('Bad JSON', { status: 400, headers }); }
  if (!body || !body.c || !Array.isArray(body.e)) return new Response('Bad payload', { status: 400, headers });

  const ua = req.headers.get('user-agent') || '';
  if (isBot(ua)) return new Response(null, { status: 204, headers });

  const site = str(body.c.site, 100)?.toLowerCase();
  if (!site || !/^[a-z0-9._:-]{1,100}$/.test(site)) return new Response('Bad site', { status: 400, headers });
  if (allowed.length && !allowed.includes(site)) return new Response('Site not allowed', { status: 403, headers });

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  // Cookieless fallback: a visitor hash that rotates daily and can't be reversed to an IP.
  const vid = str(body.c.aid, 40) || (await sha(`${process.env.ZT_SALT || 'zerotag'}|${day}|${site}|${ip}|${ua}`));
  const { browser, os, device } = parseUA(ua);
  const geo = {
    country: req.headers.get('x-vercel-ip-country') || undefined,
    region: req.headers.get('x-vercel-ip-country-region') || undefined,
    city: decodeURIComponent(req.headers.get('x-vercel-ip-city') || '') || undefined
  };
  const receivedAt = Date.now();

  const events = body.e.slice(0, MAX_EVENTS)
    .filter((e) => e && TYPES.has(e.t))
    .map((e) => ({
      site,
      type: e.t,
      name: str(e.n, 200) || e.t,
      ts: Number.isFinite(e.ts) && Math.abs(e.ts - receivedAt) < 864e5 ? e.ts : receivedAt,
      received_at: receivedAt,
      url: str(e.u, 500),
      visitor_id: vid,
      session_id: str(body.c.sid, 40),
      referrer: str(body.r, 500),
      lang: str(body.c.lang, 20),
      tz: str(body.c.tz, 50),
      screen: body.c.sw ? `${body.c.sw}x${body.c.sh}` : undefined,
      viewport: body.c.vw ? `${body.c.vw}x${body.c.vh}` : undefined,
      browser, os, device, ...geo,
      sdk: str(body.c.v, 20),
      props: sanitizeProps(e.p)
    }));

  if (!events.length) return new Response(null, { status: 204, headers });

  const limited = await checkLimits({ ipHash: await sha(`${process.env.ZT_SALT || 'zerotag'}|${ip}`), site, count: events.length });
  if (limited) {
    return new Response(JSON.stringify({ error: 'rate_limited', reason: limited.reason }), {
      status: 429,
      headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': String(limited.retryAfter) }
    });
  }

  waitUntil(Promise.allSettled(sinks().map((s) => s.write(events))));
  return new Response(null, { status: 204, headers });
}
