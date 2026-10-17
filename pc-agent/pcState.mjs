// What state the PC is in, and what that means for a session driving the browser.
//
// A laptop in Modern Standby keeps this agent and the engines running (the
// network stays up), but the screen is off and Chrome's renderers are frozen:
// every CDP command times out and the screen cannot be captured. From inside a
// session that looks like "the browser timed out", so the session retries and
// then reports a generic timeout. That is what sank the Auto-Tune check on
// 17 Oct (standby from 09:10, job at 09:26). Nothing in software can bring the
// screen back from standby (SetThreadExecutionState only stops the PC going
// in), so the fix is to know, stop retrying, and say so plainly.
//
// Pure helpers plus one probe, kept apart from agent.mjs so they can be tested
// (test/pcState.test.ts) without starting the agent.

import { execFile } from 'node:child_process';

// Errors that mean the browser itself did not answer, as opposed to a page that
// says "timed out". Only the head of a tool result is checked: an error is the
// whole short output, while a page's accessibility tree can contain any words.
const BROWSER_ERROR = new RegExp(
  [
    'waiting for CDP command \\w+(?:\\.\\w+)*',
    'Timed out waiting for tab \\S+ to (?:navigate|load)[^\\n"]*',
    'Target (?:page, context or browser )?(?:has been )?closed',
    'Browser (?:has been )?(?:closed|disconnected)',
    'Session closed',
    'Execution context was destroyed',
    'Protocol error \\([\\w.]+\\)',
    'No (?:tab|target) with (?:given )?id',
    'connect ECONNREFUSED 127\\.0\\.0\\.1:\\d+',
    'Could not connect to (?:the )?(?:browser|Chrome)',
    // Codex Computer Use on a frozen desktop (seen in standby, 17 Oct).
    'could not determine the current browser URL',
    'accessibility\\W{1,4}null\\W{1,6}screenshots\\W{1,4}\\[\\]',
  ].join('|'),
  'i',
);
const HEAD = 1500;
/** Matches that are JSON, not a sentence, get a readable name. */
const EMPTY_CAPTURE = /^accessibility/i;

/** The text of a tool result, whatever shape the engine gives it ([{type,text}], {message}, a string), up to HEAD chars. */
export function flatText(v) {
  const out = [];
  let len = 0;
  const walk = (x, depth) => {
    if (len >= HEAD || x == null || depth > 6) return;
    if (typeof x === 'string') { out.push(x); len += x.length + 1; return; }
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    if (typeof x === 'object') for (const k of ['text', 'message', 'error', 'output', 'content']) walk(x[k], depth + 1);
  };
  walk(v, 0);
  return out.join('\n').slice(0, HEAD);
}

/** The browser-control error in a tool result, trimmed to one line, or null. */
export function browserError(result) {
  const head = flatText(result);
  const m = head.match(BROWSER_ERROR);
  if (!m) return null;
  if (EMPTY_CAPTURE.test(m[0])) return 'Computer Use got neither an accessibility tree nor a screenshot of the window';
  // Show the sentence it sits in ("Timed out after 10000ms waiting for CDP command X").
  const start = Math.max(head.lastIndexOf('\n', m.index) + 1, head.lastIndexOf('"', m.index) + 1);
  const end = m.index + m[0].length;
  return head.slice(start, end).replace(/\\n|\s+/g, ' ').trim().slice(0, 200);
}

/** The raw probe output -> { known, standby, since, locked }. */
export function parsePcState(raw) {
  const ev = raw?.power;
  const known = Boolean(raw) && !raw.error;
  // 506 = entering Modern Standby, 507 = leaving it. The newest one says where the PC is now.
  const standby = Number(ev?.id) === 506;
  const since = standby && ev?.time ? new Date(ev.time) : null;
  return { known, standby, since: since && !isNaN(since.getTime()) ? since : null, locked: Boolean(raw?.locked) };
}

const PROBE = `$e = Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-Power';Id=506,507} -MaxEvents 1 -ErrorAction SilentlyContinue
$l = [bool](Get-Process LogonUI -ErrorAction SilentlyContinue)
@{ power = $(if ($e) { @{ id = $e.Id; time = $e.TimeCreated.ToUniversalTime().ToString('o') } } else { $null }); locked = $l } | ConvertTo-Json -Compress`;

