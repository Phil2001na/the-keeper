/* ══════════════════════════════════════════════════════════════════════════
   THE KEEPER — web surface

   No framework and no build step, matching the rest of the repo. The agent
   contract is unchanged: SSE in on /events, JSON out on /send, memory read
   from /api/snapshot.
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const stream = $('stream');

  let token = localStorage.getItem('keeper_token') || '';
  let workstreamId = new URLSearchParams(location.search).get('workstream');
  if (workstreamId) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:8px 14px;display:flex;gap:12px;align-items:center;font-size:12px';
    banner.textContent = 'Chatting in selected workstream';
    const leave = document.createElement('button'); leave.textContent = 'Switch to general chat';
    leave.onclick = () => { workstreamId = null; history.replaceState(null,"","/"); banner.remove(); };
    banner.append(leave); document.getElementById('stream').before(banner);
    fetch('/api/workstreams', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.ok ? r.json() : null).then(data => {
        const selected = data?.streams?.find(s => s.id === workstreamId);
        if (selected) banner.firstChild.textContent = 'Workstream: ' + selected.title;
      }).catch(() => {});
  }
  let es = null;
  let lastRole = null;
  // Newest message on screen, and what the last few said — catchUp() fills in
  // after the one and skips repeats of the other (the stream's timestamp and
  // the database's can differ by a few ms for the same message).
  let lastMsgAt = 0;
  const recentSaid = [];

  // ── helpers ───────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * A fenced block, rendered with its own copy button.
   *
   * This is the shape prompts arrive in — the thing most worth lifting out of
   * the transcript whole, and the thing hardest to select by hand on a phone.
   * The exact text is parked on the button so copying never depends on
   * re-reading the DOM (which would hand back the highlighted, escaped copy).
   */
  function codeBlock(lang, code) {
    return (
      '<div class="codeblock">' +
      '<div class="cb-bar">' +
      '<span class="cb-lang">' + esc(lang || 'text') + '</span>' +
      '<button type="button" class="copybtn" data-copy="' + esc(code) + '">' +
      icon('copy', 13) + '<span class="cb-label">copy</span>' +
      '</button>' +
      '</div>' +
      '<pre class="cb-code">' + esc(code) + '</pre>' +
      '</div>'
    );
  }

  /**
   * markdown-lite for agent text: fenced blocks come out first (so their
   * contents survive verbatim and don't get bold/link-mangled), then escape,
   * then bold / inline code / links, then the blocks go back in.
   */
  function fmt(s) {
    const blocks = [];
    const src = String(s ?? '').replace(
      // The newlines either side of a fence are eaten too: the bubble is
      // white-space: pre-wrap, so leaving them would open a blank line above
      // and below every block.
      /\r?\n?[ \t]*```([A-Za-z0-9+#_-]*)[ \t]*\r?\n?([\s\S]*?)```[ \t]*\r?\n?/g,
      (_m, lang, code) => {
        blocks.push([lang, code.replace(/\r?\n$/, '')]);
        return '\u0000CB' + (blocks.length - 1) + '\u0000';
      },
    );
    let h = esc(src);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => codeBlock(blocks[+i][0], blocks[+i][1]));
    return h;
  }

  /**
   * Copy text, with a fallback for the times navigator.clipboard isn't there —
   * it needs a secure context, and the UI is opened over plain http often
   * enough (npm run ui, LAN testing) for the silent failure to matter.
   */
  function legacyCopy(str) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, str.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function copyText(str) {
    if (!str) return false;
    try {
      // Raced, not just awaited: when the document isn't focused the clipboard
      // promise can sit pending forever rather than rejecting, which would
      // leave the button stuck with no feedback and the fallback never run.
      const ok = await Promise.race([
        navigator.clipboard.writeText(str).then(() => true),
        new Promise((r) => setTimeout(() => r(null), 1200)),
      ]);
      if (ok) return true;
    } catch { /* falls through */ }
    return legacyCopy(str);
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  const icon = (name, size) =>
    `<svg width="${size || 16}" height="${size || 16}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const nearBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;

  function append(node) {
    const stick = nearBottom();
    stream.appendChild(node);
    if (stick) stream.scrollTop = stream.scrollHeight;
  }

  function timeStr(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  let toastTimer = null;
  function toast(text, actionLabel, onAction) {
    const t = $('toast');
    clearTimeout(toastTimer);
    t.innerHTML = '';
    t.appendChild(el('span', null, esc(text)));
    if (actionLabel) {
      const b = el('button', null, esc(actionLabel));
      b.addEventListener('click', () => { t.classList.remove('show'); onAction(); });
      t.appendChild(b);
    }
    t.classList.add('show');
    // A toast offering an action shouldn't vanish while you reach for it.
    toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 12000 : 2800);
  }

  // ══ colour ════════════════════════════════════════════════════════════
  /**
   * OKLCH → sRGB. Needed in JS for the two things CSS can't hand back: a
   * concrete hex for <meta name="theme-color">, and the readable text colour to
   * sit on the accent (white on a yellow accent is unreadable, and the whole
   * premise is that any hue works).
   */
  function oklchToRgb(L, C, H) {
    const h = (H * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return lin.map((u) => {
      const v = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(Math.max(u, 0), 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255);
    });
  }

  const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

  function relLuminance(rgb) {
    const f = (c) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  const whiteContrast = (L, C, H) => 1.05 / (relLuminance(oklchToRgb(L, C, H)) + 0.05);

  /**
   * Solves the accent's lightness for a given hue.
   *
   * The design language is white text on the accent — that's the user bubble
   * and the send button. Whether that's legible depends enormously on hue: a
   * blue at OKLCH 62% is far darker in sRGB terms than a yellow at 62%. So
   * rather than fixing lightness and flipping the text colour (which makes half
   * the palette look like a different app), fix the *text* and solve for the
   * lightest accent that still clears 4.5:1.
   *
   * Yellows and limes can't get there without turning olive, so those — and
   * only those — keep a bright accent and take dark ink instead.
   */
  function solveAccent(C, H) {
    const LIGHTEST = 0.64;
    const DARKEST = 0.46;
    if (whiteContrast(LIGHTEST, C, H) >= 4.5) return { l: LIGHTEST, on: '#fff' };
    if (whiteContrast(DARKEST, C, H) < 4.5) return { l: 0.72, on: '#140b1e' };
    let lo = DARKEST, hi = LIGHTEST;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (whiteContrast(mid, C, H) >= 4.5) lo = mid;
      else hi = mid;
    }
    return { l: lo, on: '#fff' };
  }

  // ══ theme ═════════════════════════════════════════════════════════════
  const PRESETS = [
    { id: 'nebula', name: 'nebula', h: 272, spread: 44, chroma: 0.19, tint: 0.022 },
    { id: 'amber', name: 'keeper', h: 78, spread: -26, chroma: 0.15, tint: 0.02 },
    { id: 'cyan', name: 'jarvis', h: 222, spread: 34, chroma: 0.15, tint: 0.02 },
    { id: 'emerald', name: 'signal', h: 158, spread: 38, chroma: 0.15, tint: 0.018 },
    { id: 'ember', name: 'ember', h: 32, spread: -22, chroma: 0.17, tint: 0.022 },
    { id: 'mono', name: 'mono', h: 270, spread: 0, chroma: 0.03, tint: 0.008 },
  ];

  // Deep field / gargantua are neutral space photography — any color preset
  // reads fine over them. Elysium is a warm sunset photo with its own palette,
  // so picking it is a full takeover: accent hue, bubbles, glass and blooms
  // all shift to match, the same way a PRESETS swatch would, not just the
  // photo behind everything.
  const ELYSIUM_THEME = { h: 38, spread: -22, chroma: 0.15, tint: 0.026, glass: 48 };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Only the inputs — a preset's id/name would go stale the moment a slider
  // moves off it.
  const DEFAULT_THEME = {
    h: PRESETS[0].h,
    spread: PRESETS[0].spread,
    chroma: PRESETS[0].chroma,
    tint: PRESETS[0].tint,
    glass: 42,
    galaxy: 'deep',
  };
  let theme = loadTheme();

  function loadTheme() {
    try {
      const s = JSON.parse(localStorage.getItem('keeper_theme') || '{}');
      return {
        h: Number.isFinite(s.h) ? s.h : DEFAULT_THEME.h,
        spread: Number.isFinite(s.spread) ? s.spread : DEFAULT_THEME.spread,
        chroma: Number.isFinite(s.chroma) ? s.chroma : DEFAULT_THEME.chroma,
        tint: Number.isFinite(s.tint) ? s.tint : DEFAULT_THEME.tint,
        glass: Number.isFinite(s.glass) ? clamp(s.glass, 0, 100) : DEFAULT_THEME.glass,
        galaxy: s.galaxy === 'gargantua' || s.galaxy === 'elysium' ? s.galaxy : 'deep',
      };
    } catch {
      return { ...DEFAULT_THEME };
    }
  }

  let saveTimer = null;
  function saveTheme() {
    // Dragging the hue slider fires on every pixel; localStorage is synchronous
    // and would stutter the drag.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => localStorage.setItem('keeper_theme', JSON.stringify(theme)), 180);
  }

  function applyTheme(save) {
    root.style.setProperty('--h-base', theme.h);
    root.style.setProperty('--spread', theme.spread);
    root.style.setProperty('--chroma', theme.chroma);
    root.style.setProperty('--tint', theme.tint);
    root.style.setProperty('--glass', theme.glass);
    root.dataset.galaxy = theme.galaxy;
    // Gates backdrop-filter entirely below a threshold: at low glass the blur
    // is imperceptible but still costs a compositing pass per bubble.
    root.dataset.glass = theme.glass > 6 ? 'on' : 'off';

    // The accent is a gradient, so solve at its midpoint and let both stops
    // ride the same lightness.
    const solved = solveAccent(theme.chroma, theme.h + theme.spread / 2);
    theme.accentL = (solved.l * 100).toFixed(1) + '%';
    theme.onAccent = solved.on;
    root.style.setProperty('--accent-l', theme.accentL);
    root.style.setProperty('--on-accent', theme.onAccent);

    // How far the user bubble's gradient may thin. Glass makes a surface fade
    // toward whatever is behind it, and behind it is a dark field — so on the
    // light hues where solveAccent had to give up on white and switch to dark
    // text, thinning the accent drags it toward the background and closes the
    // gap with that dark text. Those hues get a much shallower range so the
    // slider can't quietly break contrast we solved for above.
    theme.ubA = (1 - theme.glass * (solved.on === '#fff' ? 0.0035 : 0.0012)).toFixed(3);
    root.style.setProperty('--ub-a', theme.ubA);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', hex(oklchToRgb(0.11, theme.tint, theme.h)));

    if (save) saveTheme();
    syncSettingsUI();
  }

  function syncSettingsUI() {
    $('hue').value = theme.h;
    $('spread').value = theme.spread;
    $('chroma').value = Math.round(theme.chroma * 100);
    $('glass').value = theme.glass;
    $('huev').textContent = Math.round(theme.h) + '°';
    $('spreadv').textContent = (theme.spread > 0 ? '+' : '') + theme.spread + '°';
    $('chromav').textContent = Math.round((theme.chroma / 0.3) * 100) + '%';
    $('glassv').textContent = Math.round(theme.glass) + '%';

    for (const b of document.querySelectorAll('.backdrop-option')) {
      b.setAttribute('aria-pressed', String(b.dataset.galaxy === theme.galaxy));
    }

    for (const b of $('presets').children) {
      const p = PRESETS.find((x) => x.id === b.dataset.preset);
      const match = p && p.h === theme.h && p.spread === theme.spread && p.chroma === theme.chroma;
      b.setAttribute('aria-pressed', String(!!match));
    }
  }

  function buildPresets() {
    const wrap = $('presets');
    wrap.innerHTML = '';
    for (const p of PRESETS) {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.dataset.preset = p.id;
      const l = solveAccent(p.chroma, p.h + p.spread / 2).l * 100;
      b.style.setProperty('--sw-a', `oklch(${l}% ${p.chroma} ${p.h})`);
      b.style.setProperty('--sw-b', `oklch(${l + 4}% ${p.chroma} ${p.h + p.spread})`);
      b.innerHTML = '<span class="chip"></span><span class="nm">' + esc(p.name) + '</span>';
      b.addEventListener('click', () => {
        theme = { ...theme, h: p.h, spread: p.spread, chroma: p.chroma, tint: p.tint };
        applyTheme(true);
      });
      wrap.appendChild(b);
    }
  }

  function wireThemeControls() {
    const bind = (id, key, transform) => {
      $(id).addEventListener('input', (e) => {
        theme = { ...theme, [key]: transform(Number(e.target.value)) };
        applyTheme(true);
      });
    };
    bind('hue', 'h', (v) => v);
    bind('spread', 'spread', (v) => v);
    bind('chroma', 'chroma', (v) => v / 100);
    bind('glass', 'glass', (v) => v);
    for (const b of document.querySelectorAll('.backdrop-option')) {
      b.addEventListener('click', () => {
        const galaxy = b.dataset.galaxy;
        theme = galaxy === 'elysium' ? { ...theme, ...ELYSIUM_THEME, galaxy } : { ...theme, galaxy };
        applyTheme(true);
      });
    }

    const dialog = $('backdrop-dialog');
    const image = $('backdrop-dialog-image');
    const title = $('backdrop-dialog-title');
    for (const b of document.querySelectorAll('.backdrop-zoom')) {
      b.addEventListener('click', () => {
        image.src = b.dataset.src;
        image.alt = b.dataset.label + ' space backdrop';
        title.textContent = b.dataset.label;
        dialog.showModal();
      });
    }
    $('backdrop-dialog-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  // ══ the field's pulse ═════════════════════════════════════════════════
  // The gradients run at one fixed tempo in CSS; the only thing that moves is
  // how fast they *play*, and that tracks whether the Keeper is working. Idle
  // is a moderate wash. Working, it surges — in uneven bursts, because a smooth
  // ramp or a steady fast loop both read as a progress indicator, and the point
  // is for it to read as something alive and thinking.
  //
  // Speed is changed through playbackRate rather than by rewriting
  // animation-duration: an animation's progress is its elapsed time over its
  // duration, so re-timing one mid-flight teleports it to a different point in
  // the cycle and the whole field visibly jumps.
  const FIELD_IDLE = 1;
  let fieldRate = FIELD_IDLE;
  let fieldTarget = FIELD_IDLE;
  let burstTimer = null;
  let fieldFrame = null;

  // Read fresh each time — under prefers-reduced-motion the blooms have no
  // animations at all, so this correctly becomes a no-op with no extra check.
  // Filtering the document's animations rather than asking each bloom for its
  // own is what reliably catches the ::before half of the motion: a pseudo
  // element's animation reports the originating element as its target.
  const fieldAnims = () =>
    document.getAnimations().filter((a) => {
      const t = a.effect && a.effect.target;
      return t && t.classList && t.classList.contains('bloom');
    });

  function stepField() {
    fieldFrame = null;
    // Exponential approach: fast enough to feel like a surge, slow enough that
    // no single frame is a jolt.
    fieldRate += (fieldTarget - fieldRate) * 0.055;
    const settled = Math.abs(fieldTarget - fieldRate) < 0.01;
    if (settled) fieldRate = fieldTarget;
    for (const a of fieldAnims()) a.playbackRate = fieldRate;
    // Nothing to do between bursts — the animations hold whatever rate they
    // were left at, and the next nudge restarts the loop.
    if (!settled) fieldFrame = requestAnimationFrame(stepField);
  }

  function nudgeField(target) {
    fieldTarget = target;
    if (fieldFrame === null) fieldFrame = requestAnimationFrame(stepField);
  }

  function burst() {
    // Both the level and how long it holds are random, so consecutive bursts
    // never match. The range is wide on purpose: the swing between a 1.5× lull
    // and a 5.5× rush is the part that reads as thinking. A constant fast loop
    // would just read as a spinner.
    nudgeField(1.5 + Math.random() * 4);
    burstTimer = setTimeout(burst, 900 + Math.random() * 2400);
  }

  // A real step just happened — punch the field harder than any timed burst,
  // then hand straight back to the random cycle so it falls into a fresh level
  // instead of pinning at the ceiling.
  function kickField() {
    nudgeField(6.5);
    clearTimeout(burstTimer);
    burstTimer = setTimeout(burst, 700 + Math.random() * 700);
  }

  function pulseField(on) {
    clearTimeout(burstTimer);
    burstTimer = null;
    if (on) burst();
    else nudgeField(FIELD_IDLE);
  }

  // ══ stream rendering ══════════════════════════════════════════════════
  function addMessage(role, content, ts) {
    const turn = el('div', 'turn ' + role);
    // Only badge the first message of a run — repeating it every bubble is the
    // thing that makes chat UIs feel cluttered.
    if (role === 'agent' && lastRole !== 'agent') {
      const by = el('div', 'byline');
      by.innerHTML = '<span class="orb sm"><svg><use href="#i-sparkle"/></svg></span><span>keeper</span>';
      turn.appendChild(by);
    }
    turn.appendChild(el('div', 'msg ' + role, fmt(content)));

    const stamp = el('div', 'stamp');
    stamp.appendChild(el('span', null, esc(timeStr(ts))));
    // Whole-message copy, for the prompts and snippets that come back as prose
    // rather than inside a fence. Reveals on hover; always there on touch.
    if (role === 'agent' && String(content ?? '').trim()) {
      const btn = el('button', 'copybtn msg-copy',
        icon('copy', 12) + '<span class="cb-label">copy</span>');
      btn.type = 'button';
      btn.title = 'copy this message';
      btn.dataset.copy = content;
      stamp.appendChild(btn);
    }
    turn.appendChild(stamp);

    // The turn opens before the inbound message is logged, so a plain append
    // would leave "thinking…" sitting above the message that caused it. Your
    // own message belongs above the activity rail; the reply belongs below.
    const live = newestTurn();
    if (role === 'user' && live && live.el.parentNode === stream) {
      const stick = nearBottom();
      stream.insertBefore(turn, live.el);
      if (stick) stream.scrollTop = stream.scrollHeight;
    } else {
      append(turn);
    }
    lastRole = role;
    lastMsgAt = Math.max(lastMsgAt, Date.parse(ts) || 0);
    recentSaid.push(String(content ?? ''));
    if (recentSaid.length > 40) recentSaid.shift();
    if (role === 'agent') markSaid();
  }

  function setStatus(text) { $('statustext').textContent = text; }

  function activityIcon(tool) {
    if (/^(list|read|create|update)_drive_file/.test(tool)) {
      return '<span class="step-icon brand" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="#0F9D58" d="M8.2 3h5.1l7.7 13.3h-5.1z"/><path fill="#F4B400" d="M8.2 3 1 15.5l2.6 4.5 7.2-12.5z"/><path fill="#4285F4" d="M3.6 20h14.8l2.6-4.5H6.2z"/></svg></span>';
    }
    if (/email/.test(tool)) {
      return '<span class="step-icon brand" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="#EA4335" d="M3 5h18v14H3z"/><path fill="#fff" d="M5 8.1V17h3v-6.6l4 3 4-3V17h3V8.1l-7 5.2z"/><path fill="#C5221F" d="m3 6 9 6.8L21 6v3.4l-9 6.8-9-6.8z"/></svg></span>';
    }
    if (tool === 'generate_pdf') return '<span class="step-icon" aria-hidden="true">' + icon('doc', 13) + '</span>';
    if (tool === 'generate_image') return '<span class="step-icon" aria-hidden="true">' + icon('image', 13) + '</span>';

    const paths = /web_search|fetch_url|site|deploy/.test(tool)
      ? '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16"/>'
      : /history|fact|domain|portrait|journal|observation/.test(tool)
        ? '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4M8 11h6M11 8v6"/>'
        : '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>';
    return '<span class="step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg></span>';
  }

  function stepContents(label, tool) {
    return activityIcon(tool) + '<span class="step-label">' + esc(label) + '<span class="dots" aria-hidden="true"></span></span>';
  }

  // ── the activity rail ────────────────────────────────────────────────
  // One rail per turn, keyed by the turn id the server stamps on it. Turns can
  // overlap (a crew report landing mid-conversation), and a single global rail
  // used to orphan the first one, still "thinking" forever.
  const turns = new Map();
  let localTurnSeq = 0;
  // A step stays readable for at least this long. Tool calls often land within
  // a few ms of each other, and swapping on every one is a strobe, not a status.
  const STEP_HOLD = 700;
  // Don't show a clock on a reply that's about to land anyway.
  const SHOW_CLOCK_AFTER = 4000;
  // Turns he didn't start (reflection, reach-outs, crew reports) only leave a
  // trace if they actually said something — otherwise they were background
  // housekeeping and the transcript shouldn't fill up with "thought it over".
  const foreground = (source) => source === 'inbound:web' || source === 'inbound:telegram' || source === 'inbound';

  function sourceTag(source) {
    if (source === 'reflection') return 'reflecting';
    if (source === 'touchpoint') return 'reaching out';
    if (source === 'inbound:crew') return 'from the PC';
    return '';
  }

  const fmtSecs = (ms) => {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  };

  const newestTurn = () => [...turns.values()].pop() || null;

  function refreshBusy() {
    const t = newestTurn();
    const busy = !!t;
    if (busy !== root.classList.contains('busy')) {
      root.classList.toggle('busy', busy);
      pulseField(busy);
    }
    if (t) setStatus(t.shown ? t.shown.label : 'thinking');
    else setStatus(navigator.onLine ? 'here' : 'offline');
  }

  function beginTurn(source, id, startedAt) {
    id = id || 'local-' + (++localTurnSeq);
    if (turns.has(id)) return turns.get(id);
    const t = {
      id, source,
      // A reconnect can join a turn halfway; its clock starts when it did.
      startedAt: startedAt || Date.now(),
      steps: [],
      shown: null,
      want: null,
      lastSwap: 0,
      swapTimer: null,
      tick: null,
      said: false,
    };
    t.el = el('div', 'activity');
    t.el.setAttribute('role', 'status');
    const tag = sourceTag(source);
    if (tag) t.el.appendChild(el('span', 'tag', esc(tag)));
    t.pill = el('span', 'step live', stepContents('thinking', ''));
    t.clock = el('span', 'step-time');
    t.clock.setAttribute('aria-hidden', 'true');
    t.pill.appendChild(t.clock);
    t.el.appendChild(t.pill);
    turns.set(id, t);
    append(t.el);
    tickClock(t);
    t.tick = setInterval(() => tickClock(t), 1000);
    refreshBusy();
    return t;
  }

  function tickClock(t) {
    const ms = Date.now() - t.startedAt;
    t.clock.textContent = ms >= SHOW_CLOCK_AFTER ? fmtSecs(ms) : '';
  }

  function addStep(label, tool, turnId) {
    // PC chips carry no turn of their own, and one tagged with a turn that
    // already ended (a timer born inside it) belongs to whatever is live now —
    // a crew report first, if one is running, since that's what they're about.
    const crew = tool === 'pc_session' && [...turns.values()].reverse().find((x) => x.source === 'inbound:crew');
    const t = turns.get(turnId) || crew || newestTurn();
    if (!t) return;
    // Every real step kicks the field, so the surges line up with work actually
    // happening rather than only with a timer.
    kickField();
    t.steps.push({ label, tool });
    t.want = { label, tool };
    if (!t.swapTimer) t.swapTimer = setTimeout(() => swapStep(t), Math.max(0, t.lastSwap + STEP_HOLD - Date.now()));
  }

  function swapStep(t) {
    t.swapTimer = null;
    const next = t.want;
    if (!turns.has(t.id) || !next || (t.shown && t.shown.label === next.label && t.shown.tool === next.tool)) return;
    t.lastSwap = Date.now();
    const stick = nearBottom();
    t.pill.classList.add('swapping');
    setTimeout(() => {
      if (!turns.has(t.id)) return;
      t.pill.innerHTML = stepContents(next.label, next.tool);
      t.pill.appendChild(t.clock);
      t.pill.title = next.label;
      t.shown = next;
      t.pill.classList.remove('swapping');
      if (stick) stream.scrollTop = stream.scrollHeight;
      if (t === newestTurn()) setStatus(next.label);
      // Whatever arrived during the fade waits out its own hold, then shows.
      if (t.want !== next && !t.swapTimer) t.swapTimer = setTimeout(() => swapStep(t), STEP_HOLD);
    }, 160);
  }

  /** The finished rail: one quiet line, the full trail one tap away. */
  function traceOf(t) {
    // PC chips are "Name: whatever it's doing" — in the one-liner they're
    // just the session; the trail below keeps the detail.
    const short = (s) => (s.tool === 'pc_session' ? s.label.split(':')[0] + ' on the PC' : s.label);
    const uniq = [...new Set(t.steps.map(short))];
    const secs = fmtSecs(Date.now() - t.startedAt);
    if (!uniq.length) return el('span', 'summary', esc('thought it over · ' + secs));

    const head = uniq.slice(0, 2).join(' · ') + (uniq.length > 2 ? ' +' + (uniq.length - 2) : '');
    const trail = [];
    for (const s of t.steps) if (trail[trail.length - 1] !== s.label) trail.push(s.label);
    const d = el('details', 'trace');
    d.innerHTML =
      '<summary><span class="trace-what">' + esc(head) + '</span><span class="trace-time">' + esc(secs) + '</span></summary>' +
      '<ol>' + trail.slice(-40).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ol>';
    return d;
  }

  function endTurn(id, opts) {
    // An end with no id (an older server) closes the newest rail.
    const t = id ? turns.get(id) : newestTurn();
    if (!t) return;
    turns.delete(t.id);
    clearTimeout(t.swapTimer);
    clearInterval(t.tick);
    refreshBusy();

    const lost = opts && opts.lost;
    if (lost || (!t.said && !foreground(t.source))) {
      // Nothing worth keeping: let it go rather than leave a stale line behind.
      t.el.classList.add('leaving');
      setTimeout(() => t.el.remove(), 260);
      return;
    }
    t.el.classList.add('done');
    t.el.removeAttribute('role');
    t.pill.remove();
    t.el.appendChild(traceOf(t));
  }

  /** Something visible landed — every live turn has now said something. */
  function markSaid() {
    for (const t of turns.values()) t.said = true;
  }

  /**
   * The server's view of what's running, sent on every (re)connect. A rail it
   * doesn't know about ended while we weren't listening; a turn we don't have
   * started before this page did. The reply to a turn that ended out of
   * earshot was missed too, so pull it from history.
   */
  function syncTurns(list) {
    const live = new Map((Array.isArray(list) ? list : []).map((s) => [s.id, s]));
    let missed = false;
    for (const t of [...turns.values()]) {
      if (!live.has(t.id)) { endTurn(t.id, { lost: true }); missed = true; }
      else if (!t.el.isConnected) append(t.el); // the stream was re-rendered under it
    }
    for (const s of live.values()) {
      if (turns.has(s.id)) continue;
      beginTurn(s.source, s.id, s.startedAt);
      if (s.label) addStep(s.label, s.tool, s.id);
    }
    if (missed) void catchUp();
  }

  async function catchUp() {
    try {
      const snap = await snapshot();
      const fresh = (snap.history || []).filter((h) => h.ts && Date.parse(h.ts) > lastMsgAt);
      for (const h of fresh) if (!recentSaid.includes(String(h.content ?? ''))) addMessage(h.role === 'user' ? 'user' : 'agent', h.content, h.ts);
    } catch {}
  }

  // ── generative cards (the `present` tool) ─────────────────────────────
  const blockRenderers = {
    stat(b) {
      const d = b.delta
        ? '<span class="delta ' + (String(b.delta).trim().startsWith('-') ? 'down' : 'up') + '">' + esc(b.delta) + '</span>'
        : '';
      return '<div class="b-stat"><div class="label">' + esc(b.label) + '</div>' +
        '<div class="value">' + esc(b.value) + d + '</div>' +
        (b.hint ? '<div class="hint">' + esc(b.hint) + '</div>' : '') + '</div>';
    },
    keyvals(b) {
      const rows = (Array.isArray(b.pairs) ? b.pairs : []).map((p) =>
        '<div class="kv"><span class="k">' + esc(p.k) + '</span><span class="v">' + esc(p.v) + '</span></div>').join('');
      return '<div class="b-keyvals">' + rows + '</div>';
    },
    list(b) {
      // The strikethrough sits on .txt alone: text-decoration propagates to
      // descendants and can't be switched off further down, so putting it on
      // the item would score out the sub-text and the bullet too.
      const items = (Array.isArray(b.items) ? b.items : []).map((i) =>
        '<div class="item' + (i.done ? ' done' : '') + '"><span class="bullet">' + (i.done ? '✓' : '●') + '</span>' +
        '<span class="body"><span class="txt">' + esc(i.text) + '</span>' +
        (i.sub ? '<span class="sub">' + esc(i.sub) + '</span>' : '') + '</span></div>').join('');
      return '<div class="b-list">' + (b.title ? '<div class="lt">' + esc(b.title) + '</div>' : '') + items + '</div>';
    },
    timeline(b) {
      const items = (Array.isArray(b.items) ? b.items : []).map((i) =>
        '<div class="item"><div class="when">' + esc(i.when) + '</div><div>' + esc(i.text) + '</div></div>').join('');
      return '<div class="b-timeline">' + items + '</div>';
    },
    progress(b) {
      const v = Math.max(0, Math.min(100, Number(b.value) || 0));
      return '<div class="b-progress"><div class="label"><span>' + esc(b.label) + '</span><span>' + v + '%</span></div>' +
        '<div class="track"><div class="fill" data-w="' + v + '"></div></div>' +
        (b.hint ? '<div class="hint">' + esc(b.hint) + '</div>' : '') + '</div>';
    },
    spark(b) {
      const pts = (Array.isArray(b.points) ? b.points : []).map(Number).filter((n) => isFinite(n));
      if (pts.length < 2) return '';
      const W = 240, H = 40, P = 3;
      const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
      const xy = pts.map((v, i) => {
        const x = P + (i / (pts.length - 1)) * (W - 2 * P);
        const y = H - P - ((v - min) / span) * (H - 2 * P);
        return x.toFixed(1) + ',' + y.toFixed(1);
      });
      const last = pts[pts.length - 1];
      const lastLabel = (Math.abs(last) >= 1000 ? last.toLocaleString() : String(Math.round(last * 100) / 100)) +
        (b.unit ? ' ' + esc(b.unit) : '');
      return '<div class="b-spark"><div class="label"><span>' + esc(b.label) + '</span><span class="last">' + lastLabel + '</span></div>' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<polygon class="area" points="' + P + ',' + (H - P) + ' ' + xy.join(' ') + ' ' + (W - P) + ',' + (H - P) + '"/>' +
        '<polyline points="' + xy.join(' ') + '"/></svg></div>';
    },
    links(b) {
      const items = (Array.isArray(b.items) ? b.items : []).map((i) => {
        const url = /^https?:\/\//i.test(String(i.url ?? '')) ? i.url : '#';
        return '<a class="link" href="' + esc(url) + '" target="_blank" rel="noopener"><div class="lt">' + esc(i.title) + '</div>' +
          (i.desc ? '<div class="ld">' + esc(i.desc) + '</div>' : '') + '</a>';
      }).join('');
      return '<div class="b-links">' + items + '</div>';
    },
    quote(b) {
      return '<div class="b-quote">' + esc(b.text) + (b.by ? '<span class="by">— ' + esc(b.by) + '</span>' : '') + '</div>';
    },
    text(b) { return '<div class="b-text">' + fmt(b.body) + '</div>'; },
  };

  function addCard(card) {
    const wrap = el('div', 'card');
    if (card.title) wrap.appendChild(el('div', 'c-title', esc(card.title)));
    const blocks = Array.isArray(card.blocks) ? card.blocks : [];
    blocks.forEach((b, i) => {
      const render = blockRenderers[b && b.type];
      if (!render) return;
      const holder = el('div');
      try { holder.innerHTML = render(b); } catch { return; }
      const inner = holder.firstChild;
      if (!inner) return;
      // Staggered reveal — the card assembles itself rather than snapping in.
      inner.style.animationDelay = (0.1 + i * 0.07) + 's';
      wrap.appendChild(inner);
    });
    if (wrap.children.length === 0) return;
    append(wrap);
    requestAnimationFrame(() =>
      wrap.querySelectorAll('.fill').forEach((f) => { f.style.width = f.dataset.w + '%'; }));
    lastRole = null;
  }

  /** Generated media arrives as a URL into the server's file store. */
  function mediaSrc(m) {
    const url = m.url || m.dataUrl || '';
    // Anchors and <img> can't send an Authorization header, so the token rides
    // as a query param — the same concession /events already makes.
    if (url.startsWith('/') && token) return url + '?t=' + encodeURIComponent(token);
    return url;
  }

  const humanSize = (n) =>
    !n ? '' : n < 1024 ? n + ' B'
      : n < 1024 * 1024 ? (n / 1024).toFixed(0) + ' KB'
      : (n / (1024 * 1024)).toFixed(1) + ' MB';

  function addMedia(m) {
    if (m.kind === 'photo') {
      const img = el('img', 'media-img');
      img.src = mediaSrc(m);
      img.alt = 'generated image';
      append(img);
      lastRole = null;
      return;
    }

    const name = m.filename || 'document';
    const row = el('div', 'media-row');

    const a = el('a', 'media-doc',
      '<span class="md-icon">' + icon('doc', 17) + '</span>' +
      '<span class="md-meta"><span class="md-name">' + esc(name) + '</span>' +
      '<span class="md-sub">' + esc([humanSize(m.bytes), 'download'].filter(Boolean).join(' · ')) + '</span></span>' +
      '<span class="md-dl">' + icon('download', 16) + '</span>');
    a.href = mediaSrc(m);
    a.download = name;
    row.appendChild(a);

    // Text-ish files are usually wanted in the clipboard, not on disk — a
    // generated .md is as often pasted somewhere as it is saved. The contents
    // are pulled in now rather than on click: Safari only honours a clipboard
    // write in the same task as the gesture, so fetching first and copying
    // after would work on desktop and silently fail on his phone.
    if (/\.(md|markdown|txt|json|ya?ml|csv)$/i.test(name)) {
      const btn = el('button', 'copybtn media-copy',
        icon('copy', 13) + '<span class="cb-label">copy</span>');
      btn.type = 'button';
      btn.disabled = true;
      row.appendChild(btn);
      fetch(a.href)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('gone'))))
        .then((text) => { btn.dataset.copy = text; btn.disabled = false; })
        .catch(() => btn.remove());
    }

    append(row);
    lastRole = null;
  }

  /**
   * One delegated handler for every copy button in the stream — fenced blocks
   * carry their text inline, generated files fetch theirs back from the store.
   */
  stream.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.copybtn');
    if (!btn) return;
    e.preventDefault();

    const flash = (ok) => {
      const label = btn.querySelector('.cb-label');
      const was = label ? label.textContent : '';
      btn.classList.add(ok ? 'copied' : 'failed');
      if (label) label.textContent = ok ? 'copied' : 'failed';
      setTimeout(() => {
        btn.classList.remove('copied', 'failed');
        if (label) label.textContent = was;
      }, 1400);
    };

    copyText(btn.dataset.copy || '').then(flash);
  });

  // ══ events ════════════════════════════════════════════════════════════
  function handleEvent(ev) {
    if (ev.type === 'turn') { ev.phase === 'start' ? beginTurn(ev.source, ev.id, ev.startedAt) : endTurn(ev.id); return; }
    if (ev.type === 'step') { addStep(ev.label, ev.tool, ev.turn); return; }
    if (ev.type === 'sync') { syncTurns(ev.turns); return; }
    if (ev.type === 'message') { addMessage(ev.role, ev.content, ev.ts); return; }
    if (ev.type === 'card') { markSaid(); addCard(ev.card); return; }
    if (ev.type === 'media') { markSaid(); addMedia(ev); return; }
  }

  let esStarted = false;

  function connect() {
    if (es) es.close();
    es = new EventSource('/events?t=' + encodeURIComponent(token));
    esStarted = true;
    es.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch {} };
    es.onerror = () => {
      if (!root.classList.contains('busy')) setStatus('reconnecting…');
      markUnreachable();
      // EventSource can't see status codes, so a rotated token looks exactly
      // like an outage and the app sits "offline" forever. Ask the server.
      fetch('/api/snapshot', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
        .then((res) => {
          if (res.status !== 401) return;
          es.close();
          clearTimeout(unreachableTimer);
          localStorage.removeItem('keeper_token');
          token = '';
          showGate('that token didn’t open it');
        })
        .catch(() => {});
    };
    es.onopen = () => {
      clearTimeout(unreachableTimer);
      setOnline(true);
    };
  }

  // ══ connectivity ══════════════════════════════════════════════════════
  /**
   * navigator.onLine is not enough on its own: it reports whether there's a
   * network interface, not whether the Keeper is actually reachable. Losing the
   * server while still on wifi is the common case (a Railway redeploy), and the
   * app would happily claim to be "here". The live SSE stream is the real
   * signal, so it drives this too.
   */
  function setOnline(online) {
    root.classList.toggle('offline', !online);
    $('offlinebar').classList.toggle('hidden', online);
    $('sendbtn').disabled = !online;
    $('attachbtn').disabled = !online;
    if (!root.dataset.dictation || root.dataset.dictation === 'idle') $('micbtn').disabled = !online;
    if (!root.classList.contains('busy')) setStatus(online ? 'here' : 'offline');
  }

  let unreachableTimer = null;
  function markUnreachable() {
    // EventSource reconnects by itself, so a single blip shouldn't grey out the
    // composer — only a sustained outage should.
    clearTimeout(unreachableTimer);
    unreachableTimer = setTimeout(() => setOnline(false), 4000);
  }

  window.addEventListener('online', () => {
    setOnline(true);
    // EventSource retries on its own once a stream has been opened; this only
    // covers the case where the app booted with no connection at all.
    if (token && !esStarted) connect();
  });
  window.addEventListener('offline', () => {
    clearTimeout(unreachableTimer);
    setOnline(false);
  });

  // ══ boot / auth ═══════════════════════════════════════════════════════
  let staleSince = null;

  async function snapshot() {
    const res = await fetch('/api/snapshot', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) {
      const err = new Error('unauthorized');
      err.unauthorized = true;
      throw err;
    }
    if (!res.ok) throw new Error(String(res.status));
    // Set by the service worker when it fell back to the last cached copy.
    staleSince = res.headers.get('X-Keeper-Stale') ? res.headers.get('X-Keeper-Cached-At') : null;
    return res.json();
  }

  function renderHistory(history) {
    stream.innerHTML = '';
    lastRole = null;
    lastMsgAt = 0;
    recentSaid.length = 0;
    for (const h of history) addMessage(h.role === 'user' ? 'user' : 'agent', h.content, h.ts);
    stream.scrollTop = stream.scrollHeight;
  }

  function showGate(message) {
    $('gate').classList.remove('hidden');
    $('app').classList.add('hidden');
    $('gateerr').textContent = message || '';
  }

  async function enter() {
    let snap;
    try {
      snap = await snapshot();
    } catch (err) {
      // Only a real rejection invalidates the token. Losing it because you
      // opened the app on a plane — with no way to type it back in — would be
      // the worst possible failure mode for an offline-capable app.
      if (err && err.unauthorized) {
        const hadToken = !!token;
        localStorage.removeItem('keeper_token');
        token = '';
        showGate(hadToken ? 'that token didn’t open it' : '');
        return;
      }
      if (!token) {
        showGate('');
        return;
      }
      $('gate').classList.add('hidden');
      $('app').classList.remove('hidden');
      setOnline(false);
      toast('can’t reach it right now — nothing cached to show yet');
      return;
    }
    localStorage.setItem('keeper_token', token);
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderHistory(snap.history || []);
    if (staleSince) {
      // The service worker fell back to its cached copy, which is proof the
      // server is unreachable regardless of what navigator.onLine claims.
      setOnline(false);
      toast('offline — showing what it knew at ' + timeStr(staleSince));
    } else {
      setOnline(navigator.onLine);
      connect();
      void syncPush();
    }
    pcTick();
    const view = new URLSearchParams(location.search).get('view');
    if (view === 'mind' || view === 'pc') openSheet(view);
  }

  $('gateform').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('tokeninput').value.trim();
    if (token) enter();
  });

  // ══ composer ══════════════════════════════════════════════════════════
  const box = $('box');
  const sendbtn = $('sendbtn');

  function autosize() {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 148) + 'px';
  }
  box.addEventListener('input', autosize);

  const MAX_FILE = 18 * 1024 * 1024; // keep under the server's 20MB body cap
  let pending = [];

  function renderChips() {
    const wrap = $('attachments');
    wrap.innerHTML = '';
    pending.forEach((f, i) => {
      const isPdf = f.mime === 'application/pdf' || /\.pdf$/i.test(f.name || '');
      const chip = el('div', 'att');
      chip.innerHTML = icon(isPdf ? 'doc' : 'image', 15) +
        '<span class="nm"></span><button class="x" aria-label="remove">' + '&times;' + '</button>';
      chip.querySelector('.nm').textContent = f.name || (isPdf ? 'document.pdf' : 'image');
      chip.querySelector('.x').addEventListener('click', () => { pending.splice(i, 1); renderChips(); });
      wrap.appendChild(chip);
    });
  }

  function addFiles(fileList) {
    for (const file of fileList) {
      const okType = file.type.startsWith('image/') || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!okType) { toast('only images and PDFs'); continue; }
      if (file.size > MAX_FILE) { toast((file.name || 'that file') + ' is too big (max 18MB)'); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        pending.push({ name: file.name, mime: file.type || 'application/pdf', data: String(reader.result).split(',')[1] || '' });
        renderChips();
      };
      reader.readAsDataURL(file);
    }
  }

  $('attachbtn').addEventListener('click', () => $('fileinput').click());
  $('fileinput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth) root.classList.add('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; root.classList.remove('dragging'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    root.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) addFiles(files);
  });

  let sending = false;
  async function send() {
    if (sending) return;
    const text = box.value.trim();
    if (!text && pending.length === 0) return;
    if (!navigator.onLine) { toast('still offline — it didn’t get that'); return; }
    const files = pending;
    sending = true;
    let delivered = false;
    box.value = '';
    autosize();
    pending = [];
    renderChips();
    sendbtn.disabled = true;
    try {
      const res = await fetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ text, files, workstreamId }),
      });
      delivered = res.ok;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) { token = ''; enter(); }
        else toast(data.error || 'that didn’t go through');
      }
    } catch {
      toast('no connection — it didn’t get that');
    } finally {
      if (!delivered) {
        box.value = text + (box.value ? '\n' + box.value : '');
        pending = [...files, ...pending];
        renderChips();
        autosize();
      }
      sending = false;
      sendbtn.disabled = !navigator.onLine;
      box.focus();
    }
  }

  sendbtn.addEventListener('click', send);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  // ── dictation ─────────────────────────────────────────────────────────
  // Tap to record, tap to stop. The audio goes to /api/dictate (the server
  // holds the OpenAI key) and the words land in the box at the caret — never
  // sent on their own, so he can fix what it misheard first.
  //
  // iPhone Safari is the target: the mic is only asked for inside the tap,
  // tracks are released the moment recording stops (or the orange dot stays
  // on), and a page sent to the background stops and keeps what it heard.
  const micbtn = $('micbtn');
  const dictstatus = $('dictstatus');
  const DICT_MAX_MS = 5 * 60 * 1000;
  const DICT_MIN_MS = 600;
  const dict = { state: 'idle', rec: null, stream: null, chunks: [], startedAt: 0, timer: null, caret: null };

  const canDictate = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  micbtn.classList.toggle('hidden', !canDictate);

  /** Whatever this browser records natively; Safari only does mp4. */
  function recorderMime() {
    for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) {
      if (MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return '';
  }

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  function setDict(state, text) {
    dict.state = state;
    root.dataset.dictation = state;
    const on = state !== 'idle';
    dictstatus.classList.toggle('hidden', !on);
    $('composer-hint').classList.toggle('hidden', on);
    dictstatus.querySelector('.txt').textContent = text || '';
    dictstatus.querySelector('.cancel').classList.toggle('hidden', state !== 'recording');
    micbtn.setAttribute('aria-pressed', String(state === 'recording'));
    const label = state === 'recording' ? 'stop and transcribe' : state === 'transcribing' ? 'transcribing' : 'dictate';
    micbtn.title = label;
    micbtn.setAttribute('aria-label', label);
    micbtn.querySelector('use').setAttribute('href', state === 'recording' ? '#i-stop' : '#i-mic');
    micbtn.disabled = state === 'transcribing' || !navigator.onLine;
  }

  function releaseMic() {
    clearInterval(dict.timer);
    dict.timer = null;
    dict.stream?.getTracks().forEach((t) => t.stop());
    dict.stream = null;
  }

  function dictError(msg) {
    releaseMic();
    dict.rec = null;
    setDict('idle');
    toast(msg);
  }

  async function startDictation() {
    if (!navigator.onLine) { toast('offline — dictation needs a connection'); return; }
    // Where the words go: the caret as it is now, not wherever focus wanders.
    dict.caret = document.activeElement === box ? [box.selectionStart, box.selectionEnd] : null;
    setDict('starting', 'waiting for the microphone…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const name = err?.name || '';
      dictError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'microphone blocked — allow it for this site (iPhone: Settings › Safari › Microphone)'
          : name === 'NotFoundError' ? 'no microphone found'
          : name === 'NotReadableError' ? 'the microphone is busy in another app'
          : 'couldn’t start the microphone'
      );
      return;
    }
    // Cancelled while the permission prompt was up.
    if (dict.state !== 'starting') { stream.getTracks().forEach((t) => t.stop()); return; }

    let rec;
    try {
      const mime = recorderMime();
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      dictError('this browser can’t record audio');
      return;
    }
    dict.stream = stream;
    dict.rec = rec;
    dict.chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) dict.chunks.push(e.data); };
    rec.onstop = () => finishDictation(rec);
    rec.onerror = () => dictError('recording failed');
    // A timeslice, because some iOS versions hand back nothing for a single
    // end-of-recording chunk.
    rec.start(1000);
    dict.startedAt = Date.now();
    const tick = () => {
      const ms = Date.now() - dict.startedAt;
      if (ms >= DICT_MAX_MS) { toast('that’s the 5-minute limit — transcribing what you said'); stopDictation(); return; }
      dictstatus.querySelector('.txt').textContent = 'recording ' + clock(ms) + ' — tap the stop button when done';
    };
    setDict('recording');
    tick();
    dict.timer = setInterval(tick, 500);
  }

  function stopDictation(cancel = false) {
    if (dict.state === 'starting') { setDict('idle'); return; }
    if (dict.state !== 'recording' || !dict.rec) return;
    const rec = dict.rec;
    if (cancel) {
      // Detach first, so the stop event that follows finds nothing to send.
      dict.rec = null;
      dict.chunks = [];
      releaseMic();
      setDict('idle');
      try { rec.stop(); } catch { /* already stopped */ }
      return;
    }
    clearInterval(dict.timer);
    dict.timer = null;
    setDict('transcribing', 'transcribing…');
    try { rec.stop(); } catch { finishDictation(rec); }
  }

  async function finishDictation(rec) {
    if (dict.rec !== rec) return;
    const elapsed = Date.now() - dict.startedAt;
    const type = (rec.mimeType || dict.chunks[0]?.type || 'audio/mp4').split(';')[0];
    const blob = new Blob(dict.chunks, { type });
    dict.chunks = [];
    dict.rec = null;
    releaseMic();
    if (elapsed < DICT_MIN_MS || blob.size === 0) { dictError('too short — tap, speak, then tap stop'); return; }

    setDict('transcribing', 'transcribing…');
    try {
      const res = await fetch('/api/dictate', {
        method: 'POST',
        headers: { 'Content-Type': type, Authorization: 'Bearer ' + token },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { setDict('idle'); token = ''; enter(); return; }
      if (!res.ok || !data.text) { dictError(data.error || 'transcription failed'); return; }
      insertTranscript(data.text);
      setDict('idle');
    } catch {
      dictError('no connection — the recording didn’t reach it');
    }
  }

  /** Into the box at the remembered caret, with a space either side as needed. */
  function insertTranscript(text) {
    const v = box.value;
    const [a, b] = dict.caret && dict.caret[0] <= v.length ? dict.caret : [v.length, v.length];
    const before = v.slice(0, a);
    const after = v.slice(Math.min(b, v.length));
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    box.value = before + lead + text + trail + after;
    const pos = (before + lead + text).length;
    autosize();
    box.focus();
    box.setSelectionRange(pos, pos);
  }

  micbtn.addEventListener('click', () => {
    if (dict.state === 'idle') startDictation();
    else if (dict.state === 'recording' || dict.state === 'starting') stopDictation();
  });
  dictstatus.querySelector('.cancel').addEventListener('click', () => stopDictation(true));
  // iOS cuts the mic when the page goes to the background; keep what was said.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dict.state === 'recording') stopDictation();
  });

  // ── jump to latest ────────────────────────────────────────────────────
  stream.addEventListener('scroll', () => {
    $('jumpbtn').classList.toggle('away', nearBottom());
  });
  $('jumpbtn').addEventListener('click', () => {
    stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
  });

  // ══ sheets ════════════════════════════════════════════════════════════
  let sheetOpener = null;
  function openSheet(which) {
    closeSheets();
    sheetOpener = document.activeElement;
    $(which).inert = false;
    $(which).classList.add('open');
    $(which).setAttribute('aria-hidden', 'false');
    $(which + 'btn').setAttribute('aria-expanded', 'true');
    $(which).querySelector('[data-close]').focus();
    $('app').inert = true;
    $('scrim').classList.add('show');
    if (which === 'mind') loadMind();
    if (which === 'pc') pcTick();
    if (which === 'settings') {
      void refreshNotif();
      if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistration().then(reportCacheState).catch(() => {});
      }
    }
  }

  function closeSheets() {
    $('app').inert = false;
    for (const id of ['pc', 'mind', 'settings']) {
      $(id).classList.remove('open');
      $(id).setAttribute('aria-hidden', 'true');
      $(id).inert = true;
      $(id + 'btn').setAttribute('aria-expanded', 'false');
    }
    $('scrim').classList.remove('show');
    if (sheetOpener?.isConnected) sheetOpener.focus();
    sheetOpener = null;
  }

  document.addEventListener('keydown', (e) => {
    const sheet = document.querySelector('.sheet.open');
    if (!sheet || e.key !== 'Tab' || document.querySelector('dialog[open]')) return;
    const controls = [...sheet.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
      .filter((el) => !el.disabled && el.getClientRects().length && !el.closest('[inert]'));
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });

  $('pcbtn').addEventListener('click', () => openSheet('pc'));
  $('mindbtn').addEventListener('click', () => openSheet('mind'));
  $('settingsbtn').addEventListener('click', () => openSheet('settings'));
  $('scrim').addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) closeSheets();
  });

  function renderMind(snap) {
    const pri = (p) => '●'.repeat(Math.max(1, 6 - (p || 3))).padEnd(5, '○');
    const sectors = (snap.domains || []).map((d) =>
      '<div class="sector"><span class="pri">' + pri(d.priority) + '</span><span>' + esc(d.name) +
      (d.description ? '<span class="desc">' + esc(d.description) + '</span>' : '') + '</span></div>').join('');
    const facts = (snap.facts || []).map((f) =>
      '<div class="fact"><span class="fd">' + esc(String(f.domain).toUpperCase()) + '</span><span class="fk">' + esc(f.key) + ':</span> ' + esc(f.value) + '</div>').join('');
    const goalRows = (snap.goals || []).length
      ? snap.goals.map((g) =>
        '<div class="fact"><span class="fk">' + esc(g.title) + '</span>' +
        (g.target != null ? ' → ' + esc(String(g.target)) + (g.unit ? ' ' + esc(g.unit) : '') : '') +
        (g.deadline ? ' <span class="muted">by ' + esc(g.deadline) + '</span>' : '') + '</div>').join('')
      : '<div class="fact muted">none yet — tell it what you’re aiming at</div>';
    const nums = (snap.metrics || []).length
      ? snap.metrics.map((m) =>
        '<div class="fact"><span class="fk">' + esc(m.metric) + ':</span> ' + esc(String(m.value)) +
        (m.unit ? ' ' + esc(m.unit) : '') +
        ' <span class="muted">(' + esc(String(m.at).slice(0, 10)) + ')</span></div>').join('')
      : '<div class="fact muted">no numbers logged yet — it catches them as they pass by</div>';
    const tps = (snap.touchpoints || []).length
      ? snap.touchpoints.map((t) =>
        '<div class="tp"><div class="when">' + esc(new Date(t.fireAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })) +
        (t.recurrence ? ' ↻ ' + esc(t.recurrence) : '') + '</div>' + esc(t.reason) + '</div>').join('')
      : '<div class="tp muted">nothing planned — it’s giving you space</div>';
    const j = snap.journal
      ? '<div class="journal-entry"><span class="day">' + esc(snap.journal.day) + '</span>' + esc(snap.journal.entry) + '</div>'
      : '<div class="journal-entry">no entries yet — it reflects nightly at 22:00</div>';
    const spend = typeof snap.spendTodayUsd === 'number'
      ? '<div class="fact muted">api spend today ≈ $' + snap.spendTodayUsd.toFixed(2) + '</div>'
      : '';
    const stale = staleSince
      ? '<div class="stale-note">' + icon('offline', 15) + '<span>offline — this is what it knew at ' + esc(timeStr(staleSince)) + '</span></div>'
      : '';

    $('mindbody').innerHTML = stale +
      '<section><h3>sectors of your life</h3>' + sectors + '</section>' +
      '<section><h3>your goals</h3>' + goalRows + '</section>' +
      '<section><h3>the numbers</h3>' + nums + '</section>' +
      '<section><h3>what it knows</h3>' + facts + '</section>' +
      '<section><h3>planned reach-outs</h3>' + tps + '</section>' +
      '<section><h3>last journal entry</h3>' + j + spend + '</section>';
  }

  async function loadMind() {
    try { renderMind(await snapshot()); }
    catch { $('mindbody').textContent = 'couldn’t read its mind just now'; }
  }

  // ══ PC sessions ═══════════════════════════════════════════════════════
  // Renders what src/web/pcBridge.ts reports. `phase` is decided server-side;
  // this only words it. Approve/Deny buttons act on a tap and nothing else.
  const PC_STATE = {
    queued: ['queued', ''], idle: ['ready for next task', 'ok'], running: ['running', 'run'], waiting: ['needs your OK', 'bad'],
    done: ['done', 'ok'], failed: ['failed', 'bad'], timed_out: ['timed out', 'bad'],
    not_picked_up: ['PC didn’t answer', 'bad'], lost: ['lost contact', 'bad'], stopped: ['stopped', ''],
  };
  let pcData = null;
  let pcTimer = null;

  const pcAgo = (ts) => {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  };
  const pcLast = (j) => {
    const e = [...(j.recent || [])].reverse().find((x) => (x.kind === 'step' || x.kind === 'text') && x.text);
    return e ? e.text : '';
  };
  const pcEnd = (j) => {
    const e = [...(j.recent || [])].reverse().find((x) => x.kind === 'error' && x.text);
    return e ? e.text : '';
  };

  // The body of a card: what happened, why, and what you can do about it.
  function pcJobBody(j, approvals, limits) {
    const phase = j.phase || j.status;
    const mine = approvals.filter((a) => a.jobId === j.id);
    const live = phase === 'queued' || phase === 'running' || phase === 'waiting';
    let body = '';
    if (phase === 'queued') {
      body = '<div class="why">Waiting for the PC to pick this up. If it is off or asleep, this gives up after ' +
        esc(String((limits && limits.queueMin) || 10)) + ' minutes and tells you nothing was done.</div>';
    } else if (phase === 'running') {
      const s = pcLast(j);
      body = s ? '<div class="why live">' + esc(s) + '</div>' : '<div class="why">Started — no update yet.</div>';
    } else if (phase === 'waiting') {
      body = '<div class="why">Paused until you answer. Nothing continues on its own' +
        (mine.length ? '.' : ' — the question will appear here once the PC repeats it.') + '</div>';
    } else if (phase === 'done' || phase === 'idle') {
      body = '<div class="result">' + esc(j.result || 'Finished, but it sent no summary.') + '</div>';
      if (j.shotUrl) {
        body += '<img class="shot" loading="lazy" alt="' + esc(j.shotCaption || 'screen when it finished') + '" src="' +
          esc(mediaSrc({ url: j.shotUrl })) + '" data-pc-shot>';
      } else if (j.shotMissing) {
        body += '<div class="noshot">No screenshot: the PC couldn’t capture its screen, which usually means it is locked or the display is off. The summary above is still the real result.</div>';
      }
    } else if (phase === 'timed_out') {
      body = '<div class="why bad">Ran past the ' + esc(String((limits && limits.maxRunMin) || 120)) + '-minute limit and was stopped before it finished.</div>';
    } else if (phase === 'not_picked_up') {
      body = '<div class="why bad">The PC never took this. It is off, asleep, or the PC agent isn’t running. Nothing was done — ask again once it is on.</div>';
    } else if (phase === 'lost') {
      body = '<div class="why bad">The PC stopped reporting, so this may not have finished. If it comes back with a result, it appears here.</div>';
    } else if (phase === 'stopped') {
      body = '<div class="why">Stopped before it finished.</div>';
    } else {
      body = '<div class="why bad">' + esc(pcEnd(j) || 'It failed without saying why.') + '</div>';
    }
    if ((phase === 'timed_out' || phase === 'lost') && pcLast(j)) {
      body += '<div class="meta">Last thing it reported: ' + esc(pcLast(j)) + '</div>';
    }
    // A persistent session waits here for its next task; a one-task session never shows this.
    if (phase === 'idle') {
      body += '<div class="pc-follow"><input type="text" maxlength="2000" placeholder="Next task for this session…" aria-label="Follow-up for session ' +
        esc(j.id) + '" data-pc-draft="' + esc(j.id) + '"><button class="btn primary" data-pc-send="' + esc(j.id) + '">Send</button></div>';
    }
    body += mine.map((a) =>
      '<div class="pc-approve"><strong>Wants your OK</strong><span>' + esc(a.summary) + '</span>' +
      '<div class="row"><button class="btn primary" data-pc-allow="' + esc(a.id) + '">Approve</button>' +
      '<button class="btn" data-pc-deny="' + esc(a.id) + '">Deny</button></div></div>').join('');
    const cost = typeof j.costUsd === 'number' && (phase === 'done' || phase === 'idle') ? ' · $' + j.costUsd.toFixed(2) : '';
    body += '<div class="pc-foot"><span class="meta">' + esc(pcAgo(j.updatedAt)) + cost + ' · ' + esc(j.id) + '</span>' +
      (live ? '<button class="btn stop" data-pc-stop="' + esc(j.id) + '">Stop</button>' : '') +
      (phase === 'idle' ? '<button class="btn stop" data-pc-stop="' + esc(j.id) + '">End session</button>' : '') +
      // Lost may still come back with the PC (a lost Prime holds its slot); letting go stops it if it does.
      (phase === 'lost' ? '<button class="btn stop" data-pc-stop="' + esc(j.id) + '">Let go</button>' : '') + '</div>';
    return body;
  }

  function pcWho(j) {
    const sub = [j.role === 'worker' ? 'Prime’s crew' : j.role === 'prime' ? 'chief of staff' : '', j.project, j.engine === 'codex' ? 'Codex' : 'Claude']
      .filter(Boolean).join(' · ');
    return '<span class="proj">' + esc(j.name || j.project) + '<span class="sub">' + esc(sub) + '</span></span>';
  }

  function pcStateTag(j) {
    const phase = j.phase || j.status;
    const [label, tone] = PC_STATE[phase] || [phase, ''];
    return '<span class="pc-state ' + tone + '">' + esc(label) + '</span>';
  }

  function pcJobCard(j, approvals, limits) {
    const attn = approvals.some((a) => a.jobId === j.id);
    return '<article class="pc-job' + (attn ? ' attn' : '') + '" id="pcjob-' + esc(j.id) + '"><div class="top">' + pcWho(j) + pcStateTag(j) + '</div>' +
      '<div class="task">' + esc(j.task) + '</div>' + pcJobBody(j, approvals, limits) + '</article>';
  }

  // A finished session, folded to one line until it is opened.
  function pcHistoryRow(j, approvals, limits) {
    return '<details class="pc-hist" data-pc-hist="' + esc(j.id) + '" id="pcjob-' + esc(j.id) + '"><summary>' +
      '<span class="hist-main"><b>' + esc(j.name || j.project) + '</b><span>' + esc(j.brief || j.task || '') + '</span></span>' +
      '<span class="hist-side">' + pcStateTag(j) + '<span class="when">' + esc(pcAgo(j.updatedAt)) + '</span></span></summary>' +
      '<div class="hist-body"><div class="hist-sub">' + pcWho(j) + '</div><div class="task">' + esc(j.task) + '</div>' +
      pcJobBody(j, approvals, limits) + '</div></details>';
  }

  // Start from here: a Meeseeks (one job, then gone) on a project, or a goal for Meeseeks Prime.
  // Built once and never re-rendered by the refresh — a rebuilt <select> closes the
  // picker under his thumb, which is the bug this replaced.
  function pcStartForm() {
    const chevron = '<svg width="14" height="14" aria-hidden="true"><use href="#i-chevron-down"/></svg>';
    return '<form class="pc-start" data-pc-start novalidate>' +
      '<div class="seg" role="radiogroup" aria-label="Who should do it">' +
      '<label><input type="radio" name="pc-mode" value="meeseeks" data-pc-mode checked><span><b>Meeseeks</b><small>one job, then gone</small></span></label>' +
      '<label><input type="radio" name="pc-mode" value="prime" data-pc-mode><span><b>Meeseeks Prime</b><small>chief of staff, runs a crew<span data-pc-prime-slots></span></small></span></label></div>' +
      '<div class="pc-full" data-pc-prime-full role="status" hidden></div>' +
      '<div class="row" data-pc-solo>' +
      '<label class="pc-field"><span>Project</span><span class="select"><select data-pc-project></select>' + chevron + '</span></label>' +
      '<label class="pc-field"><span>Engine</span><span class="select"><select data-pc-engine><option value="claude">Claude</option><option value="codex">Codex (desktop)</option></select>' +
      chevron + '</span></label></div>' +
      '<div class="ask"><input type="text" maxlength="2000" data-pc-task placeholder="What do you want done?" aria-label="Goal" enterkeyhint="go">' +
      '<button class="btn primary" type="submit" data-pc-begin>Start</button></div></form>';
  }

  // Only touches the options when the project list really changed, and never while he's in it.
  function pcSyncProjects(projs) {
    const sel = $('pcbody').querySelector('[data-pc-project]');
    if (!sel || sel === document.activeElement) return;
    if ([...sel.options].map((o) => o.value).join('\n') === projs.join('\n')) return;
    const keep = sel.value;
    sel.innerHTML = projs.map((p) => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
    if (projs.includes(keep)) sel.value = keep;
  }

  // The crew at a glance: which Primes are up (each with its own workers), who is
  // working, and on what. Live sessions only — whatever finished is in History.
  const LIVE_PHASES = ['queued', 'running', 'waiting', 'idle'];
  const pcLive = (j) => LIVE_PHASES.includes(j.phase || j.status);
  // Older relays send no `primes`; count what is up.
  const pcSlots = (s, jobs) => s.primes || { used: jobs.filter((j) => j.role === 'prime' && pcLive(j)).length, limit: 3 };
  function crewPanel(jobs, slots) {
    const primes = jobs.filter((j) => j.role === 'prime' && pcLive(j)).sort((a, b) => a.createdAt - b.createdAt);
    const lastPrime = jobs.find((j) => j.role === 'prime');
    const working = jobs.filter((j) => ['queued', 'running', 'waiting'].includes(j.phase || j.status));
    const solos = jobs.filter((j) => j.role !== 'prime' && j.role !== 'worker' && pcLive(j));
    const row = (j, cls) =>
      '<a class="crew-row ' + cls + '" href="#pcjob-' + esc(j.id) + '"><span class="dot ' + ((j.phase || j.status) === 'idle' ? 'idle' : 'on') + '"></span>' +
      '<span class="who"><b>' + esc(j.name || j.project) + '</b><span>' + esc(j.brief || j.task || '') + '</span></span>' + pcStateTag(j) + '</a>';
    const primeLines = primes.length
      ? primes.map((p) => row(p, 'prime') +
        jobs.filter((j) => j.role === 'worker' && j.parentId === p.id && pcLive(j)).slice(0, 8).map((w) => row(w, 'worker')).join('')).join('')
      : '<div class="crew-row prime"><span class="dot off"></span><span class="who"><b>Meeseeks Prime</b><span>' +
        (lastPrime ? 'offline — last up ' + esc(pcAgo(lastPrime.updatedAt)) : 'offline — give it a goal to bring it up') + '</span></span></div>';
    // A Prime that lost contact still holds its slot until it is back or let go.
    const held = slots.used - primes.length;
    const heldLine = held > 0
      ? '<div class="crew-held">' + held + (held === 1 ? ' Prime lost contact and still holds a slot' : ' Primes lost contact and still hold slots') +
        ' — it comes back with the PC, or let it go from History.</div>'
      : '';
    const pips = Array.from({ length: slots.limit }, (_, i) => '<i class="' + (i < slots.used ? 'on' : '') + '"></i>').join('');
    return '<div class="crew"><div class="crew-head"><span>Crew</span><span class="crew-count">' +
      (working.length ? working.length + ' working' : 'nobody working') + ' · <span class="prime-slots" title="Meeseeks Primes up, out of ' + slots.limit +
      '"><span class="pips" aria-hidden="true">' + pips + '</span>Primes ' + slots.used + '/' + slots.limit + '</span></span></div>' + primeLines + heldLine +
      solos.map((j) => row(j, '')).join('') + '</div>';
  }

  // The start form is never rebuilt, so the Prime limit is written into it in place.
  function pcSyncPrimeSlots(slots) {
    const form = $('pcbody').querySelector('[data-pc-start]');
    if (!form) return;
    const full = slots.used >= slots.limit;
    const prime = ((form.querySelector('[data-pc-mode]:checked') || {}).value) === 'prime';
    form.querySelector('[data-pc-prime-slots]').textContent = ' · ' + slots.used + ' of ' + slots.limit + ' up';
    const note = form.querySelector('[data-pc-prime-full]');
    note.hidden = !(prime && full);
    note.textContent = 'All ' + slots.limit + ' Primes are up. Give an idle one its next goal below, or stop one to start another. A one-job Meeseeks can still start.';
    const begin = form.querySelector('[data-pc-begin]');
    if (!begin.dataset.busy) begin.disabled = prime && full;
  }

  const pcDay = (ts) => {
    const d = new Date(ts);
    const days = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000);
    return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  };

  let pcTab = 'active';

  // Lays out the frame once; after that a refresh only swaps the regions whose markup
  // actually changed, so open pickers, focus and half-typed text survive the 4 s poll.
  function pcFrame() {
    if ($('pcbody').querySelector('[data-pc-region]')) return;
    $('pcbody').innerHTML = '<div data-pc-region="status"></div>' +
      '<section class="pc-compose" data-pc-compose hidden><h3>Start something</h3>' + pcStartForm() + '</section>' +
      '<div class="pc-tabs" role="tablist" aria-label="Sessions">' +
      '<button type="button" role="tab" id="pctab-active" aria-controls="pcpane-active" data-pc-tab="active">Active<i data-pc-count="active"></i></button>' +
      '<button type="button" role="tab" id="pctab-history" aria-controls="pcpane-history" data-pc-tab="history">History<i data-pc-count="history"></i></button></div>' +
      '<div class="pc-pane" role="tabpanel" id="pcpane-active" aria-labelledby="pctab-active" data-pc-region="active"></div>' +
      '<div class="pc-pane" role="tabpanel" id="pcpane-history" aria-labelledby="pctab-history" data-pc-region="history"></div>';
    pcShowTab(pcTab);
  }

  function pcShowTab(tab) {
    pcTab = tab;
    $('pcbody').querySelectorAll('.pc-tabs [data-pc-tab]').forEach((b) => {
      const on = b.dataset.pcTab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $('pcbody').querySelectorAll('.pc-pane').forEach((p) => { p.hidden = p.dataset.pcRegion !== tab; });
  }

  function pcRegion(name, html) {
    const el = $('pcbody').querySelector('[data-pc-region="' + name + '"]');
    if (!el || el.dataset.html === html) return;
    // Keep half-typed follow-ups, the focused field, and which history rows are open.
    const drafts = {};
    let focused = null;
    el.querySelectorAll('[data-pc-draft]').forEach((f) => {
      if (f.value) drafts[f.dataset.pcDraft] = f.value;
      if (f === document.activeElement) focused = f.dataset.pcDraft;
    });
    const open = new Set([...el.querySelectorAll('details[open]')].map((d) => d.dataset.pcHist));
    el.dataset.html = html;
    el.innerHTML = html;
    el.querySelectorAll('details[data-pc-hist]').forEach((d) => { if (open.has(d.dataset.pcHist)) d.open = true; });
    el.querySelectorAll('[data-pc-draft]').forEach((f) => {
      if (drafts[f.dataset.pcDraft]) f.value = drafts[f.dataset.pcDraft];
      if (f.dataset.pcDraft === focused) f.focus();
    });
  }

  function renderPc(s) {
    pcData = s;
    const jobs = s.jobs || [];
    const approvals = s.approvals || [];
    const active = jobs.filter((j) => ['queued', 'running', 'waiting'].includes(j.phase || j.status)).length;
    const primeUp = jobs.some((j) => j.role === 'prime' && pcLive(j));
    $('pcbtn').classList.toggle('prime-up', primeUp);
    const badge = $('pcbadge');
    badge.textContent = approvals.length || active || '';
    badge.classList.toggle('hidden', !(approvals.length || active));
    badge.classList.toggle('attn', approvals.length > 0);

    pcFrame();
    const projs = s.projects || [];
    const link = '<div class="pc-link' + (s.online ? '' : ' off') + '"><span class="dot"></span><span>' +
      (s.online ? 'PC online' + (projs.length ? ' · ' + projs.length + ' projects' : '')
        : 'PC offline' + (s.lastSeenAt ? ' — last heard ' + esc(pcAgo(s.lastSeenAt)) : ' — not heard from since the Keeper last restarted')) +
      '</span></div>';
    const offNote = !s.online
      ? '<div class="pc-note">The PC is off, asleep, or its agent isn’t running. New sessions wait ' +
        esc(String((s.limits && s.limits.queueMin) || 10)) + ' minutes for it, then are reported as not done.</div>'
      : '';
    pcRegion('status', link + offNote);
    $('pcbody').querySelector('[data-pc-compose]').hidden = !projs.length;
    pcSyncProjects(projs);

    // Anything still going, or still asking him something, stays up front.
    const asking = new Set(approvals.map((a) => a.jobId));
    const live = jobs.filter((j) => pcLive(j) || asking.has(j.id));
    const past = jobs.filter((j) => !pcLive(j) && !asking.has(j.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    $('pcbody').querySelector('[data-pc-count="active"]').textContent = live.length || '';
    $('pcbody').querySelector('[data-pc-count="history"]').textContent = past.length || '';
    $('pcbody').querySelector('.pc-tabs [data-pc-tab="active"]').classList.toggle('attn', approvals.length > 0);

    const slots = pcSlots(s, jobs);
    pcSyncPrimeSlots(slots);
    pcRegion('active', crewPanel(jobs, slots) + (live.length
      ? live.map((j) => pcJobCard(j, approvals, s.limits)).join('')
      : '<div class="pc-empty"><b>Nothing running.</b><span>' + (past.length
        ? 'Finished sessions are in <button type="button" class="linkish" data-pc-tab="history">History</button>.'
        : 'Ask the Keeper, or start one above.') + '</span></div>'));

    let day = '';
    pcRegion('history', past.length
      ? past.map((j) => {
        const d = pcDay(j.updatedAt);
        const head = d !== day ? '<h4 class="hist-day">' + esc(d) + '</h4>' : '';
        day = d;
        return head + pcHistoryRow(j, approvals, s.limits);
      }).join('')
      : '<div class="pc-empty"><b>No history yet.</b><span>Finished, stopped and failed sessions collect here.</span></div>');
  }

  async function pcCall(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !body) throw new Error(String(res.status));
    return res.json();
  }

  async function loadPc() {
    try {
      renderPc(await pcCall('/pc/state'));
      $('pcbody').querySelector('.pc-stale')?.remove();
    } catch {
      if (!pcData) $('pcbody').textContent = 'couldn’t reach the PC bridge just now';
      else if (!$('pcbody').querySelector('.pc-stale')) {
        $('pcbody').insertAdjacentHTML('afterbegin', '<div class="pc-note pc-stale">Couldn’t refresh — this is the last thing it knew.</div>');
      }
    }
  }

  // An <img> that 404s: the relay keeps only its most recent screenshots.
  $('pcbody').addEventListener('error', (e) => {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-pc-shot')) {
      e.target.outerHTML = '<div class="noshot">The screenshot is no longer on the server (it keeps only the most recent ones).</div>';
    }
  }, true);

  $('pcbody').addEventListener('change', (e) => {
    if (!e.target.hasAttribute('data-pc-mode')) return;
    const solo = e.target.closest('[data-pc-start]').querySelector('[data-pc-solo]');
    if (solo) solo.hidden = e.target.value === 'prime';
    if (pcData) pcSyncPrimeSlots(pcSlots(pcData, pcData.jobs || []));
  });

  $('pcbody').addEventListener('keydown', (e) => {
    if (!e.target.closest('.pc-tabs') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    pcShowTab(pcTab === 'active' ? 'history' : 'active');
    $('pctab-' + pcTab).focus();
  });

  // The start form lives for the life of the sheet, so Enter and the button share one path.
  $('pcbody').addEventListener('submit', async (e) => {
    const box = e.target.closest('[data-pc-start]');
    if (!box) return;
    e.preventDefault();
    const t = box.querySelector('[data-pc-begin]');
    if (t.disabled) return;
    const project = box.querySelector('[data-pc-project]').value;
    const mode = (box.querySelector('[data-pc-mode]:checked') || {}).value || 'meeseeks';
    const engine = box.querySelector('[data-pc-engine]').value;
    const taskEl = box.querySelector('[data-pc-task]');
    const task = taskEl.value.trim();
    if (!task) { toast('say what you want done first'); taskEl.focus(); return; }
    t.disabled = true;
    t.dataset.busy = '1';
    try {
      const r = mode === 'prime'
        ? await pcCall('/pc/delegate', { goal: task })
        : await pcCall('/pc/start', { project, task, mode: 'meeseeks', engine });
      if (!r.ok) toast(r.error || 'couldn’t start that session');
      else { taskEl.value = ''; pcShowTab('active'); }
    } catch { toast('couldn’t reach it — nothing was started'); }
    delete t.dataset.busy;
    t.disabled = false;
    void loadPc();
  });

  $('pcbody').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.pcTab) { pcShowTab(t.dataset.pcTab); return; }
    const stop = t.dataset.pcStop;
    const allow = t.dataset.pcAllow;
    const deny = t.dataset.pcDeny;
    const send = t.dataset.pcSend;
    if (!stop && !allow && !deny && !send) return;
    if (send) {
      const field = [...$('pcbody').querySelectorAll('[data-pc-draft]')].find((el) => el.dataset.pcDraft === send);
      const message = field ? field.value.trim() : '';
      if (!message) { toast('type the next task first'); return; }
      t.disabled = true;
      try {
        const r = await pcCall('/pc/send', { jobId: send, message });
        if (!r.ok) toast(r.error || 'that session can’t take a follow-up right now');
        else if (field) field.value = '';
      } catch { toast('couldn’t reach it — nothing was sent'); }
      await loadPc();
      t.disabled = false;
      return;
    }
    t.disabled = true;
    try {
      const r = stop ? await pcCall('/pc/stop', { jobId: stop }) : await pcCall('/pc/approve', { id: allow || deny, allow: Boolean(allow) });
      if (!r.ok) toast(stop ? 'that session already ended' : 'that request was already answered');
    } catch { toast('couldn’t reach it — nothing was sent'); }
    await loadPc();
    t.disabled = false;
  });

  // Badge while the sheet is shut; faster refresh while it is open.
  function pcTick() {
    clearTimeout(pcTimer);
    if (token && !document.hidden && !$('app').classList.contains('hidden')) void loadPc();
    pcTimer = setTimeout(pcTick, $('pc').classList.contains('open') ? 4000 : 30000);
  }

  // ══ install ═══════════════════════════════════════════════════════════
  let installPrompt = null;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('installsection').classList.remove('hidden');
    $('installhint').textContent = 'runs in its own window, with no browser chrome.';
  });

  $('installbtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') $('installsection').classList.add('hidden');
    installPrompt = null;
  });

  // iOS has no install API at all — the only route is the share sheet.
  if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('installsection').classList.remove('hidden');
    $('installbtn').classList.add('hidden');
    $('installhint').textContent = 'on iOS: tap the share button, then “Add to Home Screen”.';
  }

  // ══ notifications ═════════════════════════════════════════════════════
  /**
   * The whole point of the exercise: until now the Keeper could only interrupt
   * him on Telegram, so every proactive reach-out ended up there. A push
   * subscription lets it reach this surface with the app shut.
   *
   * The server only ever pushes turns it started itself — a reply to something
   * he just typed is not a reach-out, and doesn't earn a buzz.
   */
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  let vapidKey = null;
  let pushOn = false;

  /** base64url → the Uint8Array that applicationServerKey insists on. */
  function decodeKey(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function fetchVapidKey() {
    if (vapidKey !== null) return vapidKey;
    try {
      const res = await fetch('/api/push/key', { headers: { Authorization: 'Bearer ' + token } });
      vapidKey = (await res.json()).key || '';
    } catch {
      vapidKey = '';
    }
    return vapidKey;
  }

  /**
   * A subscription is bound to the VAPID key that created it. If the server
   * ever mints a new pair, every existing subscription is undeliverable — and
   * silently so. Cheaper to notice here than to wonder why it went quiet.
   */
  function keyMatches(sub, key) {
    const current = sub.options && sub.options.applicationServerKey;
    if (!current) return true; // browser won't say — leave it alone
    const a = new Uint8Array(current);
    const b = decodeKey(key);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  const postSubscription = (sub) =>
    fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(sub),
    });

  async function refreshNotif() {
    const btn = $('notifbtn');
    const hint = $('notifhint');
    $('notiftest').classList.add('hidden');
    btn.disabled = false;

    if (!pushSupported) {
      btn.classList.add('hidden');
      // iOS exposes the Notification API only to home-screen apps (16.4+), so
      // "unsupported" in mobile Safari really means "not installed yet".
      hint.textContent = isIOS
        ? 'add it to your home screen first — iOS only lets installed apps notify you.'
        : 'this browser can’t do notifications.';
      return;
    }
    btn.classList.remove('hidden');

    if (Notification.permission === 'denied') {
      btn.disabled = true;
      $('notiflabel').textContent = 'notifications blocked';
      hint.textContent = 'your browser is blocking them for this site — allow them in its site settings, then come back.';
      return;
    }

    let sub = null;
    try {
      sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    } catch { /* no registration yet */ }
    pushOn = !!sub && Notification.permission === 'granted';

    $('notiflabel').textContent = pushOn ? 'turn notifications off' : 'turn notifications on';
    hint.textContent = pushOn
      ? 'it can reach you here with the app closed. it only notifies you when it reaches out on its own — never for a reply you asked for.'
      : 'let it reach you when the app is closed, the way telegram does.';
    $('notiftest').classList.toggle('hidden', !pushOn);
  }

  async function enableNotif(permission) {
    try {
      if ((await permission) !== 'granted') return refreshNotif();
      const key = await fetchVapidKey();
      if (!key) { toast('it can’t send notifications yet'); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub && !keyMatches(sub, key)) { await sub.unsubscribe(); sub = null; }
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(key) });
      }
      const res = await postSubscription(sub);
      if (!res.ok) throw new Error('server refused the subscription');
      toast('notifications on — it can reach you here now');
    } catch (err) {
      toast('couldn’t turn those on: ' + ((err && err.message) || 'unknown error'));
    }
    refreshNotif();
  }

  /** Unhooks this device, server side and locally. Used by the toggle and by sign-out. */
  async function dropSubscription() {
    if (!pushSupported) return;
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (!sub) return;
    // Tell the server first: unsubscribing locally makes the endpoint
    // undeliverable, and a row that can never be sent to is just noise.
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  }

  async function disableNotif() {
    try {
      await dropSubscription();
      toast('notifications off');
    } catch {
      toast('couldn’t turn those off');
    }
    refreshNotif();
  }

  $('notifbtn').addEventListener('click', () => {
    if (pushOn) { void disableNotif(); return; }
    // requestPermission has to be the first thing this click does — anything
    // awaited before it spends the user gesture, and Safari then refuses.
    void enableNotif(Notification.requestPermission());
  });

  $('notiftest').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/push/test', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      });
      const d = await res.json();
      if (d.ok) toast(d.devices > 1 ? 'sent to ' + d.devices + ' devices' : 'sent — watch for it');
      else toast(d.devices ? 'it couldn’t deliver that' : 'no device is subscribed yet');
    } catch {
      toast('that didn’t go through');
    }
  });

  /**
   * Re-register on every boot. Browsers rotate push endpoints without warning,
   * and the server prunes anything a push service reports as gone — so rather
   * than trying to catch that moment, we just re-assert the truth each launch.
   */
  async function syncPush() {
    if (!pushSupported || Notification.permission !== 'granted') return;
    try {
      const key = await fetchVapidKey();
      if (!key) return;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub && !keyMatches(sub, key)) { await sub.unsubscribe(); sub = null; }
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(key) });
      }
      await postSubscription(sub);
      pushOn = true;
    } catch { /* notifications are a nicety; never block the app on them */ }
  }

  // ══ service worker ════════════════════════════════════════════════════
  let acceptedUpdate = false;

  async function reportCacheState(reg) {
    try {
      if (reg && reg.active) {
        const version = await new Promise((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => resolve(e.data);
          reg.active.postMessage({ type: 'VERSION' }, [ch.port2]);
          setTimeout(() => resolve(null), 800);
        });
        if (version) $('buildid').textContent = version;
      }
      if (navigator.storage && navigator.storage.estimate) {
        const { usage } = await navigator.storage.estimate();
        $('cachestate').textContent = usage ? 'ready · ' + (usage / 1024 / 1024).toFixed(1) + ' MB' : 'empty';
      }
    } catch {}
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        reportCacheState(reg);
        reg.addEventListener('updatefound', () => {
          const fresh = reg.installing;
          if (!fresh) return;
          fresh.addEventListener('statechange', () => {
            // A controller already exists ⇒ this is an update, not a first install.
            if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
              toast('a new build is ready', 'reload', () => {
                acceptedUpdate = true;
                fresh.postMessage({ type: 'SKIP_WAITING' });
              });
            }
          });
        });
      }).catch(() => {});

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (acceptedUpdate) location.reload();
      });

      navigator.serviceWorker.addEventListener('message', (e) => {
        if (!e.data || e.data.type !== 'PUSH') return;
        // A push arrived while this tab was visible, so the worker handed it
        // over instead of notifying. The stream normally already showed it —
        // but a push getting through while the stream is dead means the stream
        // is what's broken, so restart it.
        if (es && es.readyState === EventSource.CLOSED) connect();
      });
    });
  }

  $('signoutbtn').addEventListener('click', async () => {
    localStorage.removeItem('keeper_token');
    // Signing out has to stop the notifications too — otherwise this device
    // keeps buzzing with his life on it, with no way back in to turn it off.
    await dropSubscription().catch(() => {});
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    location.reload();
  });

  // ══ go ════════════════════════════════════════════════════════════════
  buildPresets();
  wireThemeControls();
  applyTheme(false);
  setOnline(navigator.onLine);
  enter();
})();
