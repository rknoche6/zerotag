// Fixed-window rate limits backed by Redis. One pipeline round trip per batch.
// Every limit is overridable by env var. Without Redis the limits are skipped (fail open).
import { redis, redisConfig } from './sinks.js';

const num = (k, d) => {
  const v = parseInt(process.env[k] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const LIMITS = {
  ipRequestsPerMin: num('ZT_LIMIT_IP_PER_MIN', 120), // batches, not events
  siteEventsPerMin: num('ZT_LIMIT_SITE_PER_MIN', 30000),
  siteEventsPerDay: num('ZT_LIMIT_SITE_PER_DAY', 2000000),
  globalEventsPerDay: num('ZT_LIMIT_GLOBAL_PER_DAY', 20000000),
  newSitesPerDay: num('ZT_LIMIT_NEW_SITES_PER_DAY', 500)
};

// Returns null when allowed, or { reason, retryAfter } when a limit is hit.
export async function checkLimits({ ipHash, site, count }) {
  if (!redisConfig()) return null;
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60000);
  const day = now.toISOString().slice(0, 10);
  const kIp = `zt:rl:ip:${ipHash}:${minute}`;
  const kSiteMin = `zt:rl:site:${site}:${minute}`;
  const kSiteDay = `zt:rl:site:${site}:${day}`;
  const kGlobal = `zt:rl:global:${day}`;
  const kSites = `zt:rl:sites:${day}`;
  let res;
  try {
    res = await redis([
      ['INCR', kIp], ['EXPIRE', kIp, 120],
      ['INCRBY', kSiteMin, count], ['EXPIRE', kSiteMin, 120],
      ['INCRBY', kSiteDay, count], ['EXPIRE', kSiteDay, 172800],
      ['INCRBY', kGlobal, count], ['EXPIRE', kGlobal, 172800],
      ['SADD', kSites, site], ['SCARD', kSites], ['EXPIRE', kSites, 172800]
    ]);
  } catch {
    return null;
  }
  const [ip, , siteMin, , siteDay, , global, , added, sites] = res.map((r) => Number(r.result));
  const toNextMinute = 60 - now.getUTCSeconds();
  const toNextDay = Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now) / 1000);
  if (ip > LIMITS.ipRequestsPerMin) return { reason: 'ip_rate', retryAfter: toNextMinute };
  if (added === 1 && sites > LIMITS.newSitesPerDay) {
    // Take it back out so the next request from this site is also counted as new.
    redis([['SREM', kSites, site]]).catch(() => {});
    return { reason: 'new_sites', retryAfter: toNextDay };
  }
  if (siteMin > LIMITS.siteEventsPerMin) return { reason: 'site_rate', retryAfter: toNextMinute };
  if (siteDay > LIMITS.siteEventsPerDay) return { reason: 'site_daily_quota', retryAfter: toNextDay };
  if (global > LIMITS.globalEventsPerDay) return { reason: 'global_daily_quota', retryAfter: toNextDay };
  return null;
}
