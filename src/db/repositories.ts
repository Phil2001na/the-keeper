import { db } from './client.js';

// ─── Types ─────────────────────────────────────────────
export interface Domain {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  cadence_hint: string | null;
  priority: number;
  created_by: string;
  active: boolean;
  created_at: string;
}

export interface Fact {
  id: string;
  domain_id: string | null;
  key: string;
  value: string;
  confidence: string;
  updated_at: string;
}

export interface Touchpoint {
  id: string;
  fire_at: string;
  domain_id: string | null;
  reason: string;
  status: 'pending' | 'fired' | 'cancelled';
  /** How a fired touchpoint went: 'sent' | 'silent' | 'replied' (he answered). */
  outcome: string | null;
  fired_at: string | null;
  /** Standing ritual spec ('weekly:sun@10:00' etc.) — the scheduler renews it after firing. */
  recurrence: string | null;
  created_at: string;
}

/** One measured moment of his life — append-only time-series. */
export interface Observation {
  id: string;
  domain_id: string | null;
  metric: string;
  value: number | null;
  text_value: string | null;
  unit: string | null;
  observed_at: string;
  note: string | null;
  source: string;
  created_at: string;
}

export interface Goal {
  id: string;
  domain_id: string | null;
  title: string;
  metric: string | null;
  target_value: number | null;
  unit: string | null;
  deadline: string | null;
  status: string;
  why: string | null;
  created_at: string;
  updated_at: string;
}

/** A watched open loop / hypothesis about him — the anticipation ledger. */
export interface Thread {
  id: string;
  domain_id: string | null;
  title: string;
  note: string | null;
  status: string;
  next_check: string | null;
  created_at: string;
  updated_at: string;
}

/** The rolling conversation digest + the context-window anchor it implies. */
export interface Digest {
  id: string;
  kind: string;
  content: string;
  covered_until: string | null;
  updated_at: string;
}

export interface Interaction {
  id: string;
  role: 'user' | 'agent';
  content: string;
  trigger: string | null;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  kind: string;
  day: string;
  entry: string;
  created_at: string;
}

// keeper_interactions has a generated tsvector column (fts) for search — never
// select('*') from it or every read drags the index payload over the wire.
const INTERACTION_COLS = 'id, role, content, trigger, created_at';

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`[db] ${context}: ${error?.message ?? 'unknown error'}`);
}

// ─── Domains ───────────────────────────────────────────
export const domains = {
  async list(includeInactive = false): Promise<Domain[]> {
    let q = db.from('keeper_domains').select('*').order('priority', { ascending: true });
    if (!includeInactive) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) fail('domains.list', error);
    return data as Domain[];
  },

  async getBySlug(slug: string): Promise<Domain | null> {
    const { data, error } = await db.from('keeper_domains').select('*').eq('slug', slug).maybeSingle();
    if (error) fail('domains.getBySlug', error);
    return (data as Domain) ?? null;
  },

  async create(input: {
    slug: string;
    name: string;
    description?: string;
    cadence_hint?: string;
    priority?: number;
    created_by?: string;
  }): Promise<Domain> {
    const { data, error } = await db
      .from('keeper_domains')
      .insert({
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        cadence_hint: input.cadence_hint ?? null,
        priority: input.priority ?? 3,
        created_by: input.created_by ?? 'agent',
      })
      .select('*')
      .single();
    if (error) fail('domains.create', error);
    return data as Domain;
  },

  /** Patch an existing domain (description, cadence, priority, active). */
  async update(
    slug: string,
    patch: { description?: string; cadence_hint?: string; priority?: number; active?: boolean }
  ): Promise<Domain | null> {
    const { data, error } = await db
      .from('keeper_domains')
      .update(patch)
      .eq('slug', slug)
      .select('*')
      .maybeSingle();
    if (error) fail('domains.update', error);
    return (data as Domain) ?? null;
  },

  /** Insert if the slug doesn't exist yet; otherwise return the existing row. */
  async ensure(input: {
    slug: string;
    name: string;
    description?: string;
    cadence_hint?: string;
    priority?: number;
    created_by?: string;
  }): Promise<Domain> {
    const existing = await this.getBySlug(input.slug);
    if (existing) return existing;
    return this.create(input);
  },
};

