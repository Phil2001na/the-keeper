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
  created_at: string;
}

export interface Interaction {
  id: string;
  role: 'user' | 'agent';
  content: string;
  trigger: string | null;
  created_at: string;
}

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
};

// ─── Interactions ──────────────────────────────────────
export const interactions = {
  async recent(limit: number): Promise<Interaction[]> {
    const { data, error } = await db
      .from('keeper_interactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) fail('interactions.recent', error);
    // return oldest → newest for natural conversation order
    return (data as Interaction[]).reverse();
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
