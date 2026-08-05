import type Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { localDateString } from '../config.js';
import {
  domains,
  facts,
  goals,
  observations,
  touchpoints,
  interactions,
  journal,
  portrait,
  threads,
} from '../db/repositories.js';
import { parseRecurrence, nextOccurrence, monthStartUtc } from './recurrence.js';
import { bus, type PresentCard } from '../web/bus.js';
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
import { listEmails, readEmail, sendEmail, createDraft } from '../integrations/gmail.js';
import { listDriveFiles, readDriveFile, createDriveFile, updateDriveFile } from '../integrations/drive.js';
import { fetchUrl } from '../integrations/web.js';
import { googleMapsDirUrl } from './route.js';

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
      'Cancel-and-replace rather than stacking duplicates. ' +
      'For something he wants EVERY week/day/month (a review, a report, a check-in he asked for), set recurrence to make it a STANDING RITUAL — it renews itself after each firing, forever, until cancelled.',
    input_schema: {
      type: 'object',
      properties: {
        fire_at_iso: {
          type: 'string',
          description:
            'When to reach out, as an ISO 8601 timestamp (UTC, e.g. 2026-06-08T06:30:00Z). ' +
            'Optional when recurrence is given — the first firing is computed from it.',
        },
        recurrence: {
          type: 'string',
          description:
            "Standing-ritual spec in LOCAL wall-clock time: 'daily@HH:MM', 'weekly:sun@HH:MM' (mon..sun), " +
            "'monthly:15@HH:MM' (day 1-28) or 'monthly:last@HH:MM'. Omit for a one-off.",
        },
        domain_slug: { type: 'string', description: 'Optional sector this check-in relates to.' },
        reason: {
          type: 'string',
          description:
            'Why you are reaching out / what you want to raise. For rituals, write it as standing instructions to your future self — it is re-read on every firing.',
        },
      },
      required: ['reason'],
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
  // ─── Life tracking: observations & goals ──────────────────────────────────
  {
    name: 'log_observation',
    description:
      'Record a MEASUREMENT about his life — an append-only time-series, the raw material of every trend and report. ' +
      'Log quietly whenever a number passes by in conversation: money in/out, weight, sleep hours, km run, hours worked, pages written, mood (1-10). ' +
      'Bank statement / transaction lines: one observation per meaningful line or category, with the REAL date in observed_at_iso and source "statement". ' +
      'Metric names are lowercase dot-namespaced and CONSISTENT — money.income, spend.food, spend.transport, balance.main, body.weight_kg, work.hours, mood. ' +
      'Reuse the metric names already in your "latest numbers" list; a renamed metric is a broken trend.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'lowercase dot.namespaced id, e.g. spend.food' },
        value: { type: 'number', description: 'The numeric value — use this for anything chartable.' },
        text_value: { type: 'string', description: 'Qualitative value, only when a number truly does not fit.' },
        unit: { type: 'string', description: 'e.g. NAD, kg, h, km' },
        observed_at_iso: {
          type: 'string',
          description: 'When it actually happened (ISO 8601). Defaults to now — set it for statement lines and past events.',
        },
        note: { type: 'string', description: 'Short context, e.g. "Checkers + Spar runs".' },
        source: { type: 'string', enum: ['chat', 'statement'] },
        domain_slug: { type: 'string' },
      },
      required: ['metric'],
    },
  },
  {
    name: 'query_observations',
    description:
      'Read the time-series you have logged. mode "latest" = newest value of every metric (full snapshot). ' +
      'mode "series" = raw points + sum/avg/min/max for one metric, optionally since a date. ' +
      'mode "monthly" = per-calendar-month sum/count/avg over the last N months — built for "compare this month to last month" reports. ' +
      'In series/monthly, a metric ending in "." is a prefix: "spend." covers every spend.* category at once. ' +
      '(sys.turn tracks your own running cost in USD — query it if he asks what you cost him.)',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['latest', 'series', 'monthly'] },
        metric: { type: 'string', description: 'Metric name, or prefix ending in "." (needed for series/monthly).' },
        since_iso: { type: 'string', description: 'series only: include points at/after this instant.' },
        months: { type: 'number', description: 'monthly only: how many months back (default 6, max 24).' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'log_statement',
    description:
      'Batch-log a parsed bank statement in ONE call, with deterministic reconciliation — use this instead of calling log_observation ' +
      'line-by-line for a statement. Give it every meaningful transaction line plus the statement\'s stated closing balance. ' +
      'It logs them all (skipping any line already logged before, so re-pasting an overlapping statement is safe), then checks in code — ' +
      'not in your head — whether the last known balance.main plus this period\'s net flow actually equals the new stated balance. ' +
      'Read the reconciliation result back to him honestly: if it matches, say so plainly; if it does not, say so and flag that a line ' +
      'was likely missed, mis-signed, or double-counted rather than asserting the numbers are fine.',
    input_schema: {
      type: 'object',
      properties: {
        period_label: { type: 'string', description: 'Optional label, e.g. "Statement 6–13 Jul".' },
        closing_balance: {
          type: 'number',
          description: "The statement's stated ending/available balance — ground truth to reconcile against, logged as balance.main.",
        },
        closing_balance_iso: {
          type: 'string',
          description: 'Date of the closing balance (YYYY-MM-DD). Defaults to the latest line date.',
        },
        lines: {
          type: 'array',
          description: 'One entry per meaningful transaction. amount is SIGNED: positive = money in, negative = money out.',
          items: {
            type: 'object',
            properties: {
              date_iso: { type: 'string', description: 'Real transaction date (YYYY-MM-DD).' },
              amount: { type: 'number', description: 'Signed amount: positive = income/credit, negative = spend/debit.' },
              metric: { type: 'string', description: 'e.g. money.income, spend.food, spend.transport.' },
              note: { type: 'string', description: 'Short description — merchant, or context like "Dog Force invoice".' },
              raw_ref: {
                type: 'string',
                description: 'Optional short excerpt of the original statement line — improves duplicate detection if this statement gets pasted again.',
              },
            },
            required: ['date_iso', 'amount', 'metric'],
          },
        },
      },
      required: ['closing_balance', 'lines'],
    },
  },
  {
    name: 'set_goal',
    description:
      'Create a tracked GOAL — something he is genuinely aiming at. Tie it to a metric + target_value + deadline whenever possible ' +
      'so progress is measurable against logged observations, not vibes. Only create goals he has clearly stated or agreed to — confirm first when unsure.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        domain_slug: { type: 'string' },
        metric: { type: 'string', description: 'Observation metric that measures this goal, e.g. body.weight_kg.' },
        target_value: { type: 'number' },
        unit: { type: 'string' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        why: { type: 'string', description: 'Why this matters to him, in his words — read it back to him when motivation dips.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_goal',
    description:
      'Update a goal by id (or unambiguous id prefix) from your context: adjust target/deadline as life shifts, or set status — ' +
      'active | paused | done | dropped. Mark done out loud (celebrate it); never silently drop a goal he cared about.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Goal id or prefix, from the goals list in your context.' },
        status: { type: 'string', enum: ['active', 'paused', 'done', 'dropped'] },
        title: { type: 'string' },
        metric: { type: 'string' },
        target_value: { type: 'number' },
        unit: { type: 'string' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        why: { type: 'string' },
      },
      required: ['id'],
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
    name: 'watch_thread',
    description:
      'Open a THREAD in your watching ledger — a forward-looking loop or hypothesis about him you want to keep an eye on and not let drop. ' +
      'These are the things you would otherwise put in a journal "watching" list, but tracked so you actually return to them: an awaited reply ' +
      '(Dr Wanda, a client payment), a decision with a closing window (a job deadline), a slow-developing situation (someone he is getting to know), ' +
      'or a pattern worth confirming over time. Set next_check to when it is worth looking again. Keep titles short and specific.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short specific name for the loop, e.g. "Dr Wanda reply to pause request".' },
        note: { type: 'string', description: 'What you are watching for and why it matters / what would close it.' },
        domain_slug: { type: 'string', description: 'Optional sector this relates to.' },
        next_check: { type: 'string', description: 'YYYY-MM-DD — when to look at this again. Omit if open-ended.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_thread',
    description:
      'Update a thread by id (or unambiguous id prefix) from your watching ledger: revise the note as things develop, push next_check out, ' +
      'or set status "closed" when the loop resolves (it landed, it died, or it no longer matters). Close threads out loud in your own notes — ' +
      'a ledger full of dead loops is noise. When a thread is ripe to actually raise with him, schedule_touchpoint it and note that here.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Thread id or prefix, from the watching ledger in your context.' },
        note: { type: 'string' },
        status: { type: 'string', enum: ['open', 'closed'] },
        next_check: { type: 'string', description: 'YYYY-MM-DD, or empty string to clear.' },
        title: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_portrait',
    description:
      'Rewrite your living PORTRAIT of him — the stable, evolving synthesis of who he is right now, the arc he is on, ' +
      'how to BE with him (posture, pressure, what lands and what does not), and what is load-bearing in his life. ' +
      'This is NOT a daily log — it is your continuous through-line, shown to you in full every turn. ' +
      'Normally revised once, during your nightly reflection: read the current portrait, fold in what today actually changed, ' +
      'and write the whole thing back — revise and compress, do not just append. Keep it ~200-400 words: a sharp lens, not a file. ' +
      'Write it as durable truth, not "today he…": the stuff that stays true across weeks.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The full revised portrait (replaces the previous one).' },
      },
      required: ['text'],
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
    name: 'draft_email',
    description:
      "Save an email as a DRAFT in Philip's Gmail — it lands in his Drafts folder for him to review and send himself, nothing goes out. " +
      'This is the PREFERRED way to handle "write/draft an email to X" — draft it, then tell him it\'s in his drafts to review. ' +
      'Only use send_email when he has clearly told you to actually send it.',
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
  {
    name: 'send_email',
    description:
      "Send an email from Philip's Gmail account immediately. Only use when he has explicitly told you to SEND it — " +
      'otherwise prefer draft_email so he reviews it first. Never send blind.',
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
      'Read the text content of a Google Drive file (Docs, Sheets, plain text, PDFs, etc.) by its file id (from list_drive_files).',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
  },
  {
    name: 'create_drive_file',
    description:
      "Create a new file in Philip's Google Drive with the given text content (e.g. a note, a plain-text doc, a CSV). Not for Google Docs/Sheets conversion — this writes a plain file of the given mime type.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name, e.g. "notes.txt".' },
        content: { type: 'string', description: 'Text content to write.' },
        mime_type: { type: 'string', description: "Mime type (default 'text/plain'), e.g. 'text/csv', 'text/markdown'." },
        folder_id: { type: 'string', description: 'Optional Drive folder id to create the file in (default: My Drive root).' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'update_drive_file',
    description: 'Overwrite the content of an existing Google Drive file by its file id (from list_drive_files).',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        content: { type: 'string', description: 'New text content, replacing the file entirely.' },
        mime_type: { type: 'string', description: "Mime type of the new content (default 'text/plain')." },
      },
      required: ['file_id', 'content'],
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
  // ─── Open web (client-side fetch — works on every model) ──────────────────
  {
    name: 'fetch_url',
    description:
      'Open a live web page and read its text — job listings, articles, company/career pages, docs, prices, anything with a URL. ' +
      'Use it whenever he pastes a link, or when you need to actually READ a page you found. Returns the page title and readable text. ' +
      'It does NOT run JavaScript, so heavily app-like or login-walled sites (notably LinkedIn and Indeed job pages) often return a block/login page instead of content — when that happens, say so and try a different source rather than guessing the content.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL to fetch.' },
      },
      required: ['url'],
    },
  },
  // ─── Errand route planning ─────────────────────────────────────────────────
  {
    name: 'plan_errand_route',
    description:
      'Turn the places he says he needs to go today into a single Google Maps link, for morning briefs or ' +
      'whenever he mentions several errands in one day. Just pass the place names/addresses in the order he ' +
      'mentioned them (or a sensible order from context) — Google Maps handles the actual turn-by-turn routing.',
    input_schema: {
      type: 'object',
      properties: {
        stops: {
          type: 'array',
          description: 'Place names or addresses, in visiting order.',
          items: { type: 'string' },
        },
        origin: { type: 'string', description: 'Where the day starts, e.g. "home". Optional.' },
      },
      required: ['stops'],
    },
  },
  // ─── Web search (server-side — executes inside the Anthropic API) ─────────
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 4,
  },
];

