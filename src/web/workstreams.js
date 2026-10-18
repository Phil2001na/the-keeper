(() => {
  'use strict';

  /* Work: one list of workstreams, and per stream a timeline of short
     "did / found → why it stopped" lines. The full report stays one tap away. */

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const STATUS = { active: 'Active', waiting: 'Waiting', parked: 'Parked', done: 'Done' };

  let state = null;
  let selected = new URLSearchParams(location.search).get('id');
  let query = '';
  let filter = 'open';
  let editing = false;
  let creating = false;
  const openEvents = new Set();
  const correcting = new Set();
  let briefPolls = 0;

  // ── data ──────────────────────────────────────────────────────────────
  async function api(body) {
    const token = localStorage.getItem('keeper_token') || '';
    const r = await fetch('/api/workstreams', {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'locked' : d.error || 'Could not save');
    return d;
  }

  async function load() {
    try {
      state = await api();
      render();
      // Summaries are written in the background; look again shortly if any are missing.
      if (state.events.some((e) => !e.brief) && briefPolls < 4) { briefPolls++; setTimeout(load, 6000); }
    } catch (e) {
      $('content').innerHTML = e.message === 'locked'
        ? `<div class="empty">Open the chat and enter your access token first.<br><br><a class="btn primary" style="display:inline-flex;width:auto" href="/">Go to chat</a></div>`
        : `<div class="empty">Your work couldn't load right now.<br><button class="linkish" id="retry">Try again</button></div>`;
      $('retry')?.addEventListener('click', load);
    }
  }

  async function save(body, msg = 'Saved') {
    try {
      await api(body);
      toast(msg);
      briefPolls = 0;
      await load();
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  let toastTimer;
  function toast(text, err) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'glass on' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'glass' + (err ? ' err' : '')), 2400);
  }

  // ── formatting ────────────────────────────────────────────────────────
  const dayKey = (d) => d.toDateString();
  function dayLabel(d) {
    const today = new Date();
    const yest = new Date(Date.now() - 864e5);
    if (dayKey(d) === dayKey(today)) return 'Today';
    if (dayKey(d) === dayKey(yest)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const clock = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 6e4);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 60 * 24) return Math.round(m / 60) + 'h ago';
    const d = Math.round(m / 1440);
    return d === 1 ? 'yesterday' : d + 'd ago';
  }
  const who = (src) => String(src || '').replace(/^agent:/, '').replace(/^Archive crew:.*/, 'Crew report');

  // Before a brief exists: first sentence of the report, markdown stripped.
  function briefOf(e) {
    if (e.brief) return e.brief;
    const plain = e.text.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
    const first = (plain.match(/^.{20,}?[.!?](\s|$)/) || [plain])[0].trim();
    return { what: first.length > 140 ? first.slice(0, 137) + '…' : first, stop: null, state: 'info', pending: true };
  }

  // Reports are untrusted text: escape first, then allow bold, code, http(s) links and bullets.
  function rich(text) {
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    return text.trim().split(/\n{2,}/).map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return '<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('') + '</ul>';
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }

  const chip = (s) => `<span class="chip ${s}">${STATUS[s] || esc(s)}</span>`;
  const eventsOf = (id) => state.events.filter((e) => e.streamId === id);
  const latest = (id) => {
    const ids = [id, ...state.streams.filter((c) => c.parentId === id).map((c) => c.id)];
    return state.events.filter((e) => ids.includes(e.streamId) && !(e.brief && e.brief.state === 'info' && /session closed|updated where this stands/i.test(e.brief.what))).at(-1);
  };

  // ── views ─────────────────────────────────────────────────────────────
  function render() {
    const s = state.streams.find((x) => x.id === selected);
    if (s || selected === 'inbox') renderStream(s);
    else renderList();
  }

  function renderList() {
    $('title').textContent = 'WORK';
    $('back').href = '/';
    $('back').onclick = null;
    const open = state.streams.filter((x) => x.status !== 'done');
    const waiting = open.filter((x) => x.status === 'waiting').length;
    $('sub').textContent = `${open.length} open${waiting ? ` · ${waiting} waiting on you` : ''}`;

    const q = query.toLowerCase();
    const matches = (x) => (query || filter === 'all' || (filter === 'open' ? x.status !== 'done' : x.status === 'done')) &&
      (!q || [x.title, x.where, x.next, ...eventsOf(x.id).map((e) => e.text)].join(' ').toLowerCase().includes(q));
    const recent = (x) => latest(x.id)?.at || x.updatedAt;
    const areas = state.streams.filter((x) => !x.parentId)
      .map((a) => ({ a, kids: state.streams.filter((c) => c.parentId === a.id && matches(c)) }))
      .filter(({ a, kids }) => matches(a) || kids.length)
      .sort((x, y) => recent(y.a).localeCompare(recent(x.a)));

    const row = (x, child) => {
      const last = latest(x.id);
      const b = last && briefOf(last);
      return `<button class="row${child ? ' child' : ''}" data-open="${x.id}">
        <span class="row-title">${esc(x.title)}</span>
        <span class="row-meta">${chip(x.status)}</span>
        <span class="row-last">${b ? `<span class="when">${ago(last.at)} · </span>${esc(b.stop ? b.stop : b.what)}` : esc(x.next ? 'Next: ' + x.next : x.where)}</span>
      </button>`;
    };
    const inbox = state.events.filter((e) => !e.streamId).length;

    $('content').innerHTML = `
      <div class="ws-tools">
        <input class="ws-search" id="search" type="search" placeholder="Search work" value="${esc(query)}" aria-label="Search work">
        <div class="seg" role="group" aria-label="Show">
          ${[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([v, l]) => `<button data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}
        </div>
      </div>
      ${creating ? createForm() : ''}
      ${areas.length ? areas.map(({ a, kids }, i) => `<section class="glass area rise" style="animation-delay:${i * 50}ms">${row(a)}${kids.sort((x, y) => recent(y).localeCompare(recent(x))).map((c) => row(c, true)).join('')}</section>`).join('')
        : `<div class="empty">${query ? 'Nothing matches that.' : filter === 'done' ? 'Nothing finished yet.' : 'No open work. Tap + to start a workstream.'}</div>`}
      ${inbox ? `<section class="glass area rise"><button class="row" data-open="inbox"><span class="row-title">Unfiled</span><span class="row-meta"><span class="chip parked">${inbox}</span></span><span class="row-last">Agent results that didn't clearly belong to one workstream.</span></button></section>` : ''}`;

    const search = $('search');
    search.oninput = (e) => { query = e.target.value; renderList(); const s2 = $('search'); s2.focus(); s2.setSelectionRange(query.length, query.length); };
    document.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { filter = b.dataset.filter; renderList(); }));
    wireCreate();
  }

  function createForm() {
    return `<form class="glass note rise form" id="create">
      <div class="eyebrow">New workstream</div>
      <label>Name<input name="title" required maxlength="100" placeholder="e.g. Supabase application" autofocus></label>
      <label>Inside<select name="parentId"><option value="">Its own area</option>${state.streams.filter((x) => !x.parentId).map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}</select></label>
      <label>Phrases that route agent reports here (comma-separated)<input name="aliases" placeholder="Supabase application"></label>
      <div class="hero-actions"><button class="btn primary">Create</button><button type="button" class="btn quiet" id="cancelcreate">Cancel</button></div>
    </form>`;
  }

  function wireCreate() {
    const f = $('create');
    if (!f) return;
    $('cancelcreate').onclick = () => { creating = false; render(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      if (await save({ action: 'create', title: d.get('title'), parentId: d.get('parentId') || null, aliases: String(d.get('aliases')).split(',').map((x) => x.trim()).filter(Boolean) }, 'Created')) { creating = false; render(); }
    };
  }

  function renderStream(s) {
    const parent = s && state.streams.find((p) => p.id === s.parentId);
    $('title').textContent = 'WORK';
    $('sub').textContent = s ? (parent ? parent.title : 'Area') : 'Unfiled';
    $('back').href = '/workstreams';
    $('back').onclick = (e) => { e.preventDefault(); go(s?.parentId || null); };

    const events = eventsOf(s ? s.id : null).slice().reverse();
    const kids = s ? state.streams.filter((c) => c.parentId === s.id) : [];

    const hero = s ? `
      <section class="glass hero rise">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <span class="eyebrow">${esc(parent ? parent.title : 'Area')}</span>${chip(s.status)}
        </div>
        <h1>${esc(s.title)}</h1>
        ${editing ? snapshotForm(s) : `
          <p class="where">${esc(s.where)}</p>
          <dl class="facts">
            ${s.next ? `<div class="fact next"><dt>Next</dt><dd>${esc(s.next)}</dd></div>` : ''}
            ${s.blocked ? `<div class="fact"><dt>Blocked</dt><dd>${esc(s.blocked)}</dd></div>` : ''}
            ${s.owner && s.owner !== 'Unassigned' ? `<div class="fact"><dt>With</dt><dd>${esc(s.owner)}</dd></div>` : ''}
          </dl>
          <div class="hero-actions">
            <a class="btn primary" href="/?workstream=${s.id}"><svg><use href="#i-chat"/></svg>Continue in chat</a>
            <button class="btn quiet" id="edit">Edit</button>
          </div>
          ${kids.length ? `<div class="kids">${kids.map((c) => `<button data-open="${c.id}">${esc(c.title)} · ${STATUS[c.status]}</button>`).join('')}</div>` : ''}`}
      </section>` : `<section class="glass hero rise"><span class="eyebrow">Inbox</span><h1>Unfiled</h1><p class="where">Results that matched no workstream, or more than one. Open one to move it where it belongs.</p></section>`;

    let lastDay = '';
    const timeline = events.map((e, i) => {
      const d = new Date(e.at);
      const head = dayKey(d) !== lastDay ? `<div class="day">${dayLabel(d)}</div>` : '';
      lastDay = dayKey(d);
      const b = briefOf(e);
      const isOpen = openEvents.has(e.id);
      const next = events[i + 1];
      const endOfDay = !next || dayKey(new Date(next.at)) !== lastDay;
      return `${head}<div class="ev ${b.state}${isOpen ? ' open' : ''}${head ? ' first' : ''}${endOfDay ? ' last' : ''}">
        <time datetime="${esc(e.at)}">${clock(d)}</time>
        <div class="rail"><i></i></div>
        <div class="ev-body">
          <button class="ev-head" data-toggle="${e.id}" aria-expanded="${isOpen}">
            <div class="what">${esc(b.what)}</div>
            ${b.stop ? `<div class="stop">${esc(b.stop)}</div>` : ''}
            <div class="who">${esc(who(e.source))}${e.certainty === 'reported' && e.source.startsWith('agent') ? ' · reported' : ''}${e.certainty === 'confirmed' ? ' · confirmed' : ''}</div>
          </button>
          ${isOpen ? detail(e) : ''}
        </div>
      </div>`;
    }).join('');

    $('content').innerHTML = `${hero}
      <div class="label">Timeline</div>
      ${events.length ? `<div class="tl">${timeline}</div>` : '<div class="empty">Nothing yet. Chat and agent results for this work will land here.</div>'}
      ${s ? `<form class="glass note form" id="note">
        <label>Add a note<textarea name="text" required maxlength="20000" placeholder="What happened, or what you decided"></textarea></label>
        <button class="btn">Add to timeline</button>
      </form>` : ''}`;

    document.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.toggle;
      openEvents.has(id) ? openEvents.delete(id) : openEvents.add(id);
      render();
    }));
    document.querySelectorAll('[data-fix]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.fix;
      correcting.has(id) ? correcting.delete(id) : correcting.add(id);
      render();
    }));
    document.querySelectorAll('[data-correct]').forEach((f) => (f.onsubmit = async (e) => {
      e.preventDefault();
      const input = Object.fromEntries(new FormData(f));
      if (await save({ action: 'correct', id: f.dataset.correct, ...input, streamId: input.streamId || null }, 'Updated')) correcting.delete(f.dataset.correct);
    }));
    if ($('edit')) $('edit').onclick = () => { editing = true; render(); };
    if ($('canceledit')) $('canceledit').onclick = () => { editing = false; render(); };
    if ($('snapshot')) $('snapshot').onsubmit = async (e) => {
      e.preventDefault();
      if (await save({ action: 'snapshot', id: s.id, revision: state.revision, ...Object.fromEntries(new FormData(e.target)) })) { editing = false; render(); }
    };
    if ($('note')) $('note').onsubmit = (e) => {
      e.preventDefault();
      save({ action: 'event', streamId: s.id, kind: 'update', certainty: 'confirmed', text: new FormData(e.target).get('text') }, 'Added');
    };
  }

  function detail(e) {
    const options = '<option value="">Unfiled</option>' + state.streams.map((x) => `<option value="${x.id}" ${x.id === e.streamId ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
    return `<div class="glass detail">
      ${rich(e.text)}
      <div class="detail-meta">
        <span>${esc(who(e.source))} · ${new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        ${e.artifact ? `<a href="${esc(e.artifact)}" target="_blank" rel="noopener noreferrer">Open link</a>` : ''}
        <button class="linkish" data-fix="${e.id}">${correcting.has(e.id) ? 'Close' : 'Correct or move'}</button>
      </div>
      ${correcting.has(e.id) ? `<form class="form" data-correct="${e.id}">
        <label>Belongs to<select name="streamId">${options}</select></label>
        <label>Text<textarea name="text" required maxlength="20000">${esc(e.text)}</textarea></label>
        <label>How sure<select name="certainty">${['reported', 'suggested', 'confirmed'].map((c) => `<option ${c === e.certainty ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <button class="btn primary">Save</button>
        ${e.revisions.length ? `<details class="muted-block"><summary>Earlier versions (${e.revisions.length})</summary>${e.revisions.map((r) => `<p class="muted-block"><small>${esc(new Date(r.at).toLocaleString())} · ${esc(r.certainty)}</small><br>${esc(r.text)}</p>`).join('')}</details>` : ''}
      </form>` : ''}
    </div>`;
  }

  function snapshotForm(s) {
    const field = (k, label, max) => `<label>${label}<textarea name="${k}" maxlength="${max}">${esc(s[k])}</textarea></label>`;
    return `<form class="form" id="snapshot">
      <label>Status<select name="status">${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${v === s.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${field('where', 'Where it stands', 1000)}
      ${field('next', 'Next', 1000)}
      ${field('blocked', 'Blocked by', 1000)}
      ${field('done', 'Done so far', 1000)}
      <label>With<input name="owner" maxlength="100" value="${esc(s.owner)}"></label>
      <div class="hero-actions"><button class="btn primary">Save</button><button type="button" class="btn quiet" id="canceledit">Cancel</button></div>
    </form>`;
  }

  function go(id) {
    selected = id;
    editing = false;
    history.pushState(null, '', id ? '?id=' + id : '/workstreams');
    render();
    window.scrollTo(0, 0);
  }

  window.addEventListener('popstate', () => { selected = new URLSearchParams(location.search).get('id'); editing = false; render(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) go(b.dataset.open);
  });
  $('newbtn').onclick = () => { if (selected) go(null); creating = true; filter = 'open'; render(); };
  load();
})();
