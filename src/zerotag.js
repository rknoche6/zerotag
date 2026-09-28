/*!
 * zerotag - one script tag, zero custom events.
 * Autocaptures and auto-labels clicks, scrolls, forms, navigation and more.
 * MIT License. https://github.com/rknoche6/zerotag
 */
(function (w, d) {
  'use strict';
  if (!w || !d || (w.zerotag && w.zerotag._v)) return;

  var VERSION = '__VERSION__';
  var script = d.currentScript || d.querySelector('script[src*="zt"][data-site],script[data-zerotag]');
  function attr(n, def) {
    var v = script && script.getAttribute('data-' + n);
    return v == null || v === '' ? def : v;
  }
  function origin(src) {
    try { return new URL(src, location.href).origin; } catch (e) { return ''; }
  }

  var cfg = {
    site: attr('site', location.hostname),
    endpoint: attr('endpoint', (script && script.src ? origin(script.src) : '') + '/api/collect'),
    storage: attr('storage', 'local'), // 'local' | 'none' (cookieless, memory only)
    dnt: attr('respect-dnt', 'true') !== 'false',
    sample: parseFloat(attr('sample', '1')),
    query: attr('keep-query', ''), // comma list of query params to keep (utm_* always kept)
    debug: attr('debug', 'false') === 'true',
    flushMs: parseInt(attr('flush-ms', '5000'), 10),
    batch: parseInt(attr('batch', '25'), 10)
  };

  // ---------- opt-out / sampling ----------
  var nav = w.navigator || {};
  var optedOut = false;
  try { optedOut = w.localStorage.getItem('zt_optout') === '1'; } catch (e) {}
  if (cfg.dnt && (nav.doNotTrack === '1' || w.doNotTrack === '1' || nav.globalPrivacyControl)) optedOut = true;
  if (/bot|crawl|spider|headless|lighthouse|pingdom|puppeteer|playwright/i.test(nav.userAgent || '')) optedOut = true;

  // ---------- ids ----------
  function rid() {
    var a = new Uint8Array(12);
    (w.crypto || w.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var mem = {};
  function store(kind) {
    if (cfg.storage === 'none') return null;
    try { return kind === 's' ? w.sessionStorage : w.localStorage; } catch (e) { return null; }
  }
  function get(k, kind) { var s = store(kind); try { return s ? s.getItem(k) : mem[k]; } catch (e) { return mem[k]; } }
  function set(k, v, kind) { var s = store(kind); try { s ? s.setItem(k, v) : (mem[k] = v); } catch (e) { mem[k] = v; } }

  var SESSION_TTL = 30 * 60 * 1000;
  function anonId() {
    var id = get('zt_aid');
    if (!id) { id = rid(); set('zt_aid', id); }
    return id;
  }
  function sessionId() {
    var now = Date.now();
    var last = parseInt(get('zt_last') || '0', 10);
    var id = get('zt_sid');
    if (!id || now - last > SESSION_TTL) { id = rid(); set('zt_sid', id); }
    set('zt_last', String(now));
    return id;
  }
  if (!optedOut && cfg.sample < 1) {
    var bucket = parseInt(anonId().slice(0, 8), 16) / 0xffffffff;
    if (bucket > cfg.sample) optedOut = true;
  }

  // ---------- text helpers ----------
  var EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
  var DIGITS = /\d[\d\s-]{6,}\d/g;
  function clean(s, max) {
    if (!s) return '';
    s = String(s).replace(/\s+/g, ' ').trim().replace(EMAIL, '[email]').replace(DIGITS, '[number]');
    max = max || 80;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function cleanUrl(href) {
    try {
      var u = new URL(href, location.href);
      var keep = cfg.query ? cfg.query.split(',') : [];
      var out = new URLSearchParams();
      u.searchParams.forEach(function (v, k) {
        if (/^utm_/.test(k) || keep.indexOf(k) > -1) out.set(k, v);
      });
      var q = out.toString();
      return u.origin + u.pathname + (q ? '?' + q : '');
    } catch (e) { return ''; }
  }

  // ---------- auto-labeling ----------
  var ACTIONABLE = 'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[onclick],[data-zt]';
  var HASHY = /^(css|sc|jsx|emotion|svelte|astro|chakra|mui|Mui|makeStyles)-|[0-9a-f]{5,}|__[a-zA-Z0-9]{4,}$/;

  function ignored(el) {
    return !!(el && el.closest && el.closest('[data-zt-ignore],.zt-ignore'));
  }
  function masked(el) {
    return !!(el && el.closest && el.closest('[data-zt-mask],.zt-mask'));
  }
  function textOf(el) {
    if (!el) return '';
    if (masked(el)) return '[masked]';
    var t = el.innerText != null ? el.innerText : el.textContent;
    return clean(t);
  }
  function byId(ids) {
    return clean((ids || '').split(/\s+/).map(function (id) {
      var n = d.getElementById(id); return n ? n.textContent : '';
    }).join(' '));
  }
  function fieldLabel(el) {
    if (el.labels && el.labels[0]) return clean(el.labels[0].textContent);
    var wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent);
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || el.id);
  }

  function labelFor(el) {
    var tag = el.tagName.toLowerCase();
    var v = el.getAttribute('data-zt') || el.getAttribute('aria-label');
    if (v) return clean(v);
    v = el.getAttribute('aria-labelledby');
    if (v && (v = byId(v))) return v;
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      var type = (el.type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return clean(el.value) || type;
      return fieldLabel(el) || type || tag;
    }
    v = textOf(el);
    if (v) return v;
    var img = el.querySelector && el.querySelector('img[alt],svg[aria-label],[title]');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title'));
    v = el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.id;
    if (v) return clean(v);
    if (tag === 'a' && el.href) return clean(new URL(el.href, location.href).pathname, 60);
    return tag;
  }

  function kindOf(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    if (tag === 'a' && el.href) {
      var u; try { u = new URL(el.href, location.href); } catch (e) { return 'link'; }
      if (/^mailto:/.test(el.href)) return 'email_link';
      if (/^tel:/.test(el.href)) return 'phone_link';
      if (el.hasAttribute('download') || /\.(pdf|zip|dmg|exe|msi|csv|xlsx?|docx?|pptx?|mp3|mp4|mov|gz|tar|rar|7z|apk|pkg)$/i.test(u.pathname)) return 'download';
      if (u.host !== location.host) return 'outbound_link';
      if (u.pathname === location.pathname && u.hash) return 'anchor_link';
      return 'link';
    }
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'submit') return 'submit';
      if (t === 'checkbox' || t === 'radio') return t;
      return t === 'button' ? 'button' : 'field';
    }
    if (tag === 'button') return el.type === 'submit' && el.form ? 'submit' : 'button';
    if (tag === 'select' || tag === 'textarea') return 'field';
    if (tag === 'summary') return 'disclosure';
    if (role) return role;
    return tag === 'label' ? 'label' : 'element';
  }

  // Nearest meaningful region: landmark / section with a name or heading.
  var REGION = 'section,article,nav,header,footer,aside,form,dialog,main,[role=dialog],[role=navigation],[data-zt-section]';
  function regionOf(el) {
    var r = el.closest && el.closest(REGION);
    var hops = 0;
    while (r && hops++ < 6) {
      var name = r.getAttribute('data-zt-section') || r.getAttribute('aria-label') ||
        byId(r.getAttribute('aria-labelledby'));
      if (!name) {
        var h = r.querySelector('h1,h2,h3,legend');
        if (h) name = h.textContent;
      }
      if (!name && r.id) name = r.id.replace(/[-_]+/g, ' ');
      if (!name) {
        var t = r.tagName.toLowerCase();
        if (t === 'nav' || t === 'header' || t === 'footer') name = t;
      }
      if (name) return clean(name, 50);
      r = r.parentElement && r.parentElement.closest(REGION);
    }
    return '';
  }

  function selectorOf(el) {
    var parts = [];
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
      var tag = n.tagName.toLowerCase();
      if (n.id && !HASHY.test(n.id)) { parts.unshift(tag + '#' + n.id); break; }
      var cls = (typeof n.className === 'string' ? n.className : '').split(/\s+/)
        .filter(function (c) { return c && !HASHY.test(c) && c.length < 30 && !/[:[\]\/]/.test(c); }).slice(0, 2);
      var s = tag + (cls.length ? '.' + cls.join('.') : '');
      var p = n.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName; });
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(s);
      if (tag === 'body') break;
    }
    return parts.join('>');
  }

  function describe(el) {
    var info = { label: labelFor(el), kind: kindOf(el), tag: el.tagName.toLowerCase(), selector: selectorOf(el) };
    var region = regionOf(el);
    if (region) info.section = region;
    if (el.href) info.href = cleanUrl(el.href);
    return info;
  }

  // ---------- queue / transport ----------
  var queue = [];
  var listeners = [];
  var superProps = {};
  var timer = null;
  var page = { url: '', path: '', title: '', start: 0 };
  var endpoint = cfg.endpoint;

  function ctx() {
    return {
      site: cfg.site,
      v: VERSION,
      aid: cfg.storage === 'none' ? null : anonId(),
      sid: sessionId(),
      lang: nav.language,
      tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } })(),
      sw: w.screen && w.screen.width,
      sh: w.screen && w.screen.height,
      vw: w.innerWidth,
      vh: w.innerHeight
    };
  }

  function autoName(type, p) {
    var l = p.label ? '"' + p.label + '"' : '';
    switch (type) {
      case 'pageview': return 'Viewed ' + (p.title || p.path);
      case 'click': return 'Clicked ' + l + (p.section ? ' in ' + p.section : '');
      case 'rage_click': return 'Rage-clicked ' + l;
      case 'dead_click': return 'Dead click on ' + l;
      case 'scroll': return 'Scrolled ' + p.depth + '%';
      case 'section_view': return 'Saw section ' + l;
      case 'form_submit': return 'Submitted form ' + l;
      case 'form_abandon': return 'Abandoned form ' + l;
      case 'field_change': return 'Changed field ' + l + (p.section ? ' in ' + p.section : '');
      case 'copy': return 'Copied text from ' + (l || 'page');
      case 'media': return p.action + ' ' + (p.label ? l : 'media');
      case 'page_leave': return 'Left ' + p.path + ' after ' + Math.round(p.engaged_ms / 1000) + 's';
      case 'js_error': return 'JS error: ' + p.message;
      default: return type;
    }
  }

  function emit(type, props, name) {
    if (optedOut) return;
    props = props || {};
    var ev = { t: type, n: name || autoName(type, props), ts: Date.now(), u: page.url || cleanUrl(location.href), p: {} };
    for (var k in superProps) ev.p[k] = superProps[k];
    for (k in props) if (props[k] !== undefined && props[k] !== '') ev.p[k] = props[k];
    queue.push(ev);
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](ev); } catch (e) {} }
    try { d.dispatchEvent(new CustomEvent('zerotag:event', { detail: ev })); } catch (e) {}
    if (cfg.debug && w.console) console.log('[zerotag]', ev.n, ev);
    if (queue.length >= cfg.batch) flush();
    else if (!timer) timer = setTimeout(flush, cfg.flushMs);
  }

  function flush(beacon) {
    clearTimeout(timer); timer = null;
    if (!queue.length) return;
    var events = queue.splice(0, 100);
    var body = JSON.stringify({ c: ctx(), r: d.referrer ? cleanUrl(d.referrer) : '', e: events });
    // text/plain keeps this a "simple" request: no CORS preflight.
    if (beacon && nav.sendBeacon) {
      try { if (nav.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
    }
    try {
      fetch(endpoint, { method: 'POST', body: body, keepalive: body.length < 60000, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit' })
        .catch(function () {});
    } catch (e) {}
    if (queue.length) flush(beacon);
  }

  // ---------- pageviews / SPA navigation ----------
  var maxScroll = 0, scrollMarks = {}, engaged = 0, lastActive = Date.now(), visibleSince = Date.now();
  var forms = [];

  function engagedNow() {
    var now = Date.now();
    if (d.visibilityState === 'visible' && now - lastActive < 30000) engaged += now - visibleSince;
    visibleSince = now;
    return engaged;
  }

  function leavePage() {
    if (!page.path) return;
    forms.forEach(function (f) {
      if (f.touched && !f.submitted) emit('form_abandon', { label: f.label, section: f.section, fields_touched: f.fields.length, last_field: f.fields[f.fields.length - 1] });
    });
    emit('page_leave', { path: page.path, engaged_ms: engagedNow(), max_scroll: maxScroll });
  }

  function newPage() {
    var url = cleanUrl(location.href);
    if (url === page.url) return;
    var prev = page.url;
    if (prev) leavePage();
    page = { url: url, path: location.pathname, title: clean(d.title, 120), start: Date.now() };
    maxScroll = 0; scrollMarks = {}; engaged = 0; visibleSince = lastActive = Date.now(); forms = [];
    var utm = {};
    try {
      new URL(location.href).searchParams.forEach(function (v, k) { if (/^utm_/.test(k)) utm[k] = clean(v, 60); });
    } catch (e) {}
    emit('pageview', Object.assign({ path: page.path, title: page.title, prev: prev || undefined, referrer: prev ? undefined : (d.referrer ? cleanUrl(d.referrer) : undefined) }, utm));
    setTimeout(observeSections, 400);
    setTimeout(onScroll, 500);
  }

  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    if (!orig) return;
    history[fn] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(newPage, 0);
      return r;
    };
  });
  w.addEventListener('popstate', function () { setTimeout(newPage, 0); });

  // ---------- clicks, rage clicks, dead clicks ----------
  var recent = [];
  var mutated = false;
  if (w.MutationObserver) {
    new MutationObserver(function (records) {
      // Changes inside ignored regions (e.g. a debug panel) don't count as the page reacting.
      for (var i = 0; i < records.length; i++) {
        var n = records[i].target;
        if (!ignored(n.nodeType === 1 ? n : n.parentElement)) { mutated = true; return; }
      }
    }).observe(d.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  d.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || target.nodeType !== 1 || ignored(target)) return;
    var el = target.closest(ACTIONABLE) || target;
    var interactive = el !== target || target.matches(ACTIONABLE);
    // Clicking a <label> fires a synthetic click on its input; keep only one.
    if (el.tagName === 'LABEL' && el.control) return;
    if (el.tagName === 'INPUT' && /^(text|email|password|search|tel|url|number)$/i.test(el.type)) return;
    if (el.type === 'password') return;

    var info = describe(el);
    if (!interactive) {
      var cs = w.getComputedStyle ? w.getComputedStyle(target) : null;
      if (!(cs && cs.cursor === 'pointer')) { info.interactive = false; }
    }
    if (el.type === 'checkbox' || el.type === 'radio') info.checked = !!el.checked;
    info.x = Math.round(e.pageX); info.y = Math.round(e.pageY);
    emit('click', info);

    // rage: 3+ clicks within 800ms within 40px
    var now = Date.now();
    recent = recent.filter(function (c) { return now - c.t < 800; });
    recent.push({ t: now, x: e.clientX, y: e.clientY });
    var near = recent.filter(function (c) { return Math.abs(c.x - e.clientX) < 40 && Math.abs(c.y - e.clientY) < 40; });
    if (near.length === 3) emit('rage_click', { label: info.label, section: info.section, selector: info.selector });

    // dead: element looks clickable but nothing happened within 1s
    if (info.kind !== 'link' && info.kind !== 'outbound_link' && info.kind !== 'download' && info.kind !== 'checkbox' && info.kind !== 'radio' && info.interactive !== false) {
      mutated = false;
      var before = location.href;
      setTimeout(function () {
        if (!mutated && location.href === before && d.visibilityState === 'visible') {
          emit('dead_click', { label: info.label, section: info.section, selector: info.selector });
        }
      }, 1000);
    }
  }, true);

  // ---------- scroll depth ----------
  var scrollTick = false;
  function onScroll() {
    scrollTick = false;
    var de = d.documentElement, b = d.body;
    var h = Math.max(de.scrollHeight, b ? b.scrollHeight : 0) - w.innerHeight;
    var pct = h <= 0 ? 100 : Math.min(100, Math.round(((w.scrollY || de.scrollTop) / h) * 100));
    if (pct > maxScroll) maxScroll = pct;
    [25, 50, 75, 90, 100].forEach(function (m) {
      if (maxScroll >= m && !scrollMarks[m]) { scrollMarks[m] = 1; if (h > 0) emit('scroll', { depth: m, path: page.path }); }
    });
  }
  w.addEventListener('scroll', function () {
    lastActive = Date.now();
    if (!scrollTick) { scrollTick = true; (w.requestAnimationFrame || setTimeout)(onScroll); }
  }, { passive: true });

  // ---------- section views ----------
  var io = null, seen = {};
  function observeSections() {
    if (!w.IntersectionObserver) return;
    if (io) io.disconnect();
    seen = {};
    var timers = new Map();
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var el = en.target;
        if (en.isIntersecting && en.intersectionRatio >= 0.4) {
          if (!timers.has(el)) timers.set(el, setTimeout(function () {
            var label = regionOf(el.firstElementChild || el) || regionOf(el);
            if (label && !seen[label]) { seen[label] = 1; emit('section_view', { label: label, path: page.path }); }
            io && io.unobserve(el);
          }, 1000));
        } else if (timers.has(el)) { clearTimeout(timers.get(el)); timers.delete(el); }
      });
    }, { threshold: [0, 0.4] });
    var nodes = d.querySelectorAll('section,article,[data-zt-section],main>div[id]');
    for (var i = 0; i < nodes.length && i < 60; i++) if (!ignored(nodes[i])) io.observe(nodes[i]);
  }

  // ---------- forms (never values) ----------
  function formState(form) {
    for (var i = 0; i < forms.length; i++) if (forms[i].el === form) return forms[i];
    var submit = form.querySelector('[type=submit],button:not([type=button])');
    var st = {
      el: form,
      label: clean(form.getAttribute('data-zt') || form.getAttribute('aria-label') || form.getAttribute('name') || form.id || (submit && labelFor(submit)) || regionOf(form) || 'form', 60),
      section: regionOf(form.parentElement || form),
      fields: [], touched: false, submitted: false
    };
    forms.push(st);
    return st;
  }
  d.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.tagName || ignored(el) || el.type === 'password') return;
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    var label = fieldLabel(el) || el.type;
    var props = { label: label, field_type: el.type || el.tagName.toLowerCase(), section: regionOf(el) };
    if (el.form) {
      var st = formState(el.form);
      st.touched = true;
      if (st.fields.indexOf(label) < 0) st.fields.push(label);
      props.form = st.label;
    }
    if (el.type !== 'checkbox' && el.type !== 'radio') emit('field_change', props);
  }, true);
  d.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || ignored(form)) return;
    var st = formState(form);
    st.submitted = true;
    emit('form_submit', { label: st.label, section: st.section, fields: form.elements ? form.elements.length : 0, fields_touched: st.fields.length, action: form.action ? cleanUrl(form.action) : undefined });
    flush(true);
  }, true);

  // ---------- copy, media, errors, activity ----------
  d.addEventListener('copy', function (e) {
    var el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    if (!el || ignored(el)) return;
    var sel = w.getSelection ? String(w.getSelection()).length : 0;
    emit('copy', { label: regionOf(el) || labelFor(el), chars: sel });
  }, true);
  ['play', 'pause', 'ended'].forEach(function (type) {
    d.addEventListener(type, function (e) {
      var el = e.target;
      if (!el || !/^(VIDEO|AUDIO)$/.test(el.tagName) || ignored(el)) return;
      var src = el.currentSrc || el.src || '';
      emit('media', { action: type, label: clean(el.getAttribute('aria-label') || el.title || src.split('/').pop(), 60), media: el.tagName.toLowerCase(), at_s: Math.round(el.currentTime || 0), section: regionOf(el) });
    }, true);
  });
  w.addEventListener('error', function (e) {
    if (!e || !e.message) return;
    emit('js_error', { message: clean(e.message, 140), source: e.filename ? cleanUrl(e.filename) : undefined, line: e.lineno });
  });
  ['mousemove', 'keydown', 'touchstart'].forEach(function (t) {
    w.addEventListener(t, function () { lastActive = Date.now(); }, { passive: true });
  });

  // ---------- lifecycle ----------
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'hidden') { engagedNow(); flush(true); }
    else { visibleSince = Date.now(); sessionId(); }
  });
  w.addEventListener('pagehide', function () { leavePage(); flush(true); });

  // ---------- public API ----------
  var api = {
    _v: VERSION,
    config: cfg,
    track: function (name, props) { emit('custom', props || {}, String(name)); },
    set: function (props) { for (var k in props) superProps[k] = props[k]; },
    on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    optOut: function () { optedOut = true; queue = []; set('zt_optout', '1'); },
    optIn: function () { optedOut = false; set('zt_optout', ''); },
    flush: function () { flush(); },
    describe: describe
  };
  // Replay calls made through a stub: window.zerotag = window.zerotag || {q:[]}
  var stub = w.zerotag;
  w.zerotag = api;
  if (stub && stub.q) stub.q.forEach(function (c) { try { api[c[0]].apply(api, c[1]); } catch (e) {} });

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', newPage);
  else newPage();
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