// ─── Facts ─────────────────────────────────────────────
export const facts = {
  async all(): Promise<Fact[]> {
    const { data, error } = await db
      .from('keeper_facts')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) fail('facts.all', error);
    return data as Fact[];
  },

  async byDomain(domainId: string): Promise<Fact[]> {
    const { data, error } = await db
      .from('keeper_facts')
      .select('*')
      .eq('domain_id', domainId)
      .order('updated_at', { ascending: false });
    if (error) fail('facts.byDomain', error);
    return data as Fact[];
  },

  /** Upsert on (domain_id, key) — newest value wins. */
  async upsert(input: {
    domain_id: string | null;
    key: string;
    value: string;
    confidence?: string;
  }): Promise<Fact> {
    const { data, error } = await db
      .from('keeper_facts')
      .upsert(
        {
          domain_id: input.domain_id,
          key: input.key,
          value: input.value,
          confidence: input.confidence ?? 'medium',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'domain_id,key' }
      )
      .select('*')
      .single();
    if (error) fail('facts.upsert', error);
    return data as Fact;
  },

  /** Delete a fact by (domain, key). Returns true if a row was removed. */
  async remove(domainId: string | null, key: string): Promise<boolean> {
    let q = db.from('keeper_facts').delete({ count: 'exact' }).eq('key', key);
    q = domainId === null ? q.is('domain_id', null) : q.eq('domain_id', domainId);
    const { count, error } = await q;
    if (error) fail('facts.remove', error);
    return (count ?? 0) > 0;
  },
};

// ─── Touchpoints ───────────────────────────────────────
export const touchpoints = {
  async due(now = new Date()): Promise<Touchpoint[]> {
    const { data, error } = await db
      .from('keeper_touchpoints')
      .select('*')
      .eq('status', 'pending')
      .lte('fire_at', now.toISOString())
      .order('fire_at', { ascending: true });
    if (error) fail('touchpoints.due', error);
    return data as Touchpoint[];
  },

  async pending(): Promise<Touchpoint[]> {
    const { data, error } = await db
      .from('keeper_touchpoints')
      .select('*')
      .eq('status', 'pending')
      .order('fire_at', { ascending: true });
    if (error) fail('touchpoints.pending', error);
    return data as Touchpoint[];
  },

  async create(input: {
    fire_at: string;
    domain_id: string | null;
    reason: string;
    recurrence?: string | null;
  }): Promise<Touchpoint> {
    const { data, error } = await db
      .from('keeper_touchpoints')
      .insert({
        fire_at: input.fire_at,
        domain_id: input.domain_id,
        reason: input.reason,
        recurrence: input.recurrence ?? null,
      })
      .select('*')
      .single();
    if (error) fail('touchpoints.create', error);
    return data as Touchpoint;
  },

  async setStatus(id: string, status: Touchpoint['status']): Promise<void> {
    const { error } = await db.from('keeper_touchpoints').update({ status }).eq('id', id);
    if (error) fail('touchpoints.setStatus', error);
  },

  /** Mark a touchpoint fired, recording whether the agent messaged or stayed silent. */
  async markFired(id: string, outcome: 'sent' | 'silent'): Promise<void> {
    const { error } = await db
      .from('keeper_touchpoints')
      .update({ status: 'fired', outcome, fired_at: new Date().toISOString() })
      .eq('id', id);
    if (error) fail('touchpoints.markFired', error);
  },

  /** He answered after a sent touchpoint — upgrade its outcome to 'replied'. */
  async markReplied(id: string): Promise<void> {
    const { error } = await db
      .from('keeper_touchpoints')
      .update({ outcome: 'replied' })
      .eq('id', id)
      .eq('outcome', 'sent');
    if (error) fail('touchpoints.markReplied', error);
  },

  /** Touchpoints fired in the last N days — reflection reads these to learn his rhythm. */
  async recentFired(days: number): Promise<Touchpoint[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from('keeper_touchpoints')
      .select('*')
      .eq('status', 'fired')
      .gte('fired_at', cutoff)
      .order('fired_at', { ascending: false });
    if (error) fail('touchpoints.recentFired', error);
    return data as Touchpoint[];
  },
};

