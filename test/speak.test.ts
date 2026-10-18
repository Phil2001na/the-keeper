// The read-aloud route's synthesizer (src/web/speak.ts). Run with `npm test`.
// No network: OpenAI is faked, so these pin what we send and how failures read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SPEECH_CHARS, SpeechError, speakableText, synthesize } from '../src/web/speak.ts';

const MP3 = Buffer.from('ID3 pretend mp3 bytes');

function fakeOpenAI(status: number, body: Buffer | string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function rejects(p: Promise<unknown>, status: number, msg: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof SpeechError);
    assert.equal(err.status, status);
    assert.match(err.message, msg);
    return true;
  });
}

test('markdown reads as prose: no fences, URLs or formatting marks', () => {
  const md = [
    '## Plan for **today**',
    '',
    '- Call the *bank* about `invoice 42`',
    '1. Read [the brief](https://example.com/brief?x=(1))',
    '> quoted bit',
    '',
    '```ts',
    'const secret = 1;',
    '```',
    'More at https://example.com/a/b ~~old~~',
  ].join('\n');
  const out = speakableText(md);
  assert.doesNotMatch(out, /[#*`>~]|https?:|const secret/);
  assert.match(out, /^Plan for today/);
  assert.match(out, /Call the bank about invoice 42/);
  assert.match(out, /Read the brief/);
  assert.match(out, /code block — see the screen/);
  assert.match(out, /More at a link old/);
});

test('snake_case and maths survive the emphasis stripping', () => {
  assert.equal(speakableText('run remember_fact now'), 'run remember_fact now');
  assert.equal(speakableText('2 * 3 * 4'), '2 * 3 * 4');
});

test('long replies are cut under the API cap at a sentence, with a note', () => {
  const long = 'This is one sentence. '.repeat(400);
  const out = speakableText(long);
  assert.ok(out.length <= MAX_SPEECH_CHARS);
  assert.match(out, /sentence\. The rest is on screen\.$/);
});

test('sends cleaned text to gpt-4o-mini-tts with the server key and returns the audio', async () => {
  const api = fakeOpenAI(200, MP3);
  const audio = await synthesize({ apiKey: 'sk-test', text: '**Done.** See `x`.', fetchImpl: api.impl });
  assert.deepEqual(audio, MP3);
  assert.equal(api.calls.length, 1);
  const { url, init } = api.calls[0]!;
  assert.equal(url, 'https://api.openai.com/v1/audio/speech');
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
  const body = JSON.parse(init.body as string);
  assert.equal(body.model, 'gpt-4o-mini-tts');
  assert.equal(body.voice, 'ash');
  assert.equal(body.input, 'Done. See x.');
  assert.equal(body.response_format, 'mp3');
  assert.ok(body.instructions);
});

test('model and voice can be overridden; tts-1 gets no instructions', async () => {
  const api = fakeOpenAI(200, MP3);
  await synthesize({ apiKey: 'k', text: 'hi', model: 'tts-1', voice: 'nova', fetchImpl: api.impl });
  const body = JSON.parse(api.calls[0]!.init.body as string);
  assert.equal(body.model, 'tts-1');
  assert.equal(body.voice, 'nova');
  assert.equal(body.instructions, undefined);
});

test('refuses before calling OpenAI when there is no key or nothing to say', async () => {
  const api = fakeOpenAI(200, MP3);
  await rejects(synthesize({ apiKey: '', text: 'hi', fetchImpl: api.impl }), 503, /set up/);
  await rejects(synthesize({ apiKey: 'k', text: '  \n ', fetchImpl: api.impl }), 400, /nothing/);
  assert.equal(api.calls.length, 0);
});

test('OpenAI failures become a short message, never the upstream detail', async () => {
  await rejects(synthesize({ apiKey: 'k', text: 'hi', fetchImpl: fakeOpenAI(429, 'rate limited sk-...').impl }), 502, /busy/);
  await rejects(synthesize({ apiKey: 'k', text: 'hi', fetchImpl: fakeOpenAI(401, 'bad key sk-abc').impl }), 502, /^couldn’t voice that$/);
  await rejects(synthesize({ apiKey: 'k', text: 'hi', fetchImpl: fakeOpenAI(200, '').impl }), 502, /voice/);
  const down = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  await rejects(synthesize({ apiKey: 'k', text: 'hi', fetchImpl: down }), 502, /reach/);
});
