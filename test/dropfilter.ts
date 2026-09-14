/*
 * What counts as a patch file inside a folder or an archive.
 *
 * One rule, used by both, because dropping a folder and dropping a zip of that
 * same folder should not disagree. Most of these files have no extension worth
 * trusting - a 32-voice bulk dump called BANK12 is extremely normal - so size
 * carries as much of the decision as the name does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeVoiceFile } from '../src/ui/state.ts';

test('named like a patch file, whatever the size', () => {
  for (const name of ['A.syx', 'a.SYX', 'x.dx7', 'x.bin', 'x.dmp', 'x.vce', 'x.snd', 'x.raw']) {
    assert.equal(looksLikeVoiceFile(name, 7), true, name);
  }
});

test('sized like a dump, whatever the name', () => {
  assert.equal(looksLikeVoiceFile('BANK12', 4104), true, 'a 32-voice bulk dump');
  assert.equal(looksLikeVoiceFile('BANK12', 163), true, 'a single voice');
  assert.equal(looksLikeVoiceFile('BANK12', 4096), true, 'a headerless bank');
  assert.equal(looksLikeVoiceFile('BANK12', 8192), true, 'two of them');
});

test('the things a folder of patches also contains are left alone', () => {
  assert.equal(looksLikeVoiceFile('readme.txt', 500), false);
  assert.equal(looksLikeVoiceFile('cover.jpg', 220417), false);
  assert.equal(looksLikeVoiceFile('manual.pdf', 1048577), false);
  assert.equal(looksLikeVoiceFile('notes.md', 31), false);
});

test('directories and empty files are not files to open', () => {
  assert.equal(looksLikeVoiceFile('banks/', 0), false);
  assert.equal(looksLikeVoiceFile('banks/', 4104), false, 'a trailing slash is a directory');
  assert.equal(looksLikeVoiceFile('empty.syx', 0), false);
  assert.equal(looksLikeVoiceFile('x.bin', -1), false);
});