// ─── Interactions ──────────────────────────────────────
export const interactions = {
  async recent(limit: number): Promise<Interaction[]> {
    const { data, error } = await db
      .from('keeper_interactions')
      .select(INTERACTION_COLS)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) fail('interactions.recent', error);
    // return oldest → newest for natural conversation order
    return (data as Interaction[]).reverse();
  },

  /**
   * Full-text search over the ENTIRE conversation archive — the agent's
   * long-term episodic memory. Plain words, quoted phrases, and `-exclusions`
   * all work (websearch syntax). Newest matches first.
   */
  async search(query: string, limit = 12): Promise<Interaction[]> {
    const { data, error } = await db
      .from('keeper_interactions')
      .select(INTERACTION_COLS)
      .textSearch('fts', query, { type: 'websearch', config: 'english' })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) fail('interactions.search', error);
    return data as Interaction[];
  },

  /** Everything said between two instants (oldest first) — "what happened that day". */
  async window(fromIso: string, toIso: string, limit = 40): Promise<Interaction[]> {
    const { data, error } = await db
      .from('keeper_interactions')
      .select(INTERACTION_COLS)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) fail('interactions.window', error);
    return data as Interaction[];
  },

  /**
   * Everything said strictly AFTER the digest anchor (oldest first) — the
   * anchored context window. Capped for safety; if over the cap, the newest
   * survive (the digest will catch the overflow on the next fold).
   */
  async sinceAnchor(anchorIso: string, cap = 200): Promise<Interaction[]> {
    const { data, error } = await db
      .from('keeper_interactions')
      .select(INTERACTION_COLS)
      .gt('created_at', anchorIso)
      .order('created_at', { ascending: false })
      .limit(cap);
    if (error) fail('interactions.sinceAnchor', error);
    return (data as Interaction[]).reverse();
  },

  async countSince(iso: string): Promise<number> {
    const { count, error } = await db
      .from('keeper_interactions')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', iso);
    if (error) fail('interactions.countSince', error);
    return count ?? 0;
  },

  async log(input: {
    role: 'user' | 'agent';
    content: string;
    trigger?: string | null;
  }): Promise<void> {
    const { error } = await db.from('keeper_interactions').insert({
      role: input.role,
      content: input.content,
      trigger: input.trigger ?? null,
    });
    if (error) fail('interactions.log', error);
  },
};

// ─── Journal ───────────────────────────────────────────
// The agent's private nightly journal — its continuity of self between days.
export const journal = {
  /** One entry per (kind, day); writing again the same night replaces it. */
  async upsert(kind: string, day: string, entry: string): Promise<void> {
    const { error } = await db
      .from('keeper_journal')
      .upsert({ kind, day, entry }, { onConflict: 'kind,day' });
    if (error) fail('journal.upsert', error);
  },

  async recent(limit = 3): Promise<JournalEntry[]> {
    const { data, error } = await db
      .from('keeper_journal')
      .select('*')
      .eq('kind', 'nightly')
      .order('day', { ascending: false })
      .limit(limit);
    if (error) fail('journal.recent', error);
    return data as JournalEntry[];
  },

  async hasDay(kind: string, day: string): Promise<boolean> {
    const { data, error } = await db
      .from('keeper_journal')
      .select('id')
      .eq('kind', kind)
      .eq('day', day)
      .maybeSingle();
    if (error) fail('journal.hasDay', error);
    return data !== null;
  },
};

