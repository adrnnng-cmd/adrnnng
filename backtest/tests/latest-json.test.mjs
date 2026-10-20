import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLatest } from '../../assets/js/latest.js';

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

test('parseLatest falls back when image_url is null, empty, or not a url', () => {
  assert.equal(parseLatest({ ...lead, image_url: null }), null);
  assert.equal(parseLatest({ ...lead, image_url: '' }), null);
  assert.equal(parseLatest({ ...lead, image_url: 'javascript:alert(1)' }), null);
  assert.equal(parseLatest({ ...lead, headline: '  ' }), null);
  assert.equal(parseLatest(null), null);
});
