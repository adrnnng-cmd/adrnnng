import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MEMBER_PHOTO_PLACEHOLDER, memberPhotoImg, memberPhotoSrc } from '../../assets/js/member-photo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('member portraits use the local bioguide file, including non-VIP members', () => {
  assert.equal(memberPhotoSrc('R000619'), '/politician-tracker/img/R000619.jpg');
  assert.equal(memberPhotoSrc('P000197'), '/politician-tracker/img/P000197.jpg');
  assert.equal(memberPhotoSrc(''), '');
  assert.equal(memberPhotoSrc(null), '');
  assert.equal(memberPhotoSrc('r000619'), '');
  assert.equal(memberPhotoSrc('../etc/passwd'), '');
  assert.equal(memberPhotoSrc('R000619.jpg'), '');
});

test('the landing door uses the bioguide file for any member and falls back on error', () => {
  const html = memberPhotoImg('R000619');
  assert.equal(
    html,
    `<img src="/politician-tracker/img/R000619.jpg" alt="" width="56" height="70" onerror="this.onerror=null;this.src='${MEMBER_PHOTO_PLACEHOLDER}'">`,
  );
  assert.equal(
    memberPhotoImg(''),
    `<img src="${MEMBER_PHOTO_PLACEHOLDER}" alt="" width="56" height="70" onerror="this.onerror=null;this.src='${MEMBER_PHOTO_PLACEHOLDER}'">`,
  );
  assert.equal(memberPhotoImg('nope'), memberPhotoImg(''));
  const src = readFileSync(join(ROOT, 'assets/js/home.js'), 'utf8');
  assert.match(src, /memberPhotoImg\(filing\.bioguide\)/);
  assert.doesNotMatch(src, /data\.vip/);
  assert.doesNotMatch(src, /vip\?\.photo/);
  assert.equal(existsSync(join(ROOT, MEMBER_PHOTO_PLACEHOLDER.slice(1))), true);
});

test('tracker page portraits use the local file and a placeholder onerror', () => {
  const html = readFileSync(join(ROOT, 'politician-tracker/index.html'), 'utf8');
  const tags = html.match(/<img class="ph"[^>]*>/g) || [];
  assert.ok(tags.length >= 1);
  for (const tag of tags) {
    assert.match(tag, /src="\/politician-tracker\/img\/[A-Z]\d{6}\.jpg"/);
    assert.match(tag, /onerror="this\.onerror=null;this\.src='\/politician-tracker\/img\/placeholder\.svg'"/);
  }
});

test('every bioguide currently in the tracker data has a committed JPEG', () => {
  const data = JSON.parse(readFileSync(join(ROOT, 'politician-tracker/data.json'), 'utf8'));
  const ids = new Set();
  for (const row of [...data.vip, ...data.trades]) {
    if (row.bioguide) ids.add(row.bioguide);
  }
  assert.ok(ids.has('R000619'));
  // Appointed March 2026. theunitedstates.io 404s and bioguide.congress.gov/photo/A000383.jpg 404s.
  const noOfficialPortrait = new Set(['A000383']);
  const missing = [...ids].filter((id) => !existsSync(join(ROOT, 'politician-tracker/img', `${id}.jpg`))).sort();
  assert.deepEqual(missing, [...noOfficialPortrait].sort());
  for (const id of ids) {
    if (noOfficialPortrait.has(id)) continue;
    const bytes = readFileSync(join(ROOT, 'politician-tracker/img', `${id}.jpg`));
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', id);
  }
});