// ─── Portrait ──────────────────────────────────────────
// The agent's living synthesis of WHO Philip is and how to be with him — a
// single evolving document (not a dated log), revised during nightly reflection
// and carried in the system prompt every turn. This is the "continuity of
// stance": a stable lens applied to every interaction. Stored as the single
// keeper_journal row with kind='portrait' (fixed day key → always one row).
const PORTRAIT_KIND = 'portrait';
const PORTRAIT_KEY = 'current';
export const portrait = {
  async get(): Promise<string | null> {
    const { data, error } = await db
      .from('keeper_journal')
      .select('entry')
      .eq('kind', PORTRAIT_KIND)
      .eq('day', PORTRAIT_KEY)
      .maybeSingle();
    if (error) fail('portrait.get', error);
    return (data as { entry: string } | null)?.entry ?? null;
  },

  async set(text: string): Promise<void> {
    const { error } = await db
      .from('keeper_journal')
      .upsert({ kind: PORTRAIT_KIND, day: PORTRAIT_KEY, entry: text }, { onConflict: 'kind,day' });
    if (error) fail('portrait.set', error);
  },
};

// ─── Observations ──────────────────────────────────────
// Append-only time-series of life metrics. You can't improve what you don't track.
export const observations = {
  async log(input: {
    domain_id?: string | null;
    metric: string;
    value?: number | null;
    text_value?: string | null;
    unit?: string | null;
    observed_at?: string;
    note?: string | null;
    source?: string;
  }): Promise<Observation> {
    const { data, error } = await db
      .from('keeper_observations')
      .insert({
        domain_id: input.domain_id ?? null,
        metric: input.metric,
        value: input.value ?? null,
        text_value: input.text_value ?? null,
        unit: input.unit ?? null,
        observed_at: input.observed_at ?? new Date().toISOString(),
        note: input.note ?? null,
        source: input.source ?? 'chat',
      })
      .select('*')
      .single();
    if (error) fail('observations.log', error);
    return data as Observation;
  },

  /**
   * Points for one metric (oldest first). A metric ending in '.' is a prefix:
   * 'spend.' returns every spend.* metric — the raw material of category reports.
   */
  async series(metricOrPrefix: string, sinceIso?: string, limit = 1000): Promise<Observation[]> {
    let q = db.from('keeper_observations').select('*');
    q = metricOrPrefix.endsWith('.')
      ? q.like('metric', `${metricOrPrefix}%`)
      : q.eq('metric', metricOrPrefix);
    if (sinceIso) q = q.gte('observed_at', sinceIso);
    const { data, error } = await q.order('observed_at', { ascending: false }).limit(limit);
    if (error) fail('observations.series', error);
    return (data as Observation[]).reverse();
  },

  /** The newest observation of every metric — a snapshot of everything tracked. */
  async latestPerMetric(scan = 600): Promise<Observation[]> {
    const { data, error } = await db
      .from('keeper_observations')
      .select('*')
      .order('observed_at', { ascending: false })
      .limit(scan);
    if (error) fail('observations.latestPerMetric', error);
    const seen = new Map<string, Observation>();
    for (const o of data as Observation[]) if (!seen.has(o.metric)) seen.set(o.metric, o);
    return [...seen.values()].sort((a, b) => a.metric.localeCompare(b.metric));
  },

  /** How many observations landed per metric since an instant (tracking-gap radar). */
  async countByMetricSince(iso: string): Promise<Map<string, number>> {
    const { data, error } = await db
      .from('keeper_observations')
      .select('metric')
      .gte('observed_at', iso)
      .limit(2000);
    if (error) fail('observations.countByMetricSince', error);
    const counts = new Map<string, number>();
    for (const row of data as { metric: string }[]) {
      counts.set(row.metric, (counts.get(row.metric) ?? 0) + 1);
    }
    return counts;
  },
};

