// The dictation route's transcriber (src/web/dictate.ts). Run with `npm test`.
// No network: OpenAI is faked, so these pin what we send and how failures read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioExtension, DictationError, transcribe, MAX_DICTATION_BYTES } from '../src/web/dictate.ts';

const AUDIO = Buffer.from('not really audio, but the fake does not care');

function fakeOpenAI(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function rejects(p: Promise<unknown>, status: number, msg: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof DictationError);
    assert.equal(err.status, status);
    assert.match(err.message, msg);
    return true;
  });
}

test('what iPhone Safari and Chrome actually record maps to an extension OpenAI reads', () => {
  assert.equal(audioExtension('audio/mp4'), 'mp4');
  assert.equal(audioExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(audioExtension('Audio/WebM; codecs="opus"'), 'webm');
  assert.equal(audioExtension('audio/ogg'), 'ogg');
  assert.equal(audioExtension('application/json'), null);
  assert.equal(audioExtension(undefined), null);
});

test('sends the recording to gpt-4o-mini-transcribe with the server key and returns trimmed text', async () => {
  const api = fakeOpenAI(200, { text: '  remind me to call mum  ' });
  const text = await transcribe({ apiKey: 'sk-test', audio: AUDIO, contentType: 'audio/mp4', fetchImpl: api.impl });
  assert.equal(text, 'remind me to call mum');
  assert.equal(api.calls.length, 1);
  const { url, init } = api.calls[0]!;
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
  const form = init.body as FormData;
  assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal((form.get('file') as File).name, 'dictation.mp4');
});

test('the model can be overridden', async () => {
  const api = fakeOpenAI(200, { text: 'ok' });
  await transcribe({ apiKey: 'k', audio: AUDIO, contentType: 'audio/webm', model: 'gpt-4o-transcribe', fetchImpl: api.impl });
  assert.equal((api.calls[0]!.init.body as FormData).get('model'), 'gpt-4o-transcribe');
});

test('refuses before calling OpenAI when it cannot or should not', async () => {
  const api = fakeOpenAI(200, { text: 'x' });
  await rejects(transcribe({ apiKey: '', audio: AUDIO, contentType: 'audio/mp4', fetchImpl: api.impl }), 503, /isn’t set up/);
  await rejects(transcribe({ apiKey: 'k', audio: AUDIO, contentType: 'text/plain', fetchImpl: api.impl }), 415, /isn’t audio/);
  await rejects(transcribe({ apiKey: 'k', audio: Buffer.alloc(0), contentType: 'audio/mp4', fetchImpl: api.impl }), 400, /nothing was recorded/);
  await rejects(
    transcribe({ apiKey: 'k', audio: Buffer.alloc(MAX_DICTATION_BYTES + 1), contentType: 'audio/mp4', fetchImpl: api.impl }),
    413, /too long/
  );
  assert.equal(api.calls.length, 0);
});

test('OpenAI failures come back as plain messages, never the upstream detail', async () => {
  const err = fakeOpenAI(401, { error: { message: 'Incorrect API key provided: sk-abc…' } });
  await assert.rejects(transcribe({ apiKey: 'k', audio: AUDIO, contentType: 'audio/mp4', fetchImpl: err.impl }), (e: unknown) => {
    assert.ok(e instanceof DictationError);
    assert.equal(e.status, 502);
    assert.doesNotMatch(e.message, /sk-|API key/);
    return true;
  });
  await rejects(transcribe({ apiKey: 'k', audio: AUDIO, contentType: 'audio/mp4', fetchImpl: fakeOpenAI(429, '').impl }), 502, /busy/);
  await rejects(transcribe({ apiKey: 'k', audio: AUDIO, contentType: 'audio/mp4', fetchImpl: fakeOpenAI(200, { text: '  ' }).impl }), 422, /didn’t catch/);
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  await rejects(transcribe({ apiKey: 'k', audio: AUDIO, contentType: 'audio/mp4', fetchImpl: down }), 502, /couldn’t reach/);
});
