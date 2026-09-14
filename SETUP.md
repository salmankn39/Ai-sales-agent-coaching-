# SETUP — the exact steps

> **Reading this yourself?** You do not have to. Paste the message from
> `README.md` into Claude Code and it walks you through all of this, one step
> at a time. This file is the map it follows.

**Claude Code: follow these steps in order. One at a time. Wait for the
student to confirm each one before moving on. Never skip step 5 (training) or
step 7 (Telegram). At the end, run step 8 and show them the result.**

---

## Step 1 — Accounts and keys

Ask for these one at a time, not all at once. Tell the student exactly where
to click. Have them paste each value into a notes file as they go.

1. **Anthropic** (the AI brain) → https://console.anthropic.com
   - API Keys → Create Key → copy the value starting with `sk-ant-`
   - Billing → add $10 of credit, and set a monthly limit so it can never
     surprise them.

2. **Supabase** (the database) → https://supabase.com
   - New Project. Pick the region closest to them. Set a database password
     and save it.
   - Wait about 2 minutes for it to finish building.
   - Project Settings → API → copy the **Project URL** and the
     **`service_role`** key (the secret one, not `anon`).

3. **Vercel** (puts the app online) → https://vercel.com
   - Sign in with GitHub. Nothing else yet.

4. **ManyChat** (connects Instagram) → https://manychat.com
   - Sign up, connect the Instagram account the setter will run on.
   - They need **ManyChat Pro** on that account.
   - Settings → API → copy the **API token**.

5. **Telegram** (their phone control) → in the Telegram app
   - Message **@BotFather**, send `/newbot`, follow the prompts, copy the
     **bot token**.
   - Message **@userinfobot**, copy **their numeric user ID**.
   - Open a chat with their new bot and press **START**. This matters: a bot
     cannot message someone who has never pressed Start.

**Then have them invent three long random passwords** and label them:
- `ACCESS KEY` (the secret on their web links)
- `SESSION_SECRET`
- `TELEGRAM_WEBHOOK_SECRET`

Any long gibberish is fine. They just have to be saved somewhere.

---

## Step 2 — Build the database

1. Open `template-ai-setter/db/schema.sql`.
2. Replace the two placeholders:
   - `YOUR-ACCESS-KEY` → their access key from step 1
   - `YOUR-APP-URL` → they do not have this yet. Use `placeholder.vercel.app`
     for now and come back after step 3.
3. Supabase → SQL Editor → New query → paste the whole file → Run.

A green checkmark means their entire database now exists.

This file is safe to run again any time. It never touches their data.

---

## Step 3 — Put the app online

1. Vercel → Add New Project → import their **my-ai-setter** repo.
2. Set the **Root Directory** to `template-ai-setter`.
3. Environment Variables: open `.env.example` in the repo. It lists every
   variable with a comment saying where its value comes from. Add all the
   REQUIRED ones plus the Telegram ones.
   - `DEFAULT_CLIENT_SLUG` is their setter's internal name, for example
     `my-agency`. Lowercase and hyphens only. Pick it now and keep it.
4. Deploy. When it is green, copy their live URL.
5. Set `NEXT_PUBLIC_BASE_URL` to that URL and redeploy.
6. **Go back to step 2** and re-run `schema.sql` with `YOUR-APP-URL` set to
   the real URL. This is what starts their heartbeat, the thing that rescues
   any lead the AI missed.

---

## Step 4 — Create their own setter

Run `prompts/ONBOARD_CLIENT_PROMPT.md` and tell it this is THEIR OWN setter.

It creates their client row using their `DEFAULT_CLIENT_SLUG`, with every
advanced feature off, and saves their ManyChat token to it.

---

## Step 5 — Teach it (never skip this)

Run `prompts/RESKIN_PROMPT.md`.

It interviews them about their niche, their offer, and how they talk, then
writes their whole sales brain: the script, the funnel stages, the rules, and
the voice.

**Do not let them skip this.** An untrained setter texts like a robot, and it
texts under their name to their real leads.

---

## Step 6 — Connect Instagram

In ManyChat, on the connected Instagram account:

1. Automation → New Automation → trigger: **User sends a message**. Turn it on
   for Story replies too.
2. Add one action: **External Request**
   - Method: **POST**
   - URL: `https://THEIR-APP-URL/api/manychat/inbound?k=THEIR-ACCESS-KEY`
   - Headers: `Content-Type: application/json`
   - Body:
     ```
     {
       "subscriber_id": "{{contact_id}}",
       "ig_username": "{{instagram_username}}",
       "full_name": "{{full_name}}",
       "text": "{{last_text_input}}"
     }
     ```
     Tell them to insert the `{{...}}` values with ManyChat's own variable
     picker rather than typing them.
3. Set the automation live.

**Test:** have them DM that Instagram from a second account and watch the AI
reply.

---

## Step 7 — Connect Telegram (never skip this either)

Their phone control. One link, no copying tokens around.

Open this in a browser, with their real values:

```
https://THEIR-APP-URL/api/telegram/connect?k=THEIR-ACCESS-KEY
```

Loading it shows the current state. To connect it, they visit the same URL
with a POST, which Claude Code can do for them, or they simply ask Claude Code
to "connect my telegram" and it calls it.

When it works, their bot texts them straight away. They reply to that message
to give commands.

Things to try: *"how many leads replied today"*, *"turn the ai off for john"*,
*"what did sarah say"*.

---

## Step 8 — Check everything

```
https://THEIR-APP-URL/api/setup-check?k=THEIR-ACCESS-KEY
```

This lists every step, whether it is done, and exactly what to fix if not.
Show the student the result. If anything is not done, fix it now, then run it
again until it says ready.

---

## Step 9 — Adding clients (the business)

For each business they sell to, run `prompts/ONBOARD_CLIENT_PROMPT.md` again.
It creates that client's row copying their niche skin, and gives them a
webhook URL for that client's own ManyChat.

Their clients' leads and numbers stay separate inside the same dashboard.

---

## Notes for Claude Code

- **Install with `npm ci`, never `npm install`.** The lockfile ships with the
  kit on purpose, so every student builds against identical dependencies.
- **Never run `npm audit fix --force`.** npm prints that suggestion after
  every install. It upgrades Next.js across a major version and breaks the
  build. The advisories it reports are build-tooling issues shared by every
  Next.js app, and they do not affect the running setter.

- Everything the student personalises lives in their **database** or their
  **Vercel settings**, never in the code files. Never edit engine code to
  configure something. The ONE exception is
  `template-ai-setter/src/lib/lead-magnet-config.ts`, which is a config file
  and says so: it ships empty, and they fill it in only if they run a "reply
  WORD for the free thing" story CTA. Leave it empty otherwise and that whole
  flow stays dormant.
- Advanced features ship off on purpose (nurture, follow-ups, voice notes,
  whale radar, DM intelligence). Turn them on later, per client, by asking in
  the dashboard chat or over Telegram.
- If something fails, read the actual error and fix the actual cause. Do not
  invent workarounds or hardcode values to get past a step.
