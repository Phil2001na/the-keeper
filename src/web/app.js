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
  let es = null;
  let activity = null;
  let activitySteps = [];
  let turnStarted = 0;
  let currentStep = null;
  let lastRole = null;

  // ── helpers ───────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** markdown-lite for agent text: escape first, then bold / code / links */
  function fmt(s) {
    let h = esc(s);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return h;
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

  const MOTION_HINTS = {
    still: 'nothing moves.',
    aurora: 'the light drifts behind everything, on a slow cycle.',
    liquid: 'five masses pushed around by currents, on periods that never line back up.',
    drift: 'the accent itself breathes ±14° over a minute and a half.',
    reactive: 'the room only lights up while it\'s actually working.',
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Only the inputs plus motion — a preset's id/name would go stale the moment
  // a slider moves off it.
  const DEFAULT_THEME = {
    h: PRESETS[0].h,
    spread: PRESETS[0].spread,
    chroma: PRESETS[0].chroma,
    tint: PRESETS[0].tint,
    glass: 42,
    speed: 1,
    motion: 'aurora',
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
        // Clamped rather than trusted: these divide animation durations, and a
        // hand-edited 0 in localStorage would divide by zero and freeze the
        // whole field with no way back except clearing storage.
        glass: Number.isFinite(s.glass) ? clamp(s.glass, 0, 100) : DEFAULT_THEME.glass,
        speed: Number.isFinite(s.speed) ? clamp(s.speed, 0.25, 4) : DEFAULT_THEME.speed,
        motion: MOTION_HINTS[s.motion] ? s.motion : DEFAULT_THEME.motion,
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
    root.style.setProperty('--motion-speed', theme.speed);
    root.dataset.motion = theme.motion;
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
    $('speed').value = Math.round(theme.speed * 100);
    $('huev').textContent = Math.round(theme.h) + '°';
    $('spreadv').textContent = (theme.spread > 0 ? '+' : '') + theme.spread + '°';
    $('chromav').textContent = Math.round((theme.chroma / 0.3) * 100) + '%';
    $('glassv').textContent = Math.round(theme.glass) + '%';
    $('speedv').textContent = Math.round(theme.speed * 100) / 100 + '×';
    $('motionhint').textContent = MOTION_HINTS[theme.motion] || '';
    // Speed divides keyframe durations, and the two modes without keyframes
    // would show a slider that does nothing.
    $('speedrow').classList.toggle('hidden', theme.motion === 'still' || theme.motion === 'reactive');

    for (const b of $('motion').children) {
      b.setAttribute('aria-pressed', String(b.dataset.motion === theme.motion));
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
    bind('speed', 'speed', (v) => v / 100);

    for (const b of $('motion').children) {
      b.addEventListener('click', () => {
        theme = { ...theme, motion: b.dataset.motion };
        applyTheme(true);
      });
    }
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
    turn.appendChild(el('div', 'stamp', esc(timeStr(ts))));

    // The turn opens before the inbound message is logged, so a plain append
    // would leave "thinking…" sitting above the message that caused it. Your
    // own message belongs above the activity rail; the reply belongs below.
    if (role === 'user' && activity && activity.parentNode === stream) {
      const stick = nearBottom();
      stream.insertBefore(turn, activity);
      if (stick) stream.scrollTop = stream.scrollHeight;
    } else {
      append(turn);
    }
    lastRole = role;
  }

  function setStatus(text) { $('statustext').textContent = text; }

  function sourceTag(source) {
    if (source === 'reflection') return 'reflecting';
    if (source === 'touchpoint') return 'reaching out';
    return '';
  }

  function beginTurn(source) {
    root.classList.add('busy');
    setStatus('thinking');
    turnStarted = Date.now();
    activitySteps = [];
    currentStep = null;
    activity = el('div', 'activity');
    const tag = sourceTag(source);
    if (tag) activity.appendChild(el('span', 'tag', esc(tag)));
    const thinking = el('span', 'step live', 'thinking<span class="dots"></span>');
    activity.appendChild(thinking);
    currentStep = thinking;
    append(activity);
  }

  function addStep(label) {
    if (!activity) return;
    if (currentStep) {
      currentStep.classList.remove('live');
      if (currentStep.textContent.startsWith('thinking')) currentStep.remove();
    }
    activitySteps.push(label);
    currentStep = el('span', 'step live', esc(label) + '<span class="dots"></span>');
    const stick = nearBottom();
    activity.appendChild(currentStep);
    if (stick) stream.scrollTop = stream.scrollHeight;
    setStatus(label);
  }

  function endTurn() {
    root.classList.remove('busy');
    setStatus(navigator.onLine ? 'here' : 'offline');
    if (activity) {
      const secs = Math.max(1, Math.round((Date.now() - turnStarted) / 1000));
      const uniq = [...new Set(activitySteps)];
      const what = uniq.length ? uniq.join(' · ') : 'thought it over';
      activity.classList.add('done');
      activity.appendChild(el('span', 'summary', esc(what + ' — ' + secs + 's')));
      activity = null;
      currentStep = null;
    }
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

  function addMedia(m) {
    if (m.kind === 'photo') {
      const img = el('img', 'media-img');
      img.src = m.dataUrl;
      img.alt = 'generated image';
      append(img);
    } else {
      const a = el('a', 'media-doc', icon('doc', 17) + esc(m.filename || 'document.pdf'));
      a.href = m.dataUrl;
      a.download = m.filename || 'document.pdf';
      append(a);
    }
    lastRole = null;
  }

  // ══ events ════════════════════════════════════════════════════════════
  function handleEvent(ev) {
    if (ev.type === 'turn') { ev.phase === 'start' ? beginTurn(ev.source) : endTurn(); return; }
    if (ev.type === 'step') { addStep(ev.label); return; }
    if (ev.type === 'message') { addMessage(ev.role, ev.content, ev.ts); return; }
    if (ev.type === 'card') { addCard(ev.card); return; }
    if (ev.type === 'media') { addMedia(ev); return; }
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
    if (new URLSearchParams(location.search).get('view') === 'mind') openSheet('mind');
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

  async function send() {
    const text = box.value.trim();
    if (!text && pending.length === 0) return;
    if (!navigator.onLine) { toast('still offline — it didn’t get that'); return; }
    const files = pending;
    box.value = '';
    autosize();
    pending = [];
    renderChips();
    sendbtn.disabled = true;
    try {
      const res = await fetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ text, files }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) { token = ''; enter(); }
        else toast(data.error || 'that didn’t go through');
      }
    } catch {
      toast('no connection — it didn’t get that');
    } finally {
      sendbtn.disabled = !navigator.onLine;
      box.focus();
    }
  }

  sendbtn.addEventListener('click', send);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ── jump to latest ────────────────────────────────────────────────────
  stream.addEventListener('scroll', () => {
    $('jumpbtn').classList.toggle('away', nearBottom());
  });
  $('jumpbtn').addEventListener('click', () => {
    stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
  });

  // ══ sheets ════════════════════════════════════════════════════════════
  function openSheet(which) {
    closeSheets();
    $(which).classList.add('open');
    $(which).setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('show');
    if (which === 'mind') loadMind();
    if (which === 'settings') {
      void refreshNotif();
      if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistration().then(reportCacheState).catch(() => {});
      }
    }
  }

  function closeSheets() {
    for (const id of ['mind', 'settings']) {
      $(id).classList.remove('open');
      $(id).setAttribute('aria-hidden', 'true');
    }
    $('scrim').classList.remove('show');
  }

  $('mindbtn').addEventListener('click', () => openSheet('mind'));
  $('settingsbtn').addEventListener('click', () => openSheet('settings'));
  $('scrim').addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

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
