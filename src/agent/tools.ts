import type Anthropic from '@anthropic-ai/sdk';
import { localDateString } from '../config.js';
import { domains, facts, touchpoints, interactions, journal } from '../db/repositories.js';
import {
  githubEnabled,
  deployPending,
  listSites,
  checkSiteStatus,
  renameSite,
  deleteSite,
} from '../deploy/github.js';
import { imageGenEnabled, generateImage } from '../generate/image.js';
import { generatePdf } from '../generate/pdf.js';
import { googleEnabled, getOAuth2Client as _auth } from '../integrations/google.js';
import { listEmails, readEmail, sendEmail } from '../integrations/gmail.js';
import { listDriveFiles, readDriveFile } from '../integrations/drive.js';

/**
 * The tools the orchestrator can call. The database is the agent's hands:
 * everything it knows and everything it plans lives in these calls.
 * (ToolUnion, not Tool: the last entry is Anthropic's server-side web search,
 * which executes inside the API — it never reaches dispatchTool.)
 */
export const toolDefinitions: Anthropic.Messages.ToolUnion[] = [
  {
    name: 'list_domains',
    description:
      'List all the life-sectors you currently track (slug, name, description, cadence). ' +
      'Call this when you need to know whether something the user mentioned fits an existing sector.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'recall_facts',
    description:
      'Read what you know about the user. Omit domain_slug to read everything, or pass a slug to focus on one sector.',
    input_schema: {
      type: 'object',
      properties: {
        domain_slug: { type: 'string', description: 'Optional sector slug to filter by.' },
      },
    },
  },
  {
    name: 'remember_fact',
    description:
      'Store or update something true about the user. Upserts on (domain, key): reuse an existing key to update it. ' +
      'Use concise, stable keys like "current_focus" or "side_business_name".',
    input_schema: {
      type: 'object',
      properties: {
        domain_slug: { type: 'string', description: 'Sector this fact belongs to.' },
        key: { type: 'string', description: 'Short stable identifier for the fact.' },
        value: { type: 'string', description: 'The fact itself.' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['domain_slug', 'key', 'value'],
    },
  },
  {
    name: 'create_domain',
    description:
      'Start tracking a brand-new sector of the user\'s life (a business, an interest, a relationship, anything). ' +
      'IMPORTANT: only call this AFTER the user has agreed they want you to track it. Ask first in conversation.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'lowercase_snake_case unique id, e.g. "sneaker_business".' },
        name: { type: 'string', description: 'Human-readable name, e.g. "Sneaker Resale Business".' },
        description: { type: 'string', description: 'What this sector covers and how you should treat it.' },
        cadence_hint: { type: 'string', description: 'Your note on how often to check in on this.' },
        priority: { type: 'number', description: '1 (high) to 5 (low). Default 3.' },
      },
      required: ['slug', 'name', 'description'],
    },
  },
  {
    name: 'schedule_touchpoint',
    description:
      'Schedule your OWN next proactive reach-out — how you stay alive between conversations. ' +
      'Use sparingly: only when nothing suitable is already pending, or when new information means the timing/topic must change. ' +
      'Do NOT add one after every message; aim to keep at most one sensible next touchpoint pending. Cancel-and-replace rather than stacking duplicates.',
    input_schema: {
      type: 'object',
      properties: {
        fire_at_iso: {
          type: 'string',
          description: 'When to reach out, as an ISO 8601 timestamp (UTC, e.g. 2026-06-08T06:30:00Z).',
        },
        domain_slug: { type: 'string', description: 'Optional sector this check-in relates to.' },
        reason: { type: 'string', description: 'Why you are reaching out / what you want to raise.' },
      },
      required: ['fire_at_iso', 'reason'],
    },
  },
  {
    name: 'cancel_touchpoint',
    description: 'Cancel a planned check-in by its id (e.g. it is no longer relevant).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'forget_fact',
    description:
      'Delete a stored fact that is stale, wrong, or superseded. Use during reflection to keep memory clean — ' +
      'a memory full of dead facts is worse than a small sharp one.',
    input_schema: {
      type: 'object',
      properties: {
        domain_slug: { type: 'string', description: 'Sector the fact lives in. Omit for general (no-domain) facts.' },
        key: { type: 'string', description: 'The fact key to delete.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'update_domain',
    description:
      "Update a sector you already track: refine its description or cadence as his life shifts, change its priority, " +
      "or set active=false to retire a sector that's gone dormant. Keeps your map of his life honest.",
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Sector to update.' },
        description: { type: 'string' },
        cadence_hint: { type: 'string' },
        priority: { type: 'number', description: '1 (high) to 5 (low).' },
        active: { type: 'boolean', description: 'false retires the sector.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'search_history',
    description:
      'Search EVERYTHING the two of you have ever said — your long-term episodic memory beyond the recent messages in view. ' +
      'Use it whenever he references something not in front of you ("that thing we discussed", a name, a plan, "last week"). ' +
      "Don't guess about the past when you can look it up. Provide query, around_date, or both.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words or "quoted phrases" to find (websearch syntax; -word excludes).',
        },
        around_date: {
          type: 'string',
          description: 'YYYY-MM-DD — instead of (or as well as) a query, pull the conversation from that day ±1 day.',
        },
      },
    },
  },
  {
    name: 'write_journal',
    description:
      "Write today's entry in your PRIVATE journal (he never sees it). Normally done once, during your nightly reflection: " +
      'a few honest lines on the state of him, what changed today, and what you are watching. Writing again the same day replaces the entry. ' +
      'Your latest entries are shown back to you every turn — this is your continuity of self.',
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The journal entry text.' },
      },
      required: ['entry'],
    },
  },
  {
    name: 'stay_silent',
    description:
      'End your turn WITHOUT sending the user a message. Use this when a due touchpoint turns out not to be worth ' +
      'interrupting them for — silence builds trust. You should usually still schedule a future touchpoint before going quiet.',
    input_schema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'Private note on why you stayed silent.' } },
    },
  },
  // ─── Website deployment (GitHub Pages) ───────────────────────────────────
  {
    name: 'deploy_html',
    description:
      'Publish the HTML file Philip most recently sent you to GitHub Pages. The repo is named after the ' +
      'uploaded filename (a numbered suffix is added if that name is taken — just report the final name/link). ' +
      'Returns the live URL. Pages takes ~30–60s to go live after deploy.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_sites',
    description: "List Philip's most recently created GitHub repositories (his deployed sites) with their live URLs.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_site_status',
    description: "Check whether a site's GitHub Pages build is live yet.",
    input_schema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository name.' } },
      required: ['repo'],
    },
  },
  {
    name: 'rename_site',
    description: 'Rename a repository (which also changes its Pages URL).',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current repo name.' },
        to: { type: 'string', description: 'New repo name.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'delete_site',
    description: 'Delete a repository permanently. Use to clean up empty/failed repos. Confirm with Philip first unless he clearly asked.',
    input_schema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository name to delete.' } },
      required: ['repo'],
    },
  },
  // ─── Gmail ────────────────────────────────────────────────────────────────
  {
    name: 'list_emails',
    description:
      "List Philip's recent emails. Use a Gmail search query to filter (e.g. 'is:unread', 'from:boss@example.com', 'subject:invoice'). Returns sender, subject, date, and a short snippet.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Gmail search query (default: 'in:inbox')." },
        max_results: { type: 'number', description: 'Max emails to return (default 10, max 20).' },
      },
    },
  },
  {
    name: 'read_email',
    description: 'Read the full body of a specific email by its message id (from list_emails).',
    input_schema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    name: 'send_email',
    description:
      "Send an email from Philip's Gmail account. Always confirm with him before sending unless he explicitly asked you to send it.",
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text email body.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  // ─── Google Drive ──────────────────────────────────────────────────────────
  {
    name: 'list_drive_files',
    description:
      "List files in Philip's Google Drive, most recently modified first. Optionally filter with a Drive query (e.g. \"name contains 'invoice'\", \"mimeType='application/pdf'\").",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Drive query string (optional).' },
        max_results: { type: 'number', description: 'Max files to return (default 15).' },
      },
    },
  },
  {
    name: 'read_drive_file',
    description:
      'Read the text content of a Google Drive file (Docs, Sheets, plain text, etc.) by its file id (from list_drive_files).',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
  },
  // ─── Media generation ─────────────────────────────────────────────────────
  {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt using Imagen 4 and send it to Philip as a photo. ' +
      'Write a detailed, vivid prompt — the more specific, the better the result.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
        filename: { type: 'string', description: 'Optional filename for the image (no extension needed).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_pdf',
    description:
      'Generate a PDF document and send it to Philip as a file. ' +
      'Use for reports, summaries, structured notes, plans — anything that benefits from a proper document format.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title (shown as the heading).' },
        body: { type: 'string', description: 'Full document body text. Use newlines for paragraphs.' },
        filename: { type: 'string', description: 'Optional filename (without .pdf extension).' },
      },
      required: ['title', 'body'],
    },
  },
  // ─── Web search (server-side — executes inside the Anthropic API) ─────────
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 4,
  },
];

