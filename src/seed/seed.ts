/**
 * Idempotent seed: core sectors + NEUTRAL facts only + one first touchpoint.
 * Sensitive health/personal items are intentionally NOT seeded — Philip tells
 * the agent those in conversation. Safe to run multiple times.
 *
 * Run with: npm run seed
 */
import { domains, facts, touchpoints } from '../db/repositories.js';

async function main() {
  console.log('[seed] ensuring core domains...');
  const core = [
    {
      slug: 'health',
      name: 'Health',
      description:
        'Body and wellbeing. Surgery prep, energy, exercise, anything physical. Calibrate pressure DOWN when he is low or in pain.',
      cadence_hint: 'gentle, only when there is a real reason',
      priority: 2,
    },
    {
      slug: 'social',
      name: 'Social',
      description:
        'Relationships and connection. He can be bad at initiating — gentle nudges help, nagging does not.',
      cadence_hint: 'follow up on commitments he mentioned',
      priority: 3,
    },
    {
      slug: 'create',
      name: 'Create',
      description:
        'The music and creative work. Matters because HE says it matters, not because it is productive. Presence, not pressure.',
      cadence_hint: 'awareness over time, never a guilt trip',
      priority: 2,
    },
    {
      slug: 'work',
      name: 'Work',
      description: 'Projects, clients, deadlines, meetings. Practical momentum.',
      cadence_hint: 'around deadlines and commitments',
      priority: 3,
    },
    {
      slug: 'general',
      name: 'General',
      description: 'Anything that does not yet have its own sector.',
      cadence_hint: 'as needed',
      priority: 4,
    },
  ];
  for (const d of core) {
    await domains.ensure({ ...d, created_by: 'seed' });
    console.log(`  ✓ ${d.slug}`);
  }

  const work = await domains.getBySlug('work');
  const create = await domains.getBySlug('create');
  const generalDomain = await domains.getBySlug('general');

  console.log('[seed] seeding neutral facts...');
  const neutral: Array<{ domain_id: string | null; key: string; value: string; confidence: string }> = [
    {
      domain_id: work!.id,
      key: 'active_projects',
      value: 'Dog Force ERP (paying client), YANGO, and freelance web work.',
      confidence: 'high',
    },
    {
      domain_id: work!.id,
      key: 'dog_force',
      value: 'Dog Force ERP is a paying client project.',
      confidence: 'high',
    },
    {
      domain_id: create!.id,
      key: 'music',
      value: 'Music is "the blade" — central to him, sharpened since age 13.',
      confidence: 'high',
    },
    {
      domain_id: create!.id,
      key: 'creative_writing_gap',
      value: 'Around 1 year 5 months since his last creative writing. Awareness only, no pressure.',
      confidence: 'medium',
    },
  ];
  for (const f of neutral) {
    await facts.upsert(f);
    console.log(`  ✓ ${f.key}`);
  }

  console.log('[seed] scheduling first proactive touchpoint...');
  const pending = await touchpoints.pending();
  const alreadySeeded = pending.some((t) => t.reason.includes('[seed:first-contact]'));
  if (alreadySeeded) {
    console.log('  • first-contact touchpoint already exists, skipping.');
  } else {
    const fireAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // ~2 min out
    await touchpoints.create({
      fire_at: fireAt,
      domain_id: generalDomain!.id,
      reason:
        '[seed:first-contact] First time reaching out. Introduce yourself warmly as his keeper, ' +
        'let him know what you already hold (his projects, the music), and ask one light open question to start getting to know him. ' +
        'Keep it short and human.',
    });
    console.log(`  ✓ first contact scheduled for ${fireAt}`);
  }

  console.log('[seed] done.');
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
