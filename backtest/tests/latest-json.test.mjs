import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newsDoorCaption, parseLatest } from '../../assets/js/latest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const lead = {
  date: '2026-10-20',
  headline: 'Lead headline',
  summary: 'Lead summary',
  image_url: '/news/img/20261020/lead.webp',
  image_url_original: 'https://publisher.example/original.jpg',
  image_credit: 'Wire',
  source_name: 'Desk',
  source_url: 'https://publisher.example/story',
  report_url: '/news/20261020/',
  extra: 'ignored',
};

test('parseLatest uses image_url and ignores unknown fields', () => {
  const story = parseLatest(lead);
  assert.equal(story.imageUrl, '/news/img/20261020/lead.webp');
  assert.equal(story.headline, 'Lead headline');
  assert.equal(story.summary, 'Lead summary');
  assert.equal(story.reportUrl, '/news/20261020/');
  assert.equal(story.sourceUrl, 'https://publisher.example/story');
  assert.equal(story.credit, 'Wire');
  assert.equal('image_url_original' in story, false);
  assert.equal('extra' in story, false);
});

test('newsDoorCaption uses a truncated headline and falls back without one', () => {
  assert.deepEqual(newsDoorCaption(null), { title: 'Morning Report', sub: '每朝 9 點前' });
  assert.deepEqual(newsDoorCaption({ headline: '   ', image_url: null }), { title: 'Morning Report', sub: '每朝 9 點前' });
  assert.deepEqual(newsDoorCaption({ headline: 'Nscale signs Anthropic', image_url: null }), {
    title: 'Nscale signs Anthropic',
    sub: '每朝 9 點前',
  });
  const long = 'Markets reopen after a long weekend with rates, chips, and a weaker dollar in focus today';
  const cap = newsDoorCaption({ headline: long });
  assert.ok(cap.title.length <= 52, cap.title);
  assert.ok(cap.title.endsWith('…'));
  assert.equal(cap.sub, '每朝 9 點前');
  assert.doesNotMatch(cap.sub, /08:15/);
  const news = JSON.parse(readFileSync(join(ROOT, 'assets/tools.json'), 'utf8')).tools.find((t) => t.id === 'news');
  assert.ok(news.highlights.includes('每朝 9 點前'));
  assert.equal(news.highlights.some((h) => String(h).includes('08:15')), false);
});

test('parseLatest falls back when image_url is null, empty, or not a url', () => {
  assert.equal(parseLatest({ ...lead, image_url: null }), null);
  assert.equal(parseLatest({ ...lead, image_url: '' }), null);
  assert.equal(parseLatest({ ...lead, image_url: 'javascript:alert(1)' }), null);
  assert.equal(parseLatest({ ...lead, headline: '  ' }), null);
  assert.equal(parseLatest(null), null);
});
