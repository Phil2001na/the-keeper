// How the PC agent explains a browser that stops answering (pc-agent/pcState.mjs).
// The error strings are the real ones from the Auto-Tune runs of 17 Oct.
// Run with `npm test`. No PowerShell, no browser: the probe is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const s = await import('../pc-agent/pcState.mjs');

// What Codex's Computer Use `js` tool handed back when Chrome was frozen.
const CDP_TIMEOUT = [
  { type: 'input_text', text: 'Wall time: 11.3493 seconds\nOutput:' },
  { type: 'input_text', text: 'Timed out after 10000ms waiting for CDP command Emulation.setFocusEmulationEnabled.' },
];
const NAV_TIMEOUT = [
  { type: 'input_text', text: 'Wall time: 10.1284 seconds\nOutput:' },
  { type: 'input_text', text: 'Timed out waiting for tab 851992027 to navigate to https://www.antarestech.com/my-account/profile.' },
];
const PAGE = [
  { type: 'input_text', text: 'Wall time: 0.4 seconds\nOutput:' },
  { type: 'input_text', text: 'Browser tab: 851992027, Title: "Manage Subscription | AutoTune"\n1 AXWebArea Manage Subscription\n\t2 text Your session timed out, please sign in' },
];

const STANDBY = { known: true, standby: true, since: new Date('2026-10-17T07:10:51Z'), locked: true };
const AWAKE = { known: true, standby: false, since: null, locked: false };

test('the real browser-control errors are recognised, a page that merely says "timed out" is not', () => {
  assert.equal(s.browserError(CDP_TIMEOUT), 'Timed out after 10000ms waiting for CDP command Emulation.setFocusEmulationEnabled');
  assert.match(s.browserError(NAV_TIMEOUT)!, /^Timed out waiting for tab 851992027 to navigate/);
  assert.equal(s.browserError(PAGE), null);
  assert.equal(s.browserError({ message: 'Protocol error (Runtime.callFunctionOn): Target closed.' }), 'Protocol error (Runtime.callFunctionOn)');
  assert.equal(s.browserError('connect ECONNREFUSED 127.0.0.1:9222'), 'connect ECONNREFUSED 127.0.0.1:9222');
  assert.equal(s.browserError(null), null);
});

test('Computer Use on a frozen desktop is recognised too (the standby reproduction of 17 Oct)', () => {
  const empty = [{ type: 'input_text', text: '{"content":[{"type":"text","text":"{\\"accessibility\\":null,\\"screenshots\\":[],\\"window\\":{\\"app\\":\\"Chrome\\"}}"}],"isError":false}' }];
  assert.match(s.browserError(empty)!, /neither an accessibility tree nor a screenshot/);
  const stopped = { content: [{ type: 'text', text: 'Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows with enough confidence to enforce policy.' }], isError: true };
  assert.match(s.browserError(stopped)!, /could not determine the current browser URL$/);
});

test('only the head of a result is read: a long page body quoting an error is not a dead browser', () => {
  const long = [{ type: 'input_text', text: 'x'.repeat(5000) + ' waiting for CDP command Page.navigate' }];
  assert.equal(s.browserError(long), null);
});

test('the Kernel-Power probe output is read as standby / awake / unknown', () => {
  const asleep = s.parsePcState({ power: { id: 506, time: '2026-10-17T07:10:51.000Z' }, locked: true });
  assert.equal(asleep.standby, true);
  assert.equal(asleep.locked, true);
  assert.equal(asleep.since?.toISOString(), '2026-10-17T07:10:51.000Z');
  assert.equal(s.parsePcState({ power: { id: 507, time: '2026-10-17T07:07:48Z' }, locked: false }).standby, false);
  assert.equal(s.parsePcState({ error: 'powershell missing' }).known, false);
  assert.equal(s.parsePcState(null).known, false);
});