export interface ToolResult {
  output: string;
  /** Set by stay_silent so the orchestrator knows not to send anything. */
  silent?: boolean;
}

async function resolveDomainId(slug: string | undefined): Promise<string | null> {
  if (!slug) return null;
  const d = await domains.getBySlug(slug);
  return d?.id ?? null;
}

/** Execute one tool call and return a string result for the model. */
export async function dispatchTool(
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case 'list_domains': {
      const list = await domains.list();
      if (list.length === 0) return { output: 'No domains yet.' };
      return {
        output: list
          .map(
            (d) =>
              `- ${d.slug} (${d.name}) [p${d.priority}] — ${d.description ?? 'no description'}` +
              (d.cadence_hint ? ` | cadence: ${d.cadence_hint}` : '')
          )
          .join('\n'),
      };
    }

    case 'recall_facts': {
      const slug = input.domain_slug as string | undefined;
      let rows;
      if (slug) {
        const d = await domains.getBySlug(slug);
        if (!d) return { output: `No domain with slug "${slug}".` };
        rows = await facts.byDomain(d.id);
      } else {
        rows = await facts.all();
      }
      if (rows.length === 0) return { output: 'No facts stored yet.' };
      // map domain ids back to slugs for readability
      const allDomains = await domains.list(true);
      const slugById = new Map(allDomains.map((d) => [d.id, d.slug]));
      return {
        output: rows
          .map(
            (f) =>
              `[${f.domain_id ? slugById.get(f.domain_id) ?? '?' : 'general'}] ${f.key}: ${f.value} (${f.confidence})`
          )
          .join('\n'),
      };
    }

    case 'remember_fact': {
      const domainId = await resolveDomainId(input.domain_slug as string);
      if (input.domain_slug && !domainId) {
        return {
          output: `No domain "${input.domain_slug}". Create it first (after asking the user) or use an existing one.`,
        };
      }
      const f = await facts.upsert({
        domain_id: domainId,
        key: input.key as string,
        value: input.value as string,
        confidence: (input.confidence as string) ?? 'medium',
      });
      return { output: `Remembered: ${f.key} = ${f.value}` };
    }

    case 'create_domain': {
      const existing = await domains.getBySlug(input.slug as string);
      if (existing) return { output: `Domain "${input.slug}" already exists.` };
      const d = await domains.create({
        slug: input.slug as string,
        name: input.name as string,
        description: input.description as string,
        cadence_hint: input.cadence_hint as string | undefined,
        priority: input.priority as number | undefined,
        created_by: 'agent',
      });
      return { output: `Created new sector "${d.slug}" (${d.name}). You can now store facts and touchpoints against it.` };
    }

    case 'schedule_touchpoint': {
      const domainId = await resolveDomainId(input.domain_slug as string);
      const fireAt = input.fire_at_iso as string;
      const parsed = new Date(fireAt);
      if (Number.isNaN(parsed.getTime())) {
        return { output: `Invalid fire_at_iso "${fireAt}". Use ISO 8601, e.g. 2026-06-08T06:30:00Z.` };
      }
      const tp = await touchpoints.create({
        fire_at: parsed.toISOString(),
        domain_id: domainId,
        reason: input.reason as string,
      });
      return { output: `Scheduled touchpoint ${tp.id} for ${tp.fire_at}: ${tp.reason}` };
    }

    case 'cancel_touchpoint': {
      await touchpoints.setStatus(input.id as string, 'cancelled');
      return { output: `Cancelled touchpoint ${input.id}.` };
    }

    case 'forget_fact': {
      const slug = input.domain_slug as string | undefined;
      let domainId: string | null = null;
      if (slug) {
        const d = await domains.getBySlug(slug);
        if (!d) return { output: `No domain with slug "${slug}".` };
        domainId = d.id;
      }
      const removed = await facts.remove(domainId, input.key as string);
      return {
        output: removed
          ? `Forgot fact "${input.key}".`
          : `No fact "${input.key}" found${slug ? ` in ${slug}` : ''} — nothing to forget.`,
      };
    }

    case 'update_domain': {
      const patch: { description?: string; cadence_hint?: string; priority?: number; active?: boolean } = {};
      if (typeof input.description === 'string') patch.description = input.description;
      if (typeof input.cadence_hint === 'string') patch.cadence_hint = input.cadence_hint;
      if (typeof input.priority === 'number') patch.priority = input.priority;
      if (typeof input.active === 'boolean') patch.active = input.active;
      if (Object.keys(patch).length === 0) return { output: 'Nothing to update — pass at least one field.' };
      const d = await domains.update(input.slug as string, patch);
      if (!d) return { output: `No domain with slug "${input.slug}".` };
      return { output: `Updated sector "${d.slug}"${patch.active === false ? ' (retired)' : ''}.` };
    }

    case 'search_history': {
      const query = (input.query as string | undefined)?.trim();
      const aroundDate = (input.around_date as string | undefined)?.trim();
      if (!query && !aroundDate) {
        return { output: 'Provide a query, an around_date, or both.' };
      }
      let rows;
      if (aroundDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(aroundDate)) {
          return { output: `around_date must be YYYY-MM-DD, got "${aroundDate}".` };
        }
        const from = new Date(`${aroundDate}T00:00:00Z`);
        from.setUTCDate(from.getUTCDate() - 1);
        const to = new Date(`${aroundDate}T00:00:00Z`);
        to.setUTCDate(to.getUTCDate() + 2);
        rows = await interactions.window(from.toISOString(), to.toISOString());
        if (query) {
          const q = query.toLowerCase();
          rows = rows.filter((r) => r.content.toLowerCase().includes(q));
        }
      } else {
        rows = await interactions.search(query!);
      }
      if (rows.length === 0) return { output: 'Nothing found in the archive for that.' };
      return {
        output: rows
          .map((r) => {
            const when = r.created_at.slice(0, 16).replace('T', ' ');
            const who = r.role === 'user' ? 'him' : 'you';
            const text = r.content.length > 400 ? r.content.slice(0, 400) + '…' : r.content;
            return `[${when} UTC] ${who}: ${text}`;
          })
          .join('\n'),
      };
    }

    case 'write_journal': {
      await journal.upsert('nightly', localDateString(), input.entry as string);
      return { output: 'Journal entry written.' };
    }

    case 'stay_silent': {
      return { output: 'Staying silent.', silent: true };
    }

    // ─── Website deployment ────────────────────────────────────────────────
    case 'deploy_html': {
      if (!githubEnabled()) return { output: 'Website deploy is not configured (missing GITHUB_TOKEN / GITHUB_USERNAME).' };
      return { output: JSON.stringify(await deployPending()) };
    }
    case 'list_sites': {
      if (!githubEnabled()) return { output: 'Website deploy is not configured.' };
      return { output: JSON.stringify(await listSites()) };
    }
    case 'check_site_status': {
      if (!githubEnabled()) return { output: 'Website deploy is not configured.' };
      return { output: JSON.stringify(await checkSiteStatus(input.repo as string)) };
    }
    case 'rename_site': {
      if (!githubEnabled()) return { output: 'Website deploy is not configured.' };
      return { output: JSON.stringify(await renameSite(input.from as string, input.to as string)) };
    }
    case 'delete_site': {
      if (!githubEnabled()) return { output: 'Website deploy is not configured.' };
      return { output: JSON.stringify(await deleteSite(input.repo as string)) };
    }

    // ─── Gmail ─────────────────────────────────────────────────────────────
    case 'list_emails': {
      if (!googleEnabled()) return { output: 'Gmail not configured (missing Google credentials).' };
      const emails = await listEmails(
        (input.query as string | undefined) ?? 'in:inbox',
        Math.min((input.max_results as number | undefined) ?? 10, 20)
      );
      if (emails.length === 0) return { output: 'No emails found.' };
      return {
        output: emails.map((e) =>
          `[${e.id}] ${e.date} | From: ${e.from} | Subject: ${e.subject}\n  ${e.snippet}`
        ).join('\n\n'),
      };
    }

    case 'read_email': {
      if (!googleEnabled()) return { output: 'Gmail not configured.' };
      const email = await readEmail(input.message_id as string);
      return {
        output: `From: ${email.from}\nDate: ${email.date}\nSubject: ${email.subject}\n\n${email.body}`,
      };
    }

    case 'send_email': {
      if (!googleEnabled()) return { output: 'Gmail not configured.' };
      const res = await sendEmail(input.to as string, input.subject as string, input.body as string);
      return { output: res.ok ? `Email sent (id: ${res.messageId}).` : `Failed to send: ${res.error}` };
    }

    // ─── Google Drive ───────────────────────────────────────────────────────
    case 'list_drive_files': {
      if (!googleEnabled()) return { output: 'Google Drive not configured.' };
      const files = await listDriveFiles(
        input.query as string | undefined,
        (input.max_results as number | undefined) ?? 15
      );
      if (files.length === 0) return { output: 'No files found.' };
      return {
        output: files.map((f) =>
          `[${f.id}] ${f.name} (${f.mimeType}) — modified ${f.modifiedTime}`
        ).join('\n'),
      };
    }

    case 'read_drive_file': {
      if (!googleEnabled()) return { output: 'Google Drive not configured.' };
      const res = await readDriveFile(input.file_id as string);
      return { output: res.ok ? `File: ${res.name}\n\n${res.content}` : `Error: ${res.error}` };
    }

    // ─── Media generation ──────────────────────────────────────────────────
    case 'generate_image': {
      if (!imageGenEnabled()) return { output: 'Image generation not configured (missing GEMINI_API_KEY).' };
      const result = await generateImage(input.prompt as string);
      if (!result.ok) return { output: `Image generation failed: ${result.error}` };
      const { enqueueMedia } = await import('../generate/queue.js');
      const rawName = ((input.filename as string | undefined) ?? 'image').replace(/[^a-z0-9_-]/gi, '_');
      enqueueMedia({ kind: 'photo', buffer: Buffer.from(result.pngBase64!, 'base64') });
      return { output: `Image generated successfully (${rawName}.png). It will be sent to Philip as a photo.` };
    }

    case 'generate_pdf': {
      const result = await generatePdf(input.title as string, input.body as string);
      if (!result.ok) return { output: `PDF generation failed: ${result.error}` };
      const { enqueueMedia } = await import('../generate/queue.js');
      const rawName = ((input.filename as string | undefined) ?? (input.title as string))
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'document';
      enqueueMedia({ kind: 'document', buffer: result.buffer!, filename: `${rawName}.pdf` });
      return { output: `PDF "${input.title}" generated successfully. It will be sent to Philip as a document.` };
    }

    default:
      return { output: `Unknown tool: ${name}` };
  }
}
