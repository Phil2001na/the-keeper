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
  created_at: string;
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
  }): Promise<Touchpoint> {
    const { data, error } = await db
      .from('keeper_touchpoints')
      .insert({ fire_at: input.fire_at, domain_id: input.domain_id, reason: input.reason })
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