/** Ask Windows whether the PC is in Modern Standby and whether it is locked. Never throws. */
export function readPcState({ run = execFile, timeoutMs = 15_000 } = {}) {
  if (process.platform !== 'win32' && run === execFile) return Promise.resolve(parsePcState(null));
  return new Promise((resolve) => {
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PROBE, 'utf16le').toString('base64')],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(parsePcState({ error: err.message }));
        try { resolve(parsePcState(JSON.parse(String(stdout).trim()))); } catch { resolve(parsePcState({ error: 'unreadable' })); }
      },
    );
  });
}

const clock = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** One plain sentence: what the PC's state means for browser control. Empty when there is nothing to say. */
export function stateSentence(state) {
  if (!state?.known) return '';
  if (state.standby) {
    return `The PC's screen is off (Modern Standby${state.since ? ` since ${clock(state.since)}` : ''}${state.locked ? ', and it is locked' : ''}). Chrome is frozen while the screen is off, so browser control times out; it cannot be woken remotely, someone has to wake the PC.`;
  }
  if (state.locked) return 'The PC is awake but locked. The browser usually still answers; if it does not, unlocking the PC is the fix.';
  return '';
}

/** Added to a session's brief when it starts on a PC that cannot drive a browser right now. */
export function startNote(state) {
  if (!state?.standby) return '';
  return `\n\nPC state when this session started: ${stateSentence(state)} Pages can also come back blank or half-empty (no headings, no buttons) without any error. If a browser call times out or a page looks empty, check once more and then stop and report that the PC screen was off. Do not keep retrying, do not report a blank page as what the site shows, and do not blame the website.`;
}

/** Why a browser call failed, for the step chip on his phone and the report. */
export function explainBrowserTrouble(state, error) {
  const what = error ? `Browser control failed ("${error}"). ` : 'Browser control failed. ';
  if (state?.standby) return what + stateSentence(state);
  if (state?.known) return `${what}The PC was awake${state.locked ? ' (locked)' : ' and unlocked'} at the time, so this was Chrome or the website not answering, not the PC sleeping.`;
  return `${what}The PC's power state could not be read.`;
}

/** The note added to a report when the finish screenshot could not be taken. */
export function screenshotNote(stderr, state) {
  const sentence = stateSentence(state);
  if (sentence) return `(No screenshot with this one. ${sentence})`;
  const why = /error 5\b/.test(String(stderr)) ? 'Windows refused to capture the desktop (it is showing the lock or sign-in screen)' : 'the screen could not be captured';
  return `(No screenshot with this one: ${why}.)`;
}

/** The first line of ffmpeg's stderr that says what went wrong, not the generic last line. */
export function ffmpegReason(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /Failed to capture|Could not|denied|error \d+/i.test(l)) ?? lines.at(-1) ?? '').slice(0, 300);
}

/**
 * Watches one session's tool results for browser-control errors. On the first
 * one (and again only after `every` ms) it reads the PC's state and calls
 * `onNotice(text, state)`, so the phone and the session hear the real reason.
 * `summary()` is the paragraph added to the report if anything failed, or if
 * the session used the browser after starting on a PC in standby (`startState`):
 * a frozen page can read as blank with no error at all.
 */
export function createBrowserWatch({ probe = readPcState, onNotice = () => {}, every = 120_000, now = Date.now, startState = null } = {}) {
  let results = 0;
  let count = 0;
  let last = '';
  let lastState = null;
  let probedAt = -Infinity;
  let probing = null;
  return {
    async see(result) {
      results += 1;
      const err = browserError(result);
      if (!err) return null;
      count += 1;
      last = err;
      if (probing) return probing;
      if (now() - probedAt < every) return null;
      probedAt = now();
      probing = (async () => {
        lastState = await probe();
        const notice = explainBrowserTrouble(lastState, err);
        await onNotice(notice, lastState);
        return notice;
      })().finally(() => { probing = null; });
      return probing;
    },
    get count() { return count; },
    summary() {
      if (!count && results && startState?.standby) {
        return `\n\n(PC agent: this ran while the PC's screen was off (Modern Standby${startState.since ? ` since ${clock(startState.since)}` : ''}). Chrome does not draw pages then, so anything read from the browser may be blank or incomplete. Treat it as unverified until it is re-run with the PC awake.)`;
      }
      if (!count) return '';
      return `\n\n(PC agent: browser control failed ${count === 1 ? 'once' : `${count} times`} in this session. ${explainBrowserTrouble(lastState, last)})`;
    },
  };
}
