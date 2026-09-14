# Build Your Own AI Setter

You are about to build an AI that lives in your Instagram DMs, talks to leads
like a real person, and books calls for you. Around the clock, without you.

**You will not write any code.** You will make a few accounts, then paste one
message into a free tool called Claude Code, and it does the building for you.

If you get stuck at any point, you copy the error, paste it in, and say
"fix this." That is not a workaround. That is how this is meant to work.

---

## What you will have when you finish

```
   Someone DMs your Instagram
              |
              v
   +----------------------+
   |   YOUR AI SETTER     |   reads it, thinks, replies in your voice
   +----------------------+
        |            |
        v            v
   Replies in     Books the
   the DMs        call
        |
        v
   +----------------------+
   |  Your phone (Telegram)|  "Just booked a call with Sarah for Thursday"
   +----------------------+
```

Three things, all yours:

1. **An AI setter in your Instagram DMs.** It answers every lead, asks the
   right questions, handles "how much is it" and "let me think about it," and
   books the call. It sounds like you, because you teach it your voice.
2. **A dashboard on the web.** Every lead, every conversation, every booking,
   and exactly what your AI costs you. You can also chat with it there.
3. **Telegram control on your phone.** You text it like a person:
   *"turn the ai off for john"*, *"how many did we book this week"*,
   *"what did sarah say"*. It answers and it obeys.

**One more thing:** once yours works, you sell this exact setup to businesses.
Each client you land is a few minutes of setup, and they get their own setter
inside your dashboard.

---

## Before you start: do you have Claude Code?

Claude Code is the AI that builds this for you. Here is the way we do it.
Please do it this way, not another way, so that everyone ends up in the same
place and can help each other.

1. Go to **https://claude.ai/download** and install the **Claude desktop app**
   for your computer (Mac or Windows).
2. Open it and sign in. You need a paid Claude plan for this.
3. In the app, find **Code** in the sidebar and open it.
4. Connect your **GitHub** account when it asks. (Do not have GitHub? Make a
   free account first at **https://github.com/signup**, then come back.)

That is it. You now have Claude Code. You do not need a terminal, and you do
not need any other coding app.

> **Never done anything like this?** Good. That is who this was written for.
> You are going to click buttons and paste things. Nothing more.

---

## Step 1: Make your own copy

1. Open the kit repo link your coach sent you.
2. Click the green **Use this template** button, then **Create a new repository**.
3. Name it **my-ai-setter**. Leave it Private. Click **Create**.

You now own a full copy. Nothing your coach does later can break yours.

---

## Step 2: Tell Claude Code to build it

In the Claude app, start a **new Code session** and pick your new
**my-ai-setter** repo.

Then copy the message in the box below, paste it into the chat, and send it.

```
Read README.md and SETUP.md in this repo, then walk me through the whole
setup one step at a time, doing every technical part for me.

Rules for you:
- I am not technical. Explain in plain English, no jargon.
- ONE step at a time. Wait for me to finish before giving me the next one.
- When you need a key or a link from me, ask for that one thing and tell me
  exactly where to click to find it.
- Do not skip the training step. Do not skip connecting Telegram.
- At the end, run the setup check and show me the result.

Start with step 1.
```

From here, just follow what it tells you. When it asks for something, get it,
paste it, and carry on.

---

## What Claude Code will walk you through

You do not need to memorise this. It is here so you know how far along you are.

| # | Step | What happens | Roughly |
|---|------|--------------|---------|
| 1 | Accounts | You sign up for the services below | 20 min |
| 2 | Database | One paste, and your database builds itself | 2 min |
| 3 | Go live | Your app goes on the internet | 5 min |
| 4 | Your setter | Your own setter gets created | 2 min |
| 5 | Teach it | It interviews you and writes your sales brain | 10 min |
| 6 | Instagram | Your DMs get connected | 10 min |
| 7 | Telegram | Your phone gets connected | 3 min |
| 8 | Check | It tells you if anything is missing | 1 min |

**About an hour, mostly waiting on sign-ups.**

---

## The accounts you need

Make these when Claude Code asks for them, not before. It tells you exactly
what to copy from each one.

| Service | What it does for you | Cost |
|---------|---------------------|------|
| [Anthropic](https://console.anthropic.com) | The AI brain | Pay per use. Start with $10 |
| [Supabase](https://supabase.com) | Stores your leads and chats | Free |
| [GitHub](https://github.com/signup) | Holds your copy | Free |
| [Vercel](https://vercel.com) | Puts your app online | Free |
| [ManyChat](https://manychat.com) | Connects your Instagram | About $15/mo, needs Pro |
| [Telegram](https://telegram.org) | Your phone control | Free |

> **Why ManyChat and not something else?** It is the cheapest reliable way to
> connect Instagram DMs, and it is the only way this kit supports. Everyone
> uses the same one so everyone can help each other.

---

## Am I done?

You do not have to guess. Your app checks itself.

Open this in your browser, using your own app address and your own access key:

```
https://YOUR-APP-URL/api/setup-check?k=YOUR-ACCESS-KEY
```

It tells you every step, whether it is done, and exactly what to do about
anything that is not. If you are unsure at any point, that page is the answer.

---

## Then what?

1. **Test it yourself.** DM your own Instagram from a friend's account or a
   second account. Watch your AI reply.
2. **Text your bot.** Try *"how many leads did we get today"*.
3. **Get your first client.** Run the onboard prompt in Claude Code and it
   walks you through adding a business you are selling to. They connect their
   own Instagram. It takes minutes.

---

## Getting unstuck

Almost every problem is solved the same way: **paste it into Claude Code and
say "fix this."** Give it the exact error, or a screenshot of the screen you
are stuck on.

If something is not working and you do not know why, open the
`/api/setup-check` link above first. It usually names the problem for you.

---

## The files in here

| File | What it is |
|------|-----------|
| `README.md` | This page. Start here. |
| `SETUP.md` | The detailed steps, for Claude Code to follow |
| `prompts/RESKIN_PROMPT.md` | Teaches your setter your niche and your voice |
| `prompts/ONBOARD_CLIENT_PROMPT.md` | Adds a client business you are selling to |
| `BUILD_MANIFEST.md` | What is in the product, and what you control |
| `template-ai-setter/` | The actual system. You never need to open this. |