// ─── Goals ─────────────────────────────────────────────
export const goals = {
  async list(activeOnly = true): Promise<Goal[]> {
    let q = db.from('keeper_goals').select('*').order('created_at', { ascending: true }).limit(200);
    if (activeOnly) q = q.eq('status', 'active');
    const { data, error } = await q;
    if (error) fail('goals.list', error);
    return data as Goal[];
  },

  async create(input: {
    domain_id?: string | null;
    title: string;
    metric?: string | null;
    target_value?: number | null;
    unit?: string | null;
    deadline?: string | null;
    why?: string | null;
  }): Promise<Goal> {
    const { data, error } = await db
      .from('keeper_goals')
      .insert({
        domain_id: input.domain_id ?? null,
        title: input.title,
        metric: input.metric ?? null,
        target_value: input.target_value ?? null,
        unit: input.unit ?? null,
        deadline: input.deadline ?? null,
        why: input.why ?? null,
      })
      .select('*')
      .single();
    if (error) fail('goals.create', error);
    return data as Goal;
  },

  async update(
    id: string,
    patch: {
      title?: string;
      metric?: string | null;
      target_value?: number | null;
      unit?: string | null;
      deadline?: string | null;
      status?: string;
      why?: string | null;
    }
  ): Promise<Goal | null> {
    const { data, error } = await db
      .from('keeper_goals')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) fail('goals.update', error);
    return (data as Goal) ?? null;
  },

  /** Resolve a goal by full id or unambiguous prefix (ids in prompts get long). */
  async byIdPrefix(prefix: string): Promise<Goal | null> {
    const all = await this.list(false);
    const matches = all.filter((g) => g.id.startsWith(prefix));
    return matches.length === 1 ? (matches[0] as Goal) : null;
  },
};

// ─── Threads ───────────────────────────────────────────
// The "watching" ledger — open loops and forward-looking hypotheses about him.
// The agent reviews these every reflection and either closes them or escalates
// one into a touchpoint. This is anticipation made durable.
export const threads = {
  async list(openOnly = true): Promise<Thread[]> {
    let q = db
      .from('keeper_threads')
      .select('*')
      .order('next_check', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(200);
    if (openOnly) q = q.eq('status', 'open');
    const { data, error } = await q;
    if (error) fail('threads.list', error);
    return data as Thread[];
  },

  async create(input: {
    domain_id?: string | null;
    title: string;
    note?: string | null;
    next_check?: string | null;
  }): Promise<Thread> {
    const { data, error } = await db
      .from('keeper_threads')
      .insert({
        domain_id: input.domain_id ?? null,
        title: input.title,
        note: input.note ?? null,
        next_check: input.next_check ?? null,
      })
      .select('*')
      .single();
    if (error) fail('threads.create', error);
    return data as Thread;
  },

  async update(
    id: string,
    patch: { title?: string; note?: string | null; status?: string; next_check?: string | null }
  ): Promise<Thread | null> {
    const { data, error } = await db
      .from('keeper_threads')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) fail('threads.update', error);
    return (data as Thread) ?? null;
  },

  /** Resolve a thread by full id or unambiguous prefix (ids in prompts get long). */
  async byIdPrefix(prefix: string): Promise<Thread | null> {
    const all = await this.list(false);
    const matches = all.filter((t) => t.id.startsWith(prefix));
    return matches.length === 1 ? (matches[0] as Thread) : null;
  },
};

// ─── Digests ───────────────────────────────────────────
// One 'rolling' row: the distilled conversation that scrolled out of the
// context window, plus the anchor (covered_until) that defines the window edge.
export const digests = {
  async get(kind = 'rolling'): Promise<Digest | null> {
    const { data, error } = await db.from('keeper_digests').select('*').eq('kind', kind).maybeSingle();
    if (error) fail('digests.get', error);
    return (data as Digest) ?? null;
  },

  async set(kind: string, content: string, coveredUntilIso: string): Promise<void> {
    const { error } = await db
      .from('keeper_digests')
      .upsert(
        { kind, content, covered_until: coveredUntilIso, updated_at: new Date().toISOString() },
        { onConflict: 'kind' }
      );
    if (error) fail('digests.set', error);
  },
};