/**
 * The generative-UI tool. Only offered on web turns (the orchestrator appends
 * it when the surface has a screen). The model emits a compact JSON spec; the
 * browser owns the polished, animated components that render it — so a "view"
 * costs a few hundred output tokens, not a page of HTML.
 */
export const presentToolDefinition: Anthropic.Tool = {
  name: 'present',
  description:
    'Render a small visual card on his screen, alongside (never instead of) your text reply. ' +
    'Use ONLY when a visual genuinely helps — numbers, comparisons, lists, plans, schedules, search findings. ' +
    'Most replies need NO card; at most one per reply. Your text must stand alone without it (Telegram shows text only). ' +
    'Compose from these block types:\n' +
    '  {"type":"stat","label","value","delta"?,"hint"?} — one big number/fact\n' +
    '  {"type":"keyvals","pairs":[{"k","v"}]} — label/value rows\n' +
    '  {"type":"list","title"?,"items":[{"text","sub"?,"done"?}]} — checklist or plain list\n' +
    '  {"type":"timeline","items":[{"when","text"}]} — moments in order\n' +
    '  {"type":"progress","label","value":0-100,"hint"?} — a bar\n' +
    '  {"type":"spark","label","points":[numbers],"unit"?} — tiny trend line (use REAL logged numbers, oldest first)\n' +
    '  {"type":"links","items":[{"title","url","desc"?}]} — sources/sites\n' +
    '  {"type":"quote","text","by"?} — a pulled line\n' +
    '  {"type":"text","body"} — short prose\n' +
    'Keep it tight: a glance, not a webpage.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional small heading for the card.' },
      blocks: {
        type: 'array',
        description: 'The blocks to render, in order. 1–6 blocks.',
        items: { type: 'object' },
      },
    },
    required: ['blocks'],
  },
};

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
      const recRaw = (input.recurrence as string | undefined)?.trim().toLowerCase();
      let recurrence: string | null = null;
      if (recRaw) {
        if (!parseRecurrence(recRaw)) {
          return {
            output: `Invalid recurrence "${recRaw}". Use daily@HH:MM, weekly:sun@HH:MM (mon..sun), monthly:15@HH:MM (1-28), or monthly:last@HH:MM — local wall-clock time.`,
          };
        }
        recurrence = recRaw;
      }
      const fireAtIso = input.fire_at_iso as string | undefined;
      let fireAt = fireAtIso ? new Date(fireAtIso) : null;
      if ((!fireAt || Number.isNaN(fireAt.getTime())) && recurrence) {
        fireAt = nextOccurrence(recurrence);
      }
      if (!fireAt || Number.isNaN(fireAt.getTime())) {
        return {
          output: `Invalid fire_at_iso "${fireAtIso}". Use ISO 8601 (UTC, e.g. 2026-06-08T06:30:00Z), or give a recurrence and I'll compute the first firing.`,
        };
      }
      const tp = await touchpoints.create({
        fire_at: fireAt.toISOString(),
        domain_id: domainId,
        reason: input.reason as string,
        recurrence,
      });
      return {
        output:
          `Scheduled touchpoint ${tp.id} for ${tp.fire_at}` +
          (recurrence ? ` — standing ritual (${recurrence}), renews itself after each firing` : '') +
          `: ${tp.reason}`,
      };
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

    case 'update_portrait': {
      const text = String(input.text ?? '').trim();
      if (text.length < 40) return { output: 'Portrait too short — write the full revised synthesis, ~200-400 words.' };
      await portrait.set(text);
      return { output: 'Portrait updated — this is now the lens you read him through every turn.' };
    }

    case 'watch_thread': {
      const title = String(input.title ?? '').trim();
      if (!title) return { output: 'A thread needs a title.' };
      const nextCheck = (input.next_check as string | undefined)?.trim();
      if (nextCheck && !/^\d{4}-\d{2}-\d{2}$/.test(nextCheck)) {
        return { output: `next_check must be YYYY-MM-DD, got "${nextCheck}".` };
      }
      const domainId = await resolveDomainId(input.domain_slug as string | undefined);
      const effectiveNextCheck = nextCheck || new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const t = await threads.create({
        domain_id: domainId,
        title,
        note: (input.note as string | undefined)?.trim() || null,
        next_check: effectiveNextCheck,
      });
      const followUp = await touchpoints.create({
        fire_at: new Date(`${effectiveNextCheck}T10:00:00+02:00`).toISOString(),
        domain_id: domainId,
        reason: `[thread:${t.id}] Follow up on "${t.title}". If Philip has not brought it up, ask once what happened; encourage or help close the loop, then update or close the thread. Stay silent if it is clearly not worth interrupting him.`,
      });
      return {
        output: `Now watching [${t.id.slice(0, 8)}]: ${t.title} (next look ${t.next_check}; follow-up ${followUp.id.slice(0, 8)} is scheduled).`,
      };
    }

    case 'update_thread': {
      const t = await threads.byIdPrefix(String(input.id ?? '').trim());
      if (!t) return { output: `No single thread matches id "${input.id}" — use an id from the watching ledger in your context.` };
      const patch: Parameters<typeof threads.update>[1] = {};
      if (typeof input.title === 'string' && input.title.trim()) patch.title = input.title.trim();
      if (typeof input.note === 'string') patch.note = input.note.trim() || null;
      if (typeof input.status === 'string' && ['open', 'closed'].includes(input.status)) patch.status = input.status;
      if (typeof input.next_check === 'string') {
        const d = input.next_check.trim();
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { output: 'next_check must be YYYY-MM-DD (or empty to clear).' };
        patch.next_check = d || null;
      }
      if (Object.keys(patch).length === 0) return { output: 'Nothing to update — pass at least one field.' };
      const updated = await threads.update(t.id, patch);
      const tagged = (await touchpoints.pending()).filter((tp) => tp.reason.includes(`[thread:${t.id}]`));
      if (patch.status === 'closed') {
        await Promise.all(tagged.map((tp) => touchpoints.setStatus(tp.id, 'cancelled')));
      } else if (patch.next_check) {
        await Promise.all(tagged.map((tp) => touchpoints.setStatus(tp.id, 'cancelled')));
        await touchpoints.create({
          fire_at: new Date(`${patch.next_check}T10:00:00+02:00`).toISOString(),
          domain_id: updated?.domain_id ?? t.domain_id,
          reason: `[thread:${t.id}] Follow up on "${updated?.title ?? t.title}". If Philip has not brought it up, ask once what happened; encourage or help close the loop, then update or close the thread. Stay silent if it is clearly not worth interrupting him.`,
        });
      }
      return {
        output: `Thread [${t.id.slice(0, 8)}] updated${patch.status ? ` → ${patch.status}` : ''}: ${updated?.title ?? t.title}`,
      };
    }

    // ─── Life tracking ───────────────────────────────────────────────────────
    case 'log_observation': {
      const metric = String(input.metric ?? '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!/^[a-z0-9_.]{2,64}$/.test(metric)) {
        return { output: `Bad metric name "${input.metric}" — lowercase letters/digits/dots/underscores only, e.g. spend.food.` };
      }
      const value = typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : null;
      const textValue =
        typeof input.text_value === 'string' && input.text_value.trim() ? input.text_value.trim() : null;
      if (value === null && !textValue) return { output: 'Give a numeric value (preferred) or a text_value.' };
      let observedAt = new Date();
      if (typeof input.observed_at_iso === 'string' && input.observed_at_iso.trim()) {
        const d = new Date(input.observed_at_iso);
        if (Number.isNaN(d.getTime())) return { output: `Bad observed_at_iso "${input.observed_at_iso}".` };
        observedAt = d;
      }
      const domainId = await resolveDomainId(input.domain_slug as string | undefined);
      const o = await observations.log({
        domain_id: domainId,
        metric,
        value,
        text_value: textValue,
        unit: (input.unit as string | undefined)?.trim() || null,
        observed_at: observedAt.toISOString(),
        note: (input.note as string | undefined)?.trim() || null,
        source: input.source === 'statement' ? 'statement' : 'chat',
      });
      return {
        output: `Logged ${o.metric} = ${o.value ?? o.text_value}${o.unit ? ` ${o.unit}` : ''} @ ${o.observed_at.slice(0, 10)}`,
      };
    }

    case 'query_observations': {
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const fmt = (o: { value: number | null; text_value: string | null; unit: string | null }) =>
        `${o.value ?? o.text_value}${o.unit ? ` ${o.unit}` : ''}`;
      const mode = String(input.mode ?? 'latest');
      const metric = (input.metric as string | undefined)?.trim().toLowerCase();

      if (mode === 'latest') {
        const rows = await observations.latestPerMetric();
        if (rows.length === 0) return { output: 'No observations logged yet — log_observation starts the record.' };
        return {
          output: rows
            .map((o) => `${o.metric}: ${fmt(o)} (${o.observed_at.slice(0, 10)})${o.note ? ` — ${o.note}` : ''}`)
            .join('\n'),
        };
      }

      if (!metric) {
        return { output: `mode "${mode}" needs a metric — exact name, or a prefix ending in "." like "spend.".` };
      }

      if (mode === 'series') {
        const since = (input.since_iso as string | undefined)?.trim() || undefined;
        const rows = await observations.series(metric, since);
        if (rows.length === 0) return { output: `No observations for "${metric}"${since ? ` since ${since}` : ''}.` };
        const nums = rows.filter((r) => r.value !== null).map((r) => Number(r.value));
        const lines = rows
          .slice(-60)
          .map((o) => `${o.observed_at.slice(0, 10)} ${o.metric}: ${fmt(o)}${o.note ? ` — ${o.note}` : ''}`);
        const stats =
          nums.length > 0
            ? `— ${rows.length} points · sum ${round2(nums.reduce((a, b) => a + b, 0))} · avg ${round2(nums.reduce((a, b) => a + b, 0) / nums.length)} · min ${round2(Math.min(...nums))} · max ${round2(Math.max(...nums))}`
            : `— ${rows.length} points (qualitative)`;
        return { output: `${lines.join('\n')}\n${stats}` };
      }

      if (mode === 'monthly') {
        const months = Math.min(Math.max(Number(input.months ?? 6) || 6, 1), 24);
        const since = monthStartUtc(months - 1).toISOString();
        const rows = await observations.series(metric, since);
        if (rows.length === 0) return { output: `No observations for "${metric}" in the last ${months} months.` };
        const byMetric = new Map<string, Map<string, { sum: number; n: number }>>();
        for (const o of rows) {
          if (o.value === null) continue;
          const month = localDateString(new Date(o.observed_at)).slice(0, 7);
          const mm = byMetric.get(o.metric) ?? new Map<string, { sum: number; n: number }>();
          const cell = mm.get(month) ?? { sum: 0, n: 0 };
          cell.sum += Number(o.value);
          cell.n += 1;
          mm.set(month, cell);
          byMetric.set(o.metric, mm);
        }
        const out: string[] = [];
        for (const [met, mm] of [...byMetric.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          out.push(`${met}:`);
          for (const [month, c] of [...mm.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            out.push(`  ${month}: sum ${round2(c.sum)} · n ${c.n} · avg ${round2(c.sum / c.n)}`);
          }
        }
        return { output: out.join('\n') };
      }

      return { output: `Unknown mode "${mode}" — use latest, series, or monthly.` };
    }

    case 'log_statement': {
      const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
      if (rawLines.length === 0) return { output: 'No lines given — nothing to log.' };
      const closingBalance =
        typeof input.closing_balance === 'number' && Number.isFinite(input.closing_balance) ? input.closing_balance : null;
      if (closingBalance === null) return { output: 'closing_balance is required — the statement\'s stated ending balance.' };

      const hash = (parts: (string | number)[]) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);

      type Line = { date: Date; amount: number; metric: string; note: string | null; rawRef: string | null };
      const lines: Line[] = [];
      for (const raw of rawLines) {
        const metric = String(raw.metric ?? '').trim().toLowerCase().replace(/\s+/g, '_');
        if (!/^[a-z0-9_.]{2,64}$/.test(metric)) {
          return { output: `Bad metric name "${raw.metric}" in a statement line — lowercase letters/digits/dots/underscores only, e.g. spend.food.` };
        }
        const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : null;
        if (amount === null) return { output: `Line for "${metric}" is missing a numeric signed amount.` };
        const dateIso = typeof raw.date_iso === 'string' ? raw.date_iso.trim() : '';
        const d = dateIso ? new Date(dateIso) : null;
        if (!d || Number.isNaN(d.getTime())) return { output: `Bad or missing date_iso on a "${metric}" line.` };
        lines.push({
          date: d,
          amount,
          metric,
          note: (raw.note as string | undefined)?.trim() || null,
          rawRef: (raw.raw_ref as string | undefined)?.trim() || null,
        });
      }

      const firstLine = lines[0] as Line;
      const closingIso =
        typeof input.closing_balance_iso === 'string' && input.closing_balance_iso.trim()
          ? new Date(input.closing_balance_iso)
          : lines.reduce((latest, l) => (l.date > latest ? l.date : latest), firstLine.date);
      if (Number.isNaN(closingIso.getTime())) return { output: `Bad closing_balance_iso "${input.closing_balance_iso}".` };

      const periodLabel = (input.period_label as string | undefined)?.trim() || null;

      const rows = lines.map((l) => ({
        metric: l.metric,
        value: l.amount,
        observed_at: l.date.toISOString(),
        note: l.note,
        source: 'statement',
        external_ref: hash([l.metric, l.date.toISOString().slice(0, 10), l.amount, l.rawRef ?? l.note ?? '']),
      }));
      rows.push({
        metric: 'balance.main',
        value: closingBalance,
        observed_at: closingIso.toISOString(),
        note: periodLabel ?? 'statement closing balance',
        source: 'statement',
        external_ref: hash(['balance.main', closingIso.toISOString().slice(0, 10), closingBalance]),
      });

      const inserted = await observations.logBatch(rows);
      const skipped = rows.length - inserted.length;

      const round2 = (n: number) => Math.round(n * 100) / 100;
      const netFlow = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      const earliestLine = lines.reduce((earliest, l) => (l.date < earliest ? l.date : earliest), firstLine.date);
      const prior = await observations.latestBefore('balance.main', earliestLine.toISOString());

      let reconLine: string;
      if (prior?.value == null) {
        reconLine = `No prior balance.main before this statement — nothing to reconcile against yet. Closing balance ${round2(closingBalance)} becomes the new baseline.`;
      } else {
        const priorValue = Number(prior.value);
        const expected = round2(priorValue + netFlow);
        const diff = round2(closingBalance - expected);
        const matched = Math.abs(diff) < 0.01;
        reconLine = matched
          ? `Reconciled: prior balance ${round2(priorValue)} + net flow ${netFlow} = ${expected}, matches the stated closing balance ${round2(closingBalance)}.`
          : `Mismatch: prior balance ${round2(priorValue)} + net flow ${netFlow} = ${expected} expected, but the statement says ${round2(closingBalance)} (diff ${diff > 0 ? '+' : ''}${diff}). A line was likely missed, mis-signed, or double-counted — say so plainly, don't paper over it.`;
      }

      return {
        output:
          `Logged ${inserted.length} line(s)${skipped > 0 ? ` (${skipped} already logged, skipped as duplicates)` : ''} from ${lines.length} transaction(s) + closing balance${periodLabel ? ` — ${periodLabel}` : ''}.\n` +
          reconLine,
      };
    }

    case 'set_goal': {
      const title = String(input.title ?? '').trim();
      if (!title) return { output: 'Goal needs a title.' };
      const deadline = (input.deadline as string | undefined)?.trim();
      if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
        return { output: `deadline must be YYYY-MM-DD, got "${deadline}".` };
      }
      const domainId = await resolveDomainId(input.domain_slug as string | undefined);
      const g = await goals.create({
        domain_id: domainId,
        title,
        metric: (input.metric as string | undefined)?.trim().toLowerCase() || null,
        target_value: typeof input.target_value === 'number' ? input.target_value : null,
        unit: (input.unit as string | undefined)?.trim() || null,
        deadline: deadline || null,
        why: (input.why as string | undefined)?.trim() || null,
      });
      return {
        output:
          `Goal set [${g.id.slice(0, 8)}]: ${g.title}` +
          (g.target_value !== null ? ` → ${g.target_value}${g.unit ? ` ${g.unit}` : ''}` : '') +
          (g.deadline ? ` by ${g.deadline}` : ''),
      };
    }

    case 'update_goal': {
      const g = await goals.byIdPrefix(String(input.id ?? '').trim());
      if (!g) return { output: `No single goal matches id "${input.id}" — use an id from the goals list in your context.` };
      const patch: Parameters<typeof goals.update>[1] = {};
      if (typeof input.title === 'string' && input.title.trim()) patch.title = input.title.trim();
      if (typeof input.metric === 'string') patch.metric = input.metric.trim().toLowerCase() || null;
      if (typeof input.target_value === 'number' && Number.isFinite(input.target_value)) {
        patch.target_value = input.target_value;
      }
      if (typeof input.unit === 'string') patch.unit = input.unit.trim() || null;
      if (typeof input.deadline === 'string') {
        const d = input.deadline.trim();
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { output: 'deadline must be YYYY-MM-DD.' };
        patch.deadline = d || null;
      }
      if (
        typeof input.status === 'string' &&
        ['active', 'paused', 'done', 'dropped'].includes(input.status)
      ) {
        patch.status = input.status;
      }
      if (typeof input.why === 'string') patch.why = input.why.trim() || null;
      if (Object.keys(patch).length === 0) return { output: 'Nothing to update — pass at least one field.' };
      const updated = await goals.update(g.id, patch);
      return {
        output: `Goal [${g.id.slice(0, 8)}] updated${patch.status ? ` → ${patch.status}` : ''}: ${updated?.title ?? g.title}`,
      };
    }

    case 'present': {
      const blocks = input.blocks;
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return { output: 'present needs a non-empty blocks array.' };
      }
      const card: PresentCard = {
        title: typeof input.title === 'string' ? input.title : undefined,
        blocks: blocks.slice(0, 8),
      };
      bus.publish({ type: 'card', card });
      return { output: 'Card rendered on his screen. Write your reply as if the card may not be there.' };
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

    case 'draft_email': {
      if (!googleEnabled()) return { output: 'Gmail not configured.' };
      const res = await createDraft(input.to as string, input.subject as string, input.body as string);
      return {
        output: res.ok
          ? `Draft saved to his Gmail Drafts (id: ${res.draftId}). Tell him it's ready to review and send.`
          : `Failed to save draft: ${res.error}`,
      };
    }

    case 'send_email': {
      if (!googleEnabled()) return { output: 'Gmail not configured.' };
      const res = await sendEmail(input.to as string, input.subject as string, input.body as string);
      return { output: res.ok ? `Email sent (id: ${res.messageId}).` : `Failed to send: ${res.error}` };
    }

    // ─── Open web ──────────────────────────────────────────────────────────
    case 'fetch_url': {
      const res = await fetchUrl(input.url as string);
      if (!res.ok) return { output: `Couldn't read that page — ${res.error}` };
      return {
        output:
          (res.title ? `Title: ${res.title}\n` : '') +
          (res.url ? `URL: ${res.url}\n` : '') +
          `\n${res.text}` +
          (res.truncated ? '\n\n[…page truncated]' : ''),
      };
    }

    // ─── Errand route planning ─────────────────────────────────────────────
    case 'plan_errand_route': {
      const stops = (Array.isArray(input.stops) ? input.stops : [])
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (stops.length === 0) return { output: 'No stops given.' };
      const origin = (input.origin as string | undefined)?.trim() || undefined;
      const list = stops.map((s, i) => `${i + 1}. ${s}`).join('\n');
      return { output: `${list}\n\nGoogle Maps: ${googleMapsDirUrl(stops, origin)}` };
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

    case 'create_drive_file': {
      if (!googleEnabled()) return { output: 'Google Drive not configured.' };
      const res = await createDriveFile(
        input.name as string,
        input.content as string,
        (input.mime_type as string | undefined) ?? 'text/plain',
        input.folder_id as string | undefined
      );
      return { output: res.ok ? `Created "${res.name}" (id: ${res.id}).` : `Error: ${res.error}` };
    }

    case 'update_drive_file': {
      if (!googleEnabled()) return { output: 'Google Drive not configured.' };
      const res = await updateDriveFile(
        input.file_id as string,
        input.content as string,
        (input.mime_type as string | undefined) ?? 'text/plain'
      );
      return { output: res.ok ? `Updated "${res.name}".` : `Error: ${res.error}` };
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
