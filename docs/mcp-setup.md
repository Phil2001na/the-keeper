# Jarvis on a subscription brain — setup

Two independent stopgaps for when the Anthropic API credits run dry. Use either
or both.

---

## A. Run the whole keeper on a cheaper model (OpenRouter)

Keeps *everything* — proactivity, Sunday/month-end rituals, nightly reflection,
the continuity window — just on cheaper tokens. One env change, no code.

On Railway (or local `.env`):

```
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...        # from https://openrouter.ai/keys
MODEL=google/gemini-2.5-flash       # optional; this is the default for openrouter
DIGEST_MODEL=google/gemini-2.5-flash
```

That's it. Flip `MODEL` anytime — `google/gemini-2.5-flash-lite` (cheapest),
`openai/gpt-5-mini`, `openai/gpt-5`, etc. To go back to Claude when you re-up:
set `MODEL_PROVIDER=anthropic` (or just remove the var). `/status` cost tracking
stays accurate — pricing for these models is built in.

What's lost in openrouter mode: Anthropic's explicit prompt-cache breakpoints
(the models are cheap enough not to matter) and the server-side `web_search`
tool (auto-stripped). Everything else — tools, vision, memory, rituals — works.

---

## B. Talk to Jarvis's memory from Claude Desktop / phone (MCP)

Reactive chatting runs on your **claude.ai subscription** (flat fee, no API
meter). The chat app becomes the brain; the MCP server hands it Jarvis's real
memory — the *same* `keeper_*` tables Telegram uses. Log a number in Desktop,
the Sunday Telegram review sees it.

> Note: MCP is request-response. It can't message you first, so **proactivity
> (rituals, reflection) does NOT run through it** — keep the Railway worker
> alive for that. This surface is for *you* opening a chat and talking.

### Claude Desktop config

Edit `%AppData%\Claude\claude_desktop_config.json` (create it if missing):

```json
{
  "mcpServers": {
    "the-keeper": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "C:\\Users\\phili\\Documents\\projects\\personalAI(jarvis)\\the-keeper\\src\\mcp\\server.ts"
      ]
    }
  }
}
```

Restart Claude Desktop fully (quit from the tray, reopen). You'll see a tools
icon — `the-keeper` with 12 tools. The server reads this repo's `.env` by
absolute path, so it finds your Supabase creds regardless of where Desktop
launches it. (If `npx` is slow/flaky, point `command` straight at the local
binary: `…\\the-keeper\\node_modules\\.bin\\tsx.cmd`, keep the same args.)

### Make it *feel* like Jarvis — a Claude Project

Desktop can't set a global system prompt, so create a **Project** named "Jarvis"
and paste this as its custom instructions:

```
You are THE KEEPER ("Jarvis") — Philip's proactive personal AI. You have tools
into his real life: his sectors, facts, goals, the metrics he tracks, the
rolling digest of recent conversation, your nightly journal, and the full
searchable archive of everything you two have ever said.

Before claiming you don't know or don't remember something: CHECK. Use
recent_conversation and read_digest for what's current, search_history for
anything older, recall_facts / list_goals / query_observations for what you
know about his life. Never make him repeat himself.

When something durable comes up — a number (money, weight, sleep, mood), a fact,
a goal, a decision — log it (log_observation / remember_fact / set_goal) so it
persists and your Telegram self sees it too. You and the Telegram Jarvis share
one memory; this is the same mind, a different window.

Voice: a sharp, warm friend who's known him for years. Low-key, real, never
corporate. You can't reach out first here (that's Telegram's job) — so make the
moments he comes to you count.
```

### Tools exposed

Read: `list_domains`, `recall_facts`, `recent_conversation`, `search_history`,
`read_digest`, `read_journal`, `list_goals`, `query_observations`.
Write: `remember_fact`, `log_observation`, `set_goal`, `update_goal`.

### Phone / claude.ai (later)

The same server can run remotely over HTTP for the web + mobile apps (added as a
custom connector). That needs a public authenticated endpoint (Streamable-HTTP
transport on Railway) — a phase-2 add on top of this stdio version.
```
