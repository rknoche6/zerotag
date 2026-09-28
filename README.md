# zerotag

One script tag. Every click, scroll, form and page change gets captured and named for you. You never write `track('button_clicked')` again.

```html
<script defer src="https://YOUR-COLLECTOR/zt.js" data-site="example.com"></script>
```

That's the whole install. About 6 KB gzipped, no dependencies.

See it label your own clicks live at **[zerotag-site.vercel.app](https://zerotag-site.vercel.app/#demo)**. A hosted collector runs at `https://zerotag.vercel.app` for trying it out; for production, deploy your own (below).

## What a click looks like

Given this markup:

```html
<section id="pricing">
  <h2>Pricing</h2>
  <button class="btn css-1a2b3c"><span>Start free trial</span></button>
</section>
```

a click on the `<span>` is recorded as:

```json
{
  "t": "click",
  "n": "Clicked \"Start free trial\" in Pricing",
  "p": {
    "label": "Start free trial",
    "kind": "button",
    "section": "Pricing",
    "selector": "section#pricing>button.btn",
    "tag": "button"
  }
}
```

zerotag walks up from the clicked node to the nearest thing a person would call a control, then names it. The label comes from, in order: `data-zt`, `aria-label`, `aria-labelledby`, the form field's `<label>`, visible text, image `alt`, `title`, `name`, `id`. The section comes from the closest landmark (`section`, `nav`, `form`, `dialog`...) and its `aria-label` or first heading. Hashed class names from CSS-in-JS get dropped from selectors so they survive redeploys.

## Captured automatically

| Event | When |
| --- | --- |
| `pageview` | Load, and every `pushState` / `replaceState` / `popstate` (works with Next.js, React Router, Vue, SvelteKit) |
| `click` | Any click. `kind` tells you `button`, `link`, `outbound_link`, `download`, `email_link`, `submit`, `checkbox`... |
| `rage_click` | 3 clicks in 800 ms within 40 px |
| `dead_click` | A button-like element was clicked and the DOM didn't change within 1 s |
| `scroll` | Depth crosses 25 / 50 / 75 / 90 / 100 % |
| `section_view` | A section was at least 40 % on screen for 1 s |
| `field_change` | A form field changed. The field's label is recorded, never its value |
| `form_submit` / `form_abandon` | Submitted, or touched and left without submitting |
| `copy` | Someone copied text (the section, not the text) |
| `media` | `<video>` / `<audio>` play, pause, ended |
| `page_leave` | Leaving a page, with engaged time and max scroll |
| `js_error` | Uncaught errors |

## Privacy defaults

- Input values are never read. Password fields are skipped entirely.
- Emails and digit runs of 8+ in any label become `[email]` / `[number]`.
- Query strings are stripped except `utm_*` (add more with `data-keep-query="ref,plan"`).
- Do Not Track and Global Privacy Control are honored. Turn that off with `data-respect-dnt="false"` if you have consent some other way.
- `data-storage="none"` runs cookieless: no localStorage, and the server derives a visitor hash from IP + UA + a salt that rotates daily.
- Add `data-zt-ignore` to skip an element and everything inside it, or `data-zt-mask` to record clicks but hide the text.

## Script options

| Attribute | Default | |
| --- | --- | --- |
| `data-site` | `location.hostname` | Site key events are grouped under |
| `data-endpoint` | `<script origin>/api/collect` | Where batches are sent |
| `data-storage` | `local` | `none` for cookieless |
| `data-sample` | `1` | `0.1` keeps 10 % of visitors (sticky per visitor) |
| `data-keep-query` | | Extra query params to keep |
| `data-respect-dnt` | `true` | |
| `data-debug` | `false` | Log every event to the console |

## JavaScript API (optional)

```js
zerotag.set({ plan: 'pro' })            // attach props to every later event
zerotag.track('Upgraded', { seats: 5 }) // you can still send your own
zerotag.on((event) => console.log(event))
zerotag.optOut()
```

Events are also dispatched on `document` as `zerotag:event`.

## Self-hosting the collector

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Frknoche6%2Fzerotag&env=ZT_SALT&envDescription=Random%20string%20used%20to%20hash%20cookieless%20visitors)

The collector is one Edge Function (`api/collect.js`). It checks the payload, drops bots, adds country / city / browser / OS / device, and hands the batch to every sink you configured. The response goes back as soon as the batch is parsed; sink writes finish in the background via `waitUntil`. The browser batches events (every 5 s or 25 events) and sends them with `sendBeacon` as `text/plain`, so there's no CORS preflight and nothing is lost when the tab closes.

Edge Functions scale out per request, so the collector has no capacity to plan. Your storage is the part that needs to keep up, which is why it's pluggable.

### Sinks

Set any combination of these environment variables:

| Sink | Env vars | Good for |
| --- | --- | --- |
| Redis (Upstash / Vercel Marketplace) | `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | Raw event stream capped at 200k per site, plus daily rollups that `/api/stats` reads |
| Tinybird | `ZT_TINYBIRD_TOKEN`, optional `ZT_TINYBIRD_HOST`, `ZT_TINYBIRD_DATASOURCE` | Billions of rows, SQL over raw events |
| Webhook | `ZT_WEBHOOK_URL`, optional `ZT_WEBHOOK_SECRET` | Your own queue, warehouse loader, Zapier... |
| Logs | `ZT_LOG=1` (on by default when nothing else is set) | Vercel log drains to Datadog, Axiom, etc. |

Other env vars:

- `ZT_SALT`: secret salt for cookieless visitor hashes.
- `ZT_ALLOWED_SITES`: comma list of `data-site` values to accept. Empty accepts all.
- `ZT_STATS_KEY`: protects `/api/stats`.

### Stats

With the Redis sink on:

```
curl -H "Authorization: Bearer $ZT_STATS_KEY" "https://YOUR-COLLECTOR/api/stats?site=example.com&days=7"
```

returns visitors, sessions, event counts by type, scroll-depth funnel, daily pageviews, and top pages, labels, referrers, countries, devices and browsers.

### Run it on your own subdomain

Ad blockers block known third-party analytics hosts. Serving the collector from your own subdomain avoids that and keeps requests first-party:

1. In the Vercel project, add a domain such as `t.example.com`.
2. At your DNS provider, add `CNAME t -> cname.vercel-dns.com`.
3. Use `<script defer src="https://t.example.com/zt.js" data-site="example.com"></script>`.

## Development

```
npm install
npm test        # jsdom tests for labeling, privacy, forms, SPA routing
npm run build   # writes dist/ and public/zt.js
npx vercel dev  # demo page at http://localhost:3000
```

The script is also on jsDelivr: `https://cdn.jsdelivr.net/gh/rknoche6/zerotag@main/dist/zerotag.min.js` (pair it with `data-endpoint`).

MIT licensed.
