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
  assertSubscribeForm(html);
});

function subscribeForms(html) {
  return [...html.matchAll(/<form\b[^>]*embed-subscribe\/adrrr[\s\S]*?<\/form>/gi)].map((m) => m[0]);
}

function assertSubscribeForm(html) {
  const forms = subscribeForms(html);
  assert.ok(forms.length >= 1, 'missing embed-subscribe form');
  for (const form of forms) {
    assert.match(form, /method="post"/);
    assert.doesNotMatch(form, /\btarget\s*=/i);
    assert.equal((form.match(/name="email"/g) || []).length, 1);
    const hiddens = [...form.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)].map((m) => m[0]);
    assert.deepEqual(hiddens.length, 1);
    assert.match(hiddens[0], /name="embed"/);
    assert.match(hiddens[0], /value="1"/);
    assert.doesNotMatch(form, /name="(?:redirect|tag|metadata)"/i);
  }
}

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
    assertSubscribeForm(html);
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
    assertSubscribeForm(html);
    assert.ok(visibleFinePrint(html).includes(NEWSLETTER.fine));
    for (const line of [NEWSLETTER.eyebrow, NEWSLETTER.title, NEWSLETTER.body, NEWSLETTER.button, NEWSLETTER.disclaimer]) {
      assert.ok(html.includes(line), line);
    }
  }
});

test('thanks page is the on-site confirmation and does not ask to subscribe again', () => {
  const html = read('thanks/index.html');
  assert.match(html, /data-site-header/);
  assert.match(html, /data-site-footer/);
  assert.match(html, /\/assets\/js\/site\.js/);
  assert.match(html, /\/assets\/css\/theme\.css/);
  assert.match(html, /\/assets\/css\/newsletter\.css/);
  assert.match(html, /data-newsletter="off"/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(html, /<h1>訂閱成功<\/h1>/);
  assert.match(html, /ADRRR News Lab/);
  assert.match(html, /下一個工作天起，每朝 9 點前送到你的信箱。現在可以先讀今日晨報。/);
  assert.match(html, /href="\/latest"[^>]*>讀今日晨報/);
  assert.match(html, /href="\/news\/"[^>]*>往期 Archive/);
  assert.match(html, /href="\/backtest\/"[^>]*>Backtest/);
  assert.match(html, /href="\/politician-tracker\/"[^>]*>Politician Tracker/);
  assert.match(html, /免費 · 隨時取消/);
  assert.match(html, /href="https:\/\/x\.com\/adrnnng"[^>]*>跟住 @adrnnng/);
  assert.equal(subscribeForms(html).length, 0);
  assert.doesNotMatch(html, /升級|付費|upgrade|premium/i);
});
