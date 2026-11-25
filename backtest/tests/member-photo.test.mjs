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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

/** ids present in the payload; files is id → bytes, or null when the JPEG is absent. */
export function portraitProblems(ids, files, exemptions) {
  const problems = [];
  const idSet = new Set(ids);
  for (const id of [...exemptions].sort()) {
    if (!idSet.has(id)) problems.push(`invalid exemption ${id}`);
    else if (files.get(id)) problems.push(`stale exemption ${id}`);
  }
  for (const id of [...idSet].sort()) {
    const bytes = files.get(id);
    if (!bytes) {
      if (!exemptions.has(id)) problems.push(`missing ${id}`);
      continue;
    }
    if (exemptions.has(id)) continue;
    if (bytes.subarray(0, 3).toString('hex') !== 'ffd8ff') problems.push(`invalid jpeg ${id}`);
  }
  return problems;
}

test('portrait exemptions stay inside the payload and cannot hide a real file', () => {
  const ids = ['R000619', 'P000197'];
  const files = new Map([['R000619', JPEG], ['P000197', null]]);
  assert.deepEqual(portraitProblems(ids, files, new Set()), ['missing P000197']);
  assert.deepEqual(portraitProblems(ids, files, new Set(['P000197'])), []);
  const both = new Map([['R000619', JPEG], ['P000197', JPEG]]);
  assert.deepEqual(portraitProblems(ids, both, new Set(['R000619'])), ['stale exemption R000619']);
  assert.deepEqual(portraitProblems(ids, files, new Set(['A000383'])), ['invalid exemption A000383', 'missing P000197']);
  const bad = new Map([['R000619', Buffer.from('not-a-jpeg')], ['P000197', JPEG]]);
  assert.deepEqual(portraitProblems(ids, bad, new Set()), ['invalid jpeg R000619']);
  assert.deepEqual(portraitProblems(ids, new Map([['R000619', JPEG], ['P000197', JPEG]]), new Set()), []);
});

test('every bioguide currently in the tracker data has a committed JPEG', () => {
  const data = JSON.parse(readFileSync(join(ROOT, 'politician-tracker/data.json'), 'utf8'));
  const ids = new Set();
  for (const row of [...data.vip, ...data.trades]) {
    if (row.bioguide) ids.add(row.bioguide);
  }
  assert.ok(ids.has('R000619'));
  // A000383 is not in this payload and has no committed JPEG. An exemption is
  // valid only while that id is still in vip/trades and the file is still absent.
  const noOfficialPortrait = new Set();
  const files = new Map([...ids].map((id) => {
    const path = join(ROOT, 'politician-tracker/img', `${id}.jpg`);
    return [id, existsSync(path) ? readFileSync(path) : null];
  }));
  assert.deepEqual(portraitProblems(ids, files, noOfficialPortrait), []);
});
