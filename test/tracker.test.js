import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const src = readFileSync(new URL('../src/zerotag.js', import.meta.url), 'utf8');

async function setup(html) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Home</title></head><body>${html}</body></html>`, {
    url: 'https://shop.example.com/pricing?utm_source=x&email=a@b.co', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const { window } = dom;
  const sent = [];
  window.fetch = (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true }); };
  window.navigator.sendBeacon = (url, blob) => false;
  const s = window.document.createElement('script');
  s.setAttribute('data-site', 'shop.example.com');
  s.setAttribute('data-endpoint', 'https://t.example.com/api/collect');
  window.document.head.appendChild(s);
  Object.defineProperty(window.document, 'currentScript', { value: s });
  window.eval(src);
  const events = [];
  window.zerotag.on((e) => events.push(e));
  if (window.document.readyState === 'loading') await new Promise((r) => window.document.addEventListener('DOMContentLoaded', r));
  return { window, doc: window.document, events, sent };
}

test('pageview strips non-utm query params', async () => {
  const { window, sent } = await setup('<p>hi</p>');
  window.zerotag.flush();
  const pv = sent[0].e[0];
  assert.equal(pv.t, 'pageview');
  assert.equal(pv.u, 'https://shop.example.com/pricing?utm_source=x');
  assert.equal(pv.p.utm_source, 'x');
});

test('click on nested span labels the button with its section', async () => {
  const { doc, events, window } = await setup(`
    <section id="pricing"><h2>Pricing</h2>
      <button class="btn css-1a2b3c"><span>Start free trial</span></button>
    </section>`);
  doc.querySelector('span').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const c = events.find((e) => e.t === 'click');
  assert.equal(c.p.label, 'Start free trial');
  assert.equal(c.p.kind, 'button');
  assert.equal(c.p.section, 'Pricing');
  assert.equal(c.n, 'Clicked "Start free trial" in Pricing');
  assert.ok(!c.p.selector.includes('css-1a2b3c'), 'hashed classes dropped');
});

test('icon button uses aria-label; outbound + download links classified', async () => {
  const { doc, events, window } = await setup(`
    <nav><button aria-label="Open menu"><svg></svg></button>
      <a href="https://github.com/x">GitHub</a><a href="/files/guide.pdf">Guide</a></nav>`);
  doc.querySelectorAll('button,a').forEach((el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  const clicks = events.filter((e) => e.t === 'click').map((e) => [e.p.label, e.p.kind, e.p.section]);
  assert.deepEqual(clicks, [['Open menu', 'button', 'nav'], ['GitHub', 'outbound_link', 'nav'], ['Guide', 'download', 'nav']]);
});

test('emails and long numbers in labels are masked; ignored elements skipped', async () => {
  const { doc, events, window } = await setup(`
    <button id="a">Send to jane@corp.com</button>
    <button id="b">Card 4242 4242 4242 4242</button>
    <div data-zt-ignore><button id="c">secret</button></div>`);
  ['a', 'b', 'c'].forEach((id) => doc.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const labels = events.filter((e) => e.t === 'click').map((e) => e.p.label);
  assert.deepEqual(labels, ['Send to [email]', 'Card [number]']);
});

test('forms: field labels tracked, values never; submit named after button', async () => {
  const { doc, events, window } = await setup(`
    <form id="signup-form" onsubmit="return false"><h3>Join the waitlist</h3>
      <label for="em">Work email</label><input id="em" type="email">
      <input type="password" id="pw">
      <button type="submit">Join waitlist</button></form>`);
  const em = doc.getElementById('em');
  em.value = 'me@secret.com';
  em.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('pw').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const fc = events.filter((e) => e.t === 'field_change');
  assert.equal(fc.length, 1);
  assert.equal(fc[0].p.label, 'Work email');
  assert.ok(!JSON.stringify(events).includes('secret'));
  const sub = events.find((e) => e.t === 'form_submit');
  assert.equal(sub.p.label, 'signup-form');
  assert.equal(sub.p.fields_touched, 1);
});

test('rage click detected', async () => {
  const { doc, events, window } = await setup('<button>Pay</button>');
  const b = doc.querySelector('button');
  for (let i = 0; i < 3; i++) b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
  assert.equal(events.filter((e) => e.t === 'rage_click').length, 1);
});

test('SPA navigation emits a new pageview and page_leave', async () => {
  const { window, events } = await setup('<p>x</p>');
  window.history.pushState({}, '', '/docs');
  await new Promise((r) => setTimeout(r, 10));
  const types = events.map((e) => e.t);
  assert.ok(types.includes('page_leave'));
  assert.equal(events.filter((e) => e.t === 'pageview').at(-1).p.path, '/docs');
});

test('custom track + super props', async () => {
  const { window, events } = await setup('');
  window.zerotag.set({ plan: 'pro' });
  window.zerotag.track('Upgraded', { seats: 5 });
  const e = events.at(-1);
  assert.equal(e.n, 'Upgraded');
  assert.equal(JSON.stringify(e.p), JSON.stringify({ plan: 'pro', seats: 5 }));
});
