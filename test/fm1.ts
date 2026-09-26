/*
 * Reading a voice from the FM-1: the bytes, checked against the original.
 *
 * The reference values were produced by running the pack7 and mkcmd functions
 * from czietz/fm1-read-voice - the implementation tested on hardware - so this
 * checks the port against it rather than against itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack7, unpack7, readVoiceRequest, parseReadVoiceReply, FM1_VOICE_LENGTH } from '../src/midi/fm1.ts';

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

test('the read request is byte-for-byte what the Python sends', () => {
  const req = readVoiceRequest();
  assert.equal(req[0], 0xf0);
  assert.equal(req[req.length - 1], 0xf7);
  assert.equal(hex(req.slice(1, -1)), '00 32 0d 41 00 00 40 02 00 00 00 00 30 13 00 00 5f 00');
  for (const b of req.slice(1, -1)) assert.ok(b < 0x80, 'a sysex data byte has its high bit set');
});

test('pack7 and unpack7 are inverses', () => {
  for (const len of [0, 1, 6, 7, 8, 13, 14, 155, 170]) {
    const data = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual([...unpack7(pack7(data))].slice(0, len), [...data], `length ${len}`);
  }
});

function reply(voice: Uint8Array): Uint8Array {
  const payload = [5, 0, 0, 0, 0, 155, 0, 0, ...voice];
  let sum = 0;
  for (const b of payload) sum = (sum + b) & 0xff;
  const framed = [0x00, 0x59, 0x23, payload.length & 0xff, 0, 0, ...payload, sum ^ 0xff];
  return Uint8Array.from([0xf0, ...pack7(framed), 0xf7]);
}

test('a reply gives back exactly the voice inside it', () => {
  const voice = Uint8Array.from({ length: FM1_VOICE_LENGTH }, (_, i) => (i * 7) % 100);
  const msg = reply(voice);
  // Same shape as the reference reply: 195 data bytes unpacking to 170.
  assert.equal(msg.length - 2, 195);
  assert.equal(hex(msg.slice(1, 25)), '00 32 0d 19 0a 00 40 02 00 00 00 00 30 13 00 00 00 0e 38 28 41 63 08 15');
  assert.deepEqual([...parseReadVoiceReply(msg)!], [...voice]);
});

test('other sysex on the same port is not mistaken for a voice', () => {
  const dx7Dump = Uint8Array.from([0xf0, 0x43, 0x00, 0x00, 0x01, 0x1b, ...new Array(156).fill(0), 0xf7]);
  assert.equal(parseReadVoiceReply(dx7Dump), null, 'a DX7 single-voice dump');
  assert.equal(parseReadVoiceReply([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]), null, 'an identity request');
  assert.equal(parseReadVoiceReply(readVoiceRequest()), null, 'our own request, echoed');
});
