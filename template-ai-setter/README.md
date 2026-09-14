# AI Setter

Your 24/7 AI DM appointment setter. Lives in Instagram DMs via ManyChat.
Speaks in your voice. Obeys your rules. Books calls.

---

## The 30-second tour

```
Instagram DM → ManyChat → this app → Claude AI →
this app → ManyChat → Instagram DM (reply sent)
```

Every lead, message and number is logged in Supabase. Your database also runs
the heartbeat: every 5 minutes it wakes this app to rescue unanswered leads,
send follow-ups and deliver lead magnets. You train the AI by editing data,
never code.

---

## The training surface (per client)

Each business you run the setter for is one row in the `clients` table. The
fields that make it THEIRS:

1. **`system_prompt`** — the selling brain. SOP, tone, what to do.
2. **`voice_samples`** — real DMs in the right voice. The AI clones it.
3. **`active_rules`** — plain-English rules. "never say lol", etc.
4. **`business_context`** — offer, prices, links, hours. The only facts the
   AI may state.
5. **`stages`** — the funnel, step by step, with what qualifies and what
   disqualifies.

The engine is identical for everyone; these five fields are the product you
sell. Fill them with the RESKIN prompt, never by hand from scratch.

---

## Where things are

- `db/schema.sql` — one-shot database setup (paste into Supabase SQL Editor).
- `.env.example` — every environment variable, annotated.
- `/usage` — where every AI cent went, per client.
- `/dashboard` + `/hq` — the control room.
- `/api/manychat/inbound?k=KEY[&client_slug=SLUG]` — the front door each
  client's ManyChat posts to.

This folder is GENERATED from the live engine. Don't hand-edit engine files —
your edits would be overwritten by the next kit update, and everything you
own lives in the database and env anyway.
