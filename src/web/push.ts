import webpush, { WebPushError } from 'web-push';
import { config } from '../config.js';
import { pushSubscriptions, settings, type PushSubscriptionRow } from '../db/repositories.js';
import { bus } from './bus.js';

/**
 * Web Push — how the Keeper interrupts him on the web surface.
 *
 * SSE only reaches a tab that is already open. Telegram could always buzz his
 * phone; the PWA could not, which is why every proactive reach-out ended up
 * being a Telegram message. A push subscription is the missing half: the push
 * service (FCM / Mozilla / Apple) holds the connection, so the browser can be
 * woken with the app closed.
 *
 * What we send is encrypted end-to-end for one device (RFC 8291) and signed
 * with a VAPID keypair that identifies this server (RFC 8292) — the push
 * service relays it without ever being able to read it. That is also why the
 * keypair is load-bearing: every existing subscription is bound to the public
 * key it was created with, so minting a fresh one silently orphans every
 * installed device. It is stored, not regenerated.
 */

/** What the service worker receives. Keep it small — payloads are size-capped. */
export interface PushPayload {
  title: string;
  body: string;
  /** Notifications sharing a tag collapse into one. */
  tag?: string;
  /** Where a click should land. */
  url?: string;
  ts?: string;
  /**
   * Show the notification even with the app on screen. Only the "send a test"
   * button sets this: the whole point of a test is to SEE one, and he is by
   * definition looking at the settings sheet when he presses it.
   */
  force?: boolean;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const VAPID_KEY = 'web_push_vapid';

/** A stale reach-out is worse than a missed one — don't deliver yesterday's. */
const TTL_SECONDS = 4 * 60 * 60;

/** Long enough for two lines on a lock screen; the OS truncates past that anyway. */
const MAX_BODY = 180;

/** Drop a subscription after this many consecutive non-fatal failures. */
const MAX_FAILURES = 8;

let keys: VapidKeys | null = null;
let enabled = false;

/**
 * Resolves the VAPID keypair: env first (so it can be pinned in Railway), then
 * whatever was stored on a previous boot, and only then a fresh pair.
 *
 * Generating one on first boot rather than demanding an env var is deliberate —
 * it means notifications work the moment this deploys, with no dashboard step
 * standing between him and a working feature.
 */
async function resolveKeys(): Promise<VapidKeys | null> {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    return { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  }
  const stored = await settings.get<VapidKeys>(VAPID_KEY);
  if (stored?.publicKey && stored?.privateKey) return stored;

  const fresh = webpush.generateVAPIDKeys();
  await settings.set(VAPID_KEY, fresh);
  console.log('[push] generated a new VAPID keypair and stored it.');
  return fresh;
}

/**
 * Wires up push. Never throws: losing notifications is not a reason to take
 * the whole agent down, so a failure here just leaves the feature dark.
 */
export async function initPush(): Promise<void> {
  try {
    keys = await resolveKeys();
    if (!keys) return;
    webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
    enabled = true;
    const count = (await pushSubscriptions.list()).length;
    console.log(`[push] ready — ${count} subscribed device${count === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error('[push] disabled — could not set up VAPID:', err);
    enabled = false;
  }
}

/** The applicationServerKey the browser needs to subscribe. */
export function publicKey(): string | null {
  return enabled && keys ? keys.publicKey : null;
}

export async function saveSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): Promise<void> {
  await pushSubscriptions.save(input);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await pushSubscriptions.remove(endpoint);
}

async function deliverOne(sub: PushSubscriptionRow, body: string): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      { TTL: TTL_SECONDS, urgency: 'normal' }
    );
    await pushSubscriptions.markSent(sub.endpoint);
    return true;
  } catch (err) {
    const status = err instanceof WebPushError ? err.statusCode : 0;
    // 404/410 is the push service saying this endpoint is gone for good —
    // the browser rotated it or the app was uninstalled. Retrying forever
    // would be the thing that eventually makes every send slow.
    if (status === 404 || status === 410) {
      await pushSubscriptions.remove(sub.endpoint);
      console.log(`[push] pruned a dead subscription (${status}).`);
      return false;
    }
    const failures = sub.failures + 1;
    const message = (err as Error).message ?? String(err);
    if (failures >= MAX_FAILURES) {
      await pushSubscriptions.remove(sub.endpoint);
      console.error(`[push] dropped a subscription after ${failures} failures: ${message}`);
    } else {
      await pushSubscriptions.markFailed(sub.endpoint, failures, message);
      console.error(`[push] send failed (${status || 'no status'}, attempt ${failures}): ${message}`);
    }
    return false;
  }
}

/** Fans a payload out to every subscribed device. Returns how many landed. */
export async function sendPush(payload: PushPayload): Promise<{ sent: number; devices: number }> {
  if (!enabled) return { sent: 0, devices: 0 };
  const subs = await pushSubscriptions.list();
  if (subs.length === 0) return { sent: 0, devices: 0 };

  const body = JSON.stringify({
    ...payload,
    body: payload.body.length > MAX_BODY ? payload.body.slice(0, MAX_BODY - 1).trimEnd() + '…' : payload.body,
  });
  const results = await Promise.all(subs.map((s) => deliverOne(s, body)));
  return { sent: results.filter(Boolean).length, devices: subs.length };
}

/**
 * Push only what he'd actually want interrupting for.
 *
 * The rule is one line: a turn the agent started itself. A reply to something
 * he just typed is not the Keeper reaching out — on the web he is already
 * looking at the answer, and on Telegram the answer has already buzzed his
 * phone once. Proactive touchpoints are the whole reason this exists.
 */
export function attachPushToBus(): void {
  bus.subscribe((event) => {
    if (event.type !== 'message' || event.role !== 'agent') return;
    if (event.source.startsWith('inbound:')) return;

    void sendPush({
      title: 'keeper',
      body: event.content,
      tag: `keeper-${Date.parse(event.ts) || Date.now()}`,
      url: '/',
      ts: event.ts,
    })
      .then(({ sent, devices }) => {
        if (devices > 0) console.log(`[push] reach-out delivered to ${sent}/${devices} device(s).`);
      })
      .catch((err) => console.error('[push] failed to fan out a reach-out:', err));
  });
}
