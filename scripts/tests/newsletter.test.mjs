import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWSLETTER, newsletterCardHtml } from '../../assets/js/newsletter.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function visibleFinePrint(html) {
  return html.replace(/<a href="https:\/\/buttondown\.com\/adrrr">Buttondown<\/a>/, 'Buttondown');
}

test('signup card posts to Buttondown with the locked copy', () => {
  const html = newsletterCardHtml();
  assert.equal(NEWSLETTER.action, 'https://buttondown.com/api/emails/embed-subscribe/adrrr');
  assert.equal(NEWSLETTER.subscribeUrl, 'https://buttondown.com/adrrr');
  assert.match(html, /action="https:\/\/buttondown\.com\/api\/emails\/embed-subscribe\/adrrr"/);
  assert.match(html, /method="post"/);
  assert.match(html, /type="email"[^>]*name="email"[^>]*required|name="email"[^>]*required/);
  assert.match(html, /name="email"/);
  assert.match(html, /required/);
  assert.match(html, /type="hidden"[^>]*name="embed"[^>]*value="1"/);
  assert.match(html, /href="https:\/\/buttondown\.com\/adrrr"/);
  const text = visibleFinePrint(html);
  for (const line of [NEWSLETTER.eyebrow, NEWSLETTER.title, NEWSLETTER.body, NEWSLETTER.button, NEWSLETTER.fine, NEWSLETTER.disclaimer]) {
    assert.ok(text.includes(line), line);
  }
  assert.equal((html.match(/name="email"/g) || []).length, 1);
  assert.equal((html.match(/name="embed"/g) || []).length, 1);
  assert.doesNotMatch(html, /08:15/);
});

test('homepage strip, shared card, and tracker card use the signup outside news/', () => {
  const home = read('index.html');
  const backtest = read('backtest/index.html');
  const tracker = read('politician-tracker/index.html');
  const render = read('.github/politician-tracker/tracker/render.py');
  const site = read('assets/js/site.js');
  const template = read('scripts/templates/tool/index.html');
  const missing = read('404.html');

  assert.ok(home.includes(NEWSLETTER.strip));
  assert.match(home, /href="#newsletter"/);
  assert.match(home, /\/assets\/css\/newsletter\.css/);
  assert.match(home, /\/assets\/js\/site\.js/);

  for (const html of [home, backtest]) {
    assert.match(html, /id="newsletter"/);
    assert.match(html, /action="https:\/\/buttondown\.com\/api\/emails\/embed-subscribe\/adrrr"/);
    assert.match(html, /name="embed" value="1"/);
    for (const line of [NEWSLETTER.eyebrow, NEWSLETTER.title, NEWSLETTER.body, NEWSLETTER.button, NEWSLETTER.disclaimer]) {
      assert.ok(html.includes(line), line);
    }
  }

  for (const html of [backtest, template]) {
    assert.match(html, /\/assets\/css\/newsletter\.css/);
    assert.match(html, /data-site-footer/);
  }
  assert.match(site, /mountNewsletterCard/);
  assert.match(missing, /data-newsletter="off"/);

  for (const html of [tracker, render]) {
    assert.match(html, /action="https:\/\/buttondown\.com\/api\/emails\/embed-subscribe\/adrrr"/);
    assert.match(html, /name="embed" value="1"/);
    assert.ok(visibleFinePrint(html).includes(NEWSLETTER.fine));
    for (const line of [NEWSLETTER.eyebrow, NEWSLETTER.title, NEWSLETTER.body, NEWSLETTER.button, NEWSLETTER.disclaimer]) {
      assert.ok(html.includes(line), line);
    }
  }
});