test('readPcState never throws: a failing or garbled probe is "unknown"', async () => {
  const failing = (_c: string, _a: string[], _o: object, cb: (e: Error | null, out: string) => void) => cb(new Error('timeout'), '');
  const garbled = (_c: string, _a: string[], _o: object, cb: (e: Error | null, out: string) => void) => cb(null, 'not json');
  const asleep = (_c: string, _a: string[], _o: object, cb: (e: Error | null, out: string) => void) =>
    cb(null, '{"power":{"id":506,"time":"2026-10-17T07:10:51Z"},"locked":true}\r\n');
  assert.equal((await s.readPcState({ run: failing })).known, false);
  assert.equal((await s.readPcState({ run: garbled })).known, false);
  assert.equal((await s.readPcState({ run: asleep })).standby, true);
});

test('a browser failure during standby says the screen was off, not "timeout"', () => {
  const t = s.explainBrowserTrouble(STANDBY, 'Timed out after 10000ms waiting for CDP command Emulation.setFocusEmulationEnabled');
  assert.match(t, /screen is off \(Modern Standby since \d\d:\d\d, and it is locked\)/);
  assert.match(t, /cannot be woken remotely/);
});

test('a browser failure while the PC is awake blames Chrome or the site, not the PC', () => {
  const t = s.explainBrowserTrouble(AWAKE, 'Timed out waiting for tab 1 to navigate');
  assert.match(t, /PC was awake and unlocked/);
  assert.doesNotMatch(t, /standby/i);
  assert.match(s.explainBrowserTrouble({ known: false, standby: false, since: null, locked: false }, 'x'), /could not be read/);
});

test('a session starting in standby is told to stop retrying; an awake one is told nothing', () => {
  assert.match(s.startNote(STANDBY), /check once more and then stop/);
  assert.equal(s.startNote(AWAKE), '');
});

test('the screenshot note gives the real reason instead of "locked or display off"', () => {
  const ffmpeg = '[in#0/gdigrab @ 0] Failed to capture image (error 5)\n[out#0/image2 @ 0] Output file does not contain any stream\nError opening output file x.jpg.\nError opening output files: Invalid argument';
  assert.equal(s.ffmpegReason(ffmpeg), '[in#0/gdigrab @ 0] Failed to capture image (error 5)');
  assert.match(s.screenshotNote(ffmpeg, STANDBY), /Modern Standby/);
  assert.match(s.screenshotNote(ffmpeg, AWAKE), /refused to capture the desktop/);
});

test('the watch probes once per burst of failures, tells the phone, and sums up in the report', async () => {
  let t = 0;
  let probes = 0;
  const notices: string[] = [];
  const w = s.createBrowserWatch({
    probe: async () => { probes += 1; return STANDBY; },
    onNotice: (text: string) => { notices.push(text); },
    every: 120_000,
    now: () => t,
  });
  assert.equal(await w.see(PAGE), null);
  assert.equal(w.summary(), '');
  await w.see(CDP_TIMEOUT);
  t += 10_000;
  await w.see(CDP_TIMEOUT);
  t += 3_000;
  await w.see(CDP_TIMEOUT);
  assert.equal(probes, 1, 'one probe for the burst');
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Modern Standby/);
  assert.equal(w.count, 3);
  assert.match(w.summary(), /browser control failed 3 times in this session\. .*Modern Standby/);
  t += 200_000;
  await w.see(NAV_TIMEOUT);
  assert.equal(probes, 2, 'probed again after the quiet period');
});

test('a session that started in standby and read the browser is flagged unverified even with no error', async () => {
  // Seen live on 17 Oct: in standby, example.com came back with "no visible heading" and no error.
  const asleep = s.createBrowserWatch({ startState: STANDBY, probe: async () => STANDBY });
  assert.equal(asleep.summary(), '', 'nothing to say before any browser use');
  await asleep.see(PAGE);
  assert.match(asleep.summary(), /screen was off .*may be blank or incomplete.*unverified/);
  const awake = s.createBrowserWatch({ startState: AWAKE, probe: async () => AWAKE });
  await awake.see(PAGE);
  assert.equal(awake.summary(), '');
  assert.match(s.startNote(STANDBY), /blank or half-empty/);
});

test('two failures at once share one probe', async () => {
  let probes = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const w = s.createBrowserWatch({ probe: async () => { probes += 1; await gate; return AWAKE; } });
  const a = w.see(CDP_TIMEOUT);
  const b = w.see(CDP_TIMEOUT);
  release();
  assert.equal(await a, await b);
  assert.equal(probes, 1);
});
