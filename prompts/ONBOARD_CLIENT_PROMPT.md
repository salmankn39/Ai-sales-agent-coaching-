# ONBOARD A CLIENT — add a business you're selling the setter to

Run this once per business (client) you put the setter live for. It adds them
to your database, inherits your niche skin, and gives you their exact Instagram
hookup. ~5 minutes of you + ~10 minutes of them connecting their Instagram to
ManyChat.

**How to use:** open your repo in Claude Code and paste the box below as one
message. Answer its questions.

---

```
You are onboarding a client onto my AI setter platform. Each client is one row
in the `clients` table. Inbound Instagram DMs route to the right client by the
`client_slug` parameter on the ManyChat webhook URL; a URL without one goes to
my own default client (my DEFAULT_CLIENT_SLUG env). Do NOT change engine code.

FIRST-TIME / OWN SETTER: if I tell you this is MY OWN setter (my first row),
set the slug to my DEFAULT_CLIENT_SLUG env value, use MY ManyChat token, and in
STEP 2 choose neither copy nor reskin — create the row with EMPTY skin (I'll
run the reskin prompt next). My webhook URL then needs NO client_slug on it.

STEP 0 — Read src/lib/supabase.ts for the `clients` columns so you write valid
data.

STEP 1 — Collect these from me (ask for any I don't give, one short list):
- Business name (display) — e.g. "Bright Kitchens Co"
- slug — lowercase-hyphens, auto-make one from the name if I don't say
- ManyChat API token for THEIR Instagram (they create a ManyChat Pro account,
  connect their IG, then Settings → API → copy the token)
- Timezone — default to mine if unknown
- Their specifics for business_context: the exact offer, hours, booking link,
  and anything unique to THIS business (name, location, any promo).
- OPTIONAL, only if they use GoHighLevel as their CRM: their GHL Location ID +
  Private Integration token (pit-...) + booking calendar id. Skip freely —
  the setter runs fully without GHL.

STEP 2 — Decide the skin (ask me which):
  (A) SAME niche as my other clients (default): inherit my niche skin. Copy
      system_prompt, active_rules, voice_samples, stages, and pain_protocol
      FROM my own row (slug = my DEFAULT_CLIENT_SLUG) into the new row, and
      write a fresh business_context from this client's specifics above.
  (B) DIFFERENT niche: tell me, and we'll run the RESKIN flow for this client
      instead of copying.

STEP 3 — Create the client row.
- If Supabase is connected (MCP): insert the row. For option (A), read my own
  row's skin fields and copy them; set name, slug, manychat_api_token,
  timezone, the new business_context, is_active=true, the optional GHL fields
  if given (ghl_location_id, ghl_api_key, ghl_calendar_id), and leave ALL
  feature flags at their default OFF (nurture_enabled, followup_enabled,
  dm_intel_enabled, pain_dig_enabled, voice_enabled, whale_radar_enabled =
  false).
- If Supabase is NOT connected: output the full INSERT (or INSERT ... SELECT
  that copies my own skin) as one SQL block for me to run in Supabase → SQL
  Editor. Use dollar-quoting ($$...$$) for text fields.
- Then verify: select id, name, slug, is_active from clients
  where slug = '<new-slug>';

STEP 4 — Give me THIS client's ManyChat hookup, ready to hand to them.
Their ManyChat automation (on THEIR connected Instagram): trigger "User sends
a message", one External Request action:
  Method:  POST
  URL:     https://MY-LIVE-URL/api/manychat/inbound?k=MY-ACCESS-KEY&client_slug=<new-slug>
           (ask me for my live URL; tell me to fill in my access key myself —
           do not print it if you know it)
  Headers: Content-Type: application/json
  Body:    { "subscriber_id": "{{contact_id}}",
             "ig_username": "{{instagram_username}}",
             "full_name": "{{full_name}}",
             "text": "{{last_text_input}}" }
  (the {{...}} are ManyChat's own variables, inserted with its picker)

STEP 5 — Smoke test. Give me this command (swap in real values) and tell me a
JSON `reply` means the brain answers for this client:
  curl -X POST https://MY-LIVE-URL/api/test \
    -H "Content-Type: application/json" \
    -d '{"message":"hey is this you","client_slug":"<new-slug>","session_id":"smoke"}'

STEP 6 — End with this checklist:
  [ ] Client row created + verified
  [ ] Their Instagram connected to their ManyChat (Pro)
  [ ] Their ManyChat automation added with the URL above, set live
  [ ] Smoke test returned a reply
  [ ] Live test: DM their Instagram from another account
  [ ] Watch one real conversation before walking away

Rules for you: never invent a token or id — if I don't have one, stop and tell
me where to get it. Never hardcode anything in code. State sensible defaults
(timezone, channel=instagram) and proceed.
```

---

## Notes

- **Every key lives in the client's database row, never in code or env** —
  that's why adding a client never touches the deployment.
- Every client ships with the advanced features **OFF**. Turn them on per
  client in HQ chat, e.g. "turn follow-ups on for Bright Kitchens."
- Removing a client: set `is_active=false` (pauses replies) or delete the row.
- GHL is optional per client. If they use it, fill the three GHL fields on
  their row later and the CRM sync lights up by itself.
