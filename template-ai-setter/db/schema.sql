-- ============================================================================
-- AI SETTER — ONE-SHOT DATABASE SETUP
-- ============================================================================
-- GENERATED from the live production schema on 2026-08-21. Do not edit by
-- hand: when the engine's schema changes, this file is regenerated with it.
--
-- HOW TO USE (you do this ONCE, ~2 minutes):
--   1. In your Supabase project, open SQL Editor -> New query.
--   2. FIRST: find-and-replace both placeholders below:
--        YOUR-APP-URL      -> your Vercel app URL (e.g. my-setter.vercel.app)
--        YOUR-ACCESS-KEY   -> a long random string you invent (this becomes
--                             the ?k= secret on every webhook URL - treat it
--                             like a password)
--   3. Paste this whole file and press Run. Green checkmark = done.
--
-- Everything is `if not exists` / `or replace`, so re-running it later (after
-- a kit update) is always safe and never touches your data.
-- ============================================================================

-- Extensions: pg_cron + pg_net drive the platform's heartbeat (the 5-minute
-- ticks that rescue unanswered leads, send follow-ups and lead magnets).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── TABLES ──────────────────────────────────────────────────────────────────
create table if not exists public.ai_decisions (
  id uuid default gen_random_uuid() not null,
  lead_id uuid not null,
  client_id uuid not null,
  message_id uuid,
  system_prompt_used text not null,
  conversation_context jsonb not null,
  raw_response text not null,
  final_reply text,
  duration_ms integer,
  error text,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.ai_usage (
  id bigint not null,
  occurred_at timestamp with time zone default now() not null,
  model text not null,
  action text default 'other'::text not null,
  student_id bigint,
  input_tokens integer default 0 not null,
  output_tokens integer default 0 not null,
  cache_read_tokens integer default 0 not null,
  cache_write_tokens integer default 0 not null,
  cost_usd numeric(12,6) default 0 not null,
  primary key (id)
);

create table if not exists public.audit_events (
  id bigint not null,
  session_id text not null,
  stage text not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.audit_rate_limit (
  id uuid default gen_random_uuid() not null,
  ip text not null,
  route text not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.audit_usage (
  id bigint not null,
  kind text not null,
  model text not null,
  input_tokens bigint default 0 not null,
  output_tokens bigint default 0 not null,
  cache_write_tokens bigint default 0 not null,
  cache_read_tokens bigint default 0 not null,
  cost_usd numeric(12,6) default 0 not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.audits (
  id uuid default gen_random_uuid() not null,
  name text,
  email text,
  phone text,
  taps jsonb,
  history jsonb,
  map jsonb,
  built jsonb default '[]'::jsonb,
  created_at timestamp with time zone default now() not null,
  session_id text,
  stage text,
  website text,
  primary key (id)
);

create table if not exists public.banned_contacts (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  ghl_contact_id text,
  ig_username text,
  ig_sender_id text,
  full_name text,
  reason text,
  banned_by text default 'telegram'::text,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  unbanned_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.brain_library (
  name text not null,
  content text default ''::text not null,
  updated_at timestamp with time zone default now() not null,
  primary key (name)
);

create table if not exists public.call_outcomes (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  lead_id uuid,
  ghl_contact_id text,
  showed boolean default false not null,
  pitched boolean default false not null,
  closed boolean default false not null,
  outcome text not null,
  customer_id uuid,
  logged_by text,
  note text,
  created_at timestamp with time zone default now(),
  reason text,
  call_duration_minutes integer,
  primary key (id)
);

create table if not exists public.clients (
  id uuid default gen_random_uuid() not null,
  name text not null,
  slug text not null,
  ghl_location_id text,
  ghl_api_key text,
  system_prompt text default ''::text not null,
  voice_samples text default ''::text not null,
  active_rules text default ''::text not null,
  business_context text default ''::text not null,
  is_active boolean default true not null,
  timezone text default 'UTC'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  stages jsonb default '[]'::jsonb not null,
  ghl_calendar_id text,
  reply_delay_min_seconds integer,
  reply_delay_max_seconds integer,
  setter_resume_at timestamp with time zone,
  nurture_enabled boolean default false not null,
  nurture_enabled_at timestamp with time zone,
  followup_enabled boolean default false not null,
  followup_enabled_at timestamp with time zone,
  dm_intel_enabled boolean default false not null,
  pain_dig_enabled boolean default false not null,
  pain_protocol text,
  voice_enabled boolean default false not null,
  setter_voice_id text,
  setter_voice_id_sv text,
  whale_radar_enabled boolean default false not null,
  manychat_api_token text,
  manychat_page_id text,
  voice_enabled_sv boolean default false not null,
  setter_notify_enabled boolean default false not null,
  setter_notify_off jsonb default '[]'::jsonb not null,
  voice_settings jsonb,
  reactivation_playbook text default ''::text not null,
  primary key (id)
);

create table if not exists public.clip_jobs (
  id uuid default gen_random_uuid() not null,
  card_id uuid not null,
  params jsonb default '{}'::jsonb not null,
  status text default 'queued'::text not null,
  result jsonb,
  error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.clipper_jobs (
  id uuid default gen_random_uuid() not null,
  card_id uuid not null,
  status text default 'queued'::text not null,
  stage text,
  video jsonb,
  result jsonb,
  error text,
  claimed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.content_pipeline (
  id uuid default gen_random_uuid() not null,
  title text not null,
  idea text,
  angle text,
  status text default 'backlog'::text not null,
  source text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  funnel text default 'youtube'::text not null,
  "position" double precision default 0 not null,
  make_status text,
  make_requested_at timestamp with time zone,
  make_error text,
  script_url text,
  doc_url text,
  youtube_url text,
  perf_views bigint,
  perf_retention double precision,
  perf_cash double precision,
  perf_updated_at timestamp with time zone,
  research_text text,
  video_id text default ('vid_'::text || replace((gen_random_uuid())::text, '-'::text, ''::text)),
  youtube_video_id text,
  format text,
  perf_likes bigint,
  perf_comments bigint,
  audience_level text,
  reference_url text,
  edit_brief text,
  primary key (id)
);

create table if not exists public.customers (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  name text not null,
  lead_id uuid,
  ghl_contact_id text,
  created_at timestamp with time zone default now() not null,
  contract_value numeric,
  currency text default 'USD'::text,
  closer text,
  closed_at timestamp with time zone,
  status text default 'active'::text,
  note text,
  source text,
  campaign text,
  placement text,
  booking_method text,
  source_video_id text,
  email text,
  primary key (id)
);

create table if not exists public.dashboard_columns (
  id bigint not null,
  dashboard_id bigint not null,
  col_key text not null,
  label text not null,
  short text,
  kind text default 'count'::text not null,
  "position" integer default 0 not null,
  tier text default 'core'::text not null,
  stage text,
  primary key (id)
);

create table if not exists public.dashboard_kpis (
  id bigint not null,
  dashboard_id bigint not null,
  label text not null,
  num_key text not null,
  den_key text not null,
  kind text default 'percent'::text not null,
  "position" integer default 0 not null,
  description text,
  primary key (id)
);

create table if not exists public.dashboard_reads (
  start_date date not null,
  end_date date not null,
  payload jsonb not null,
  created_at timestamp with time zone default now() not null,
  primary key (start_date, end_date)
);

create table if not exists public.dashboard_templates (
  id bigint not null,
  name text not null,
  columns jsonb default '[]'::jsonb not null,
  kpis jsonb default '[]'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.dm_intel_reports (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  trigger text default 'manual'::text not null,
  summary text,
  findings jsonb default '[]'::jsonb not null,
  sample jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  method text,
  primary key (id)
);

create table if not exists public.dm_suggestions (
  id uuid default gen_random_uuid() not null,
  report_id uuid not null,
  client_id uuid not null,
  title text not null,
  finding text,
  evidence text,
  proposed_change text,
  target text,
  confidence text,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  why_best text,
  expected_impact text,
  primary key (id)
);

create table if not exists public.dm_thread_openers (
  client_id uuid not null,
  ghl_contact_id text not null,
  opened_by text not null,
  display_name text,
  reason text,
  decided_by text,
  decided_at timestamp with time zone default now() not null,
  primary key (client_id, ghl_contact_id)
);

create table if not exists public.event_types (
  event_type text not null,
  category text not null,
  is_money boolean default false not null,
  description text,
  created_at timestamp with time zone default now() not null,
  primary key (event_type)
);

create table if not exists public.events (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  lead_id uuid,
  event_type text not null,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  amount numeric,
  currency text,
  video_id text,
  source_system text default 'unknown'::text,
  customer_id uuid,
  payment_id uuid,
  dedupe_key text,
  primary key (id)
);

create table if not exists public.follow_up_log (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  lead_id uuid not null,
  ghl_contact_id text,
  bucket text not null,
  attempt integer not null,
  anchor timestamp with time zone not null,
  stage_at_stall text,
  status text default 'sending'::text not null,
  message text,
  ghl_message_id text,
  sent_at timestamp with time zone default now(),
  revived_at timestamp with time zone,
  recovered_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.idea_queue (
  id uuid default gen_random_uuid() not null,
  status text default 'pending'::text not null,
  requested_by text,
  queued_at timestamp with time zone default now() not null,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  error text,
  primary key (id)
);

create table if not exists public.inbound_outcomes (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  lead_id uuid not null,
  message_id uuid not null,
  status text default 'open'::text not null,
  reason text,
  created_at timestamp with time zone default now() not null,
  closed_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.intel_digests (
  slug text not null,
  label text default ''::text not null,
  content text default ''::text not null,
  updated_at timestamp with time zone default now() not null,
  primary key (slug)
);

create table if not exists public.jarvis_conversations (
  id bigint not null,
  user_key text not null,
  surface text default 'telegram'::text not null,
  role text not null,
  content text not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.jarvis_memory (
  id bigint not null,
  fact text not null,
  category text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.jarvis_owner_messages (
  id bigint not null,
  role text not null,
  content text not null,
  surface text,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.jarvis_tasks (
  id bigint not null,
  title text not null,
  detail text default ''::text not null,
  status text default 'open'::text not null,
  due date,
  source text default 'operator'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.lead_merge_log (
  id uuid default gen_random_uuid() not null,
  ghost_id uuid not null,
  primary_id uuid not null,
  ghost_snapshot jsonb not null,
  merged_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.leads (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  ghl_contact_id text,
  ig_username text,
  full_name text,
  phone text,
  email text,
  status text default 'new'::text not null,
  first_contact_at timestamp with time zone default now() not null,
  last_message_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  ai_paused boolean default false not null,
  screened boolean default false not null,
  stage text,
  stage_data jsonb default '{}'::jsonb not null,
  ghl_opportunity_id text,
  source text,
  campaign text,
  source_enriched text,
  source_method text,
  campaign_enriched text,
  attribution_raw jsonb,
  enriched_at timestamp with time zone,
  conversation_language text,
  deal_value numeric,
  src_channel text,
  src_placement text,
  src_campaign text,
  src_content text,
  booking_method text,
  ai_booked boolean,
  ai_message_share numeric,
  disqualify_reason text,
  opted_in boolean,
  funnel_stage text,
  reply_lock_at timestamp with time zone,
  nurture_paused boolean default false not null,
  followup_paused boolean default false not null,
  voice_paused boolean default false not null,
  whale_paused boolean default false not null,
  manychat_subscriber_id text,
  source_video_id text,
  ack_lock_at timestamp with time zone,
  magnet_state text,
  magnet_keyword text,
  magnet_email text,
  magnet_link_sent_at timestamp with time zone,
  magnet_handoff_at timestamp with time zone,
  ig_sender_id text,
  id_ref text generated always as ("left"(replace((id)::text, '-'::text, ''::text), 6)) stored,
  ai_resumed_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.messages (
  id uuid default gen_random_uuid() not null,
  lead_id uuid not null,
  client_id uuid not null,
  role text not null,
  content text not null,
  channel text default 'instagram'::text not null,
  ghl_message_id text,
  model_used text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamp with time zone default now() not null,
  source text,
  delivery text,
  delivered_at timestamp with time zone,
  inbox_verified_at timestamp with time zone,
  send_attempted_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.nf_shared (
  id uuid default gen_random_uuid() not null,
  opportunity_id uuid not null,
  student_id bigint not null,
  card jsonb not null,
  shared_at timestamp with time zone default now() not null,
  seen_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.niche_runs (
  id bigint not null,
  student_id bigint not null,
  advantages jsonb default '{}'::jsonb not null,
  candidates jsonb default '[]'::jsonb not null,
  shortlist jsonb default '[]'::jsonb not null,
  confirmed_niche text,
  calls_logged integer default 0 not null,
  status text default 'scanning'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.nurture_jobs (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  lead_id uuid not null,
  ghl_contact_id text,
  channel text default 'IG'::text not null,
  kind text not null,
  run_at timestamp with time zone not null,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  meta jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  sent_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.os_tasks (
  id bigserial not null,
  kind text not null,
  student_id bigint,
  due_at timestamp with time zone not null,
  payload jsonb default '{}'::jsonb not null,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  last_error text,
  dedupe_key text,
  locked_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.payments (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  customer_id uuid,
  lead_id uuid,
  ghl_contact_id text,
  amount numeric not null,
  currency text default 'USD'::text,
  kind text default 'payment'::text,
  collected_at timestamp with time zone default now(),
  logged_by text,
  note text,
  created_at timestamp with time zone default now(),
  source_video_id text,
  external_payment_id text,
  buyer_email text,
  buyer_name text,
  primary key (id)
);

create table if not exists public.ping_dedupe (
  hash text not null,
  sent_at timestamp with time zone default now() not null,
  primary key (hash)
);

create table if not exists public.pipeline_source_files (
  id uuid default gen_random_uuid() not null,
  card_id uuid not null,
  drive_file_id text not null,
  drive_view_url text,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamp with time zone default now() not null,
  slot text,
  primary key (id)
);

create table if not exists public.pipeline_stages (
  id uuid default gen_random_uuid() not null,
  funnel text not null,
  key text not null,
  label text not null,
  "position" double precision default 0 not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.prompter_config (
  id integer default 1 not null,
  access_key text not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.reel_formats (
  id uuid default gen_random_uuid() not null,
  name text not null,
  "position" double precision default 0 not null,
  archived boolean default false not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.reply_timings (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  lead_id uuid not null,
  lead_msg_at timestamp with time zone,
  pipeline_started_at timestamp with time zone default now() not null,
  debounce_ms integer,
  model_ms integer,
  send_ms integer,
  total_ms integer,
  first_bubble_at timestamp with time zone,
  last_bubble_at timestamp with time zone,
  bubbles integer,
  bubbles_delivered integer,
  voice_notes integer default 0,
  all_delivered boolean,
  inbound_source text,
  model_used text,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.rulings (
  id bigint not null,
  workspace_id bigint default 1 not null,
  question text not null,
  answer text not null,
  category text default 'general'::text not null,
  student_id bigint,
  created_by text default 'operator'::text not null,
  source text default 'chat'::text not null,
  created_at timestamp with time zone default now() not null,
  scope text default 'global'::text not null,
  primary key (id)
);

create table if not exists public.service_heartbeats (
  id uuid default gen_random_uuid() not null,
  service text not null,
  git_sha text,
  deployment_id text,
  commit_message text,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.service_state (
  key text not null,
  value text,
  updated_at timestamp with time zone default now() not null,
  primary key (key)
);

create table if not exists public.service_tokens (
  service text not null,
  refresh_token text,
  account_email text,
  updated_at timestamp with time zone default now() not null,
  client_id text,
  client_secret text,
  primary key (service)
);

create table if not exists public.setter_brain_versions (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  field text not null,
  old_value text,
  new_value text,
  changed_by text,
  changed_at timestamp with time zone default now(),
  primary key (id)
);

create table if not exists public.sop_masters (
  id bigint not null,
  slug text not null,
  title text not null,
  body text default ''::text not null,
  summary text,
  "position" integer default 0 not null,
  archived boolean default false not null,
  version integer default 1 not null,
  updated_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  kind text default 'sop'::text not null,
  channel text,
  stage text,
  primary key (id)
);

create table if not exists public.stage_map (
  alias text not null,
  stage text not null,
  created_at timestamp with time zone default now() not null,
  primary key (alias)
);

create table if not exists public.student_chat_log (
  id uuid default gen_random_uuid() not null,
  student_id bigint not null,
  direction text not null,
  surface text not null,
  kind text default 'chat'::text not null,
  content text not null,
  metadata jsonb,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_client_payments (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  student_id bigint not null,
  amount numeric not null,
  currency text default 'usd'::text not null,
  occurred_on date default CURRENT_DATE not null,
  note text,
  created_at timestamp with time zone default now() not null,
  prompt_id bigint,
  source_scope text,
  primary key (id)
);

create table if not exists public.student_clients (
  id uuid default gen_random_uuid() not null,
  student_id bigint not null,
  name text not null,
  status text default 'active'::text not null,
  service text,
  model text,
  amount numeric,
  currency text default 'usd'::text not null,
  billing text default 'monthly'::text not null,
  charge_info text,
  next_charge_on date,
  contact_name text,
  contact_email text,
  contact_phone text,
  country text,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  churned_at timestamp with time zone,
  source_scope text,
  primary key (id)
);

create table if not exists public.student_content_items (
  id bigint not null,
  student_id bigint not null,
  channel text default ''::text not null,
  idea text default ''::text not null,
  status text default 'queued'::text not null,
  posted_on date,
  metrics jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  title text,
  script text default ''::text not null,
  sort integer default 0 not null,
  generated jsonb default '{}'::jsonb not null,
  format text,
  audience_level text,
  reference_url text,
  posted_url text,
  perf_views bigint,
  perf_likes bigint,
  perf_comments bigint,
  perf_engagement numeric,
  perf_updated_at timestamp with time zone,
  story_key text,
  external_id text,
  source text,
  edit_brief text,
  primary key (id)
);

create table if not exists public.student_daily_logs (
  id bigint not null,
  student_id bigint not null,
  log_date date default CURRENT_DATE not null,
  plan text default ''::text not null,
  did text default ''::text not null,
  avoided text default ''::text not null,
  win text default ''::text not null,
  kpi jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  numbers_extracted boolean default false not null,
  primary key (id)
);

create table if not exists public.student_daily_targets (
  id bigint not null,
  student_id bigint not null,
  scope text not null,
  col_key text not null,
  target numeric not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  label text,
  primary key (id)
);

create table if not exists public.student_dashboards (
  id bigint not null,
  student_id bigint not null,
  name text not null,
  "position" integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_deals (
  id bigserial not null,
  student_id bigint not null,
  occurred_on date not null,
  kind text not null,
  client_name text,
  amount numeric,
  currency text,
  note text,
  source text,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_funnel_events (
  id bigint not null,
  student_id bigint not null,
  channel text default ''::text not null,
  stage text not null,
  count integer default 1 not null,
  occurred_on date default CURRENT_DATE not null,
  meta jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_google_tokens (
  student_id bigint not null,
  refresh_token text not null,
  email text,
  sync_token text,
  connected_at timestamp with time zone default now() not null,
  last_synced_at timestamp with time zone,
  primary key (student_id)
);

create table if not exists public.student_ig_daily (
  student_id bigint not null,
  day date not null,
  handle text,
  stories_posted boolean,
  story_slides integer,
  followers integer,
  checked_at timestamp with time zone default now() not null,
  primary key (student_id, day)
);

create table if not exists public.student_inbox_seen (
  student_id bigint not null,
  conversation_id text not null,
  last_message_id text,
  last_message_at timestamp with time zone,
  lead_id bigint,
  updated_at timestamp with time zone default now() not null,
  primary key (student_id, conversation_id)
);

create table if not exists public.student_instantly (
  student_id bigint not null,
  api_key text not null,
  connected_at timestamp with time zone default now() not null,
  synced_at timestamp with time zone,
  last_error text,
  overview jsonb,
  daily jsonb,
  campaigns jsonb,
  primary key (student_id)
);

create table if not exists public.student_kpi_targets (
  id bigint not null,
  student_id bigint not null,
  scope text not null,
  kpi_key text not null,
  target numeric not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_lead_events (
  id bigint not null,
  lead_id bigint not null,
  student_id bigint not null,
  kind text not null,
  from_stage text,
  to_stage text,
  detail text,
  actor text default 'student'::text not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_lead_facts (
  id bigserial not null,
  student_id bigint not null,
  lead_id bigint not null,
  field text not null,
  value text,
  observed text not null,
  source text not null,
  actor text default 'agent'::text not null,
  dismissed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_leads (
  id bigint not null,
  student_id bigint not null,
  name text default ''::text not null,
  source text default ''::text not null,
  value numeric,
  notes text,
  ghl_contact_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  phone text,
  contact_name text,
  last_contact_on date,
  next_step text,
  needs_followup boolean default false not null,
  handle text,
  owner text,
  pipeline_id bigint,
  stage_id bigint,
  "position" double precision default 0 not null,
  currency text,
  status text default 'open'::text not null,
  won_at timestamp with time zone,
  lost_at timestamp with time zone,
  lost_reason text,
  email text,
  client_id uuid,
  content_id bigint,
  tags text[] default '{}'::text[] not null,
  next_step_on date,
  call_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.student_messages (
  id bigint not null,
  student_id bigint,
  draft text not null,
  reason text default ''::text not null,
  status text default 'drafted'::text not null,
  sent_text text,
  channel text default 'telegram'::text not null,
  created_at timestamp with time zone default now() not null,
  sent_at timestamp with time zone,
  primary key (id)
);

create table if not exists public.student_metricool (
  student_id bigint not null,
  user_token text not null,
  user_id text not null,
  blog_id text not null,
  providers text[] default '{INSTAGRAM}'::text[] not null,
  connected_at timestamp with time zone default now() not null,
  synced_at timestamp with time zone,
  last_error text,
  content_synced_at timestamp with time zone,
  primary key (student_id)
);

create table if not exists public.student_momentum (
  id bigint not null,
  student_id bigint not null,
  scored_on date not null,
  score integer not null,
  level text not null,
  signals jsonb default '{}'::jsonb not null,
  patterns jsonb default '[]'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_money_prompts (
  id bigint not null,
  student_id bigint not null,
  client_id uuid not null,
  kind text not null,
  due_on date not null,
  status text default 'open'::text not null,
  amount numeric,
  currency text,
  asked_at timestamp with time zone,
  answered_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_niche_intake (
  id uuid default gen_random_uuid() not null,
  student_id bigint not null,
  answers jsonb default '{}'::jsonb not null,
  profile jsonb,
  status text default 'draft'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_oneoff_tasks (
  id bigint not null,
  student_id bigint not null,
  label text not null,
  due_date date,
  done boolean default false not null,
  done_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_os_errors (
  id bigint not null,
  student_id bigint,
  source text not null,
  detail text,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_pipeline_stages (
  id bigint not null,
  pipeline_id bigint not null,
  name text not null,
  sort_order integer default 0 not null,
  canonical text,
  is_won boolean default false not null,
  is_lost boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_pipelines (
  id bigint not null,
  student_id bigint not null,
  name text not null,
  funnel_id bigint,
  sort_order integer default 0 not null,
  archived boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_plan_blocks (
  id bigint not null,
  student_id bigint not null,
  plan_date date not null,
  start_min smallint not null,
  end_min smallint not null,
  label text not null,
  kind text default 'custom'::text not null,
  source text default 'template'::text not null,
  done boolean default false not null,
  done_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  color text,
  notes text,
  gcal_event_id text,
  updated_at timestamp with time zone default now() not null,
  gcal_solid boolean,
  gcal_meta jsonb,
  primary key (id)
);

create table if not exists public.student_pulse (
  student_id bigint not null,
  summary text,
  updated_at timestamp with time zone default now() not null,
  primary key (student_id)
);

create table if not exists public.student_reel_formats (
  id bigint not null,
  student_id bigint not null,
  name text not null,
  "position" integer default 0 not null,
  archived boolean default false not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_roadmap_steps (
  id bigint not null,
  student_id bigint not null,
  "position" integer default 0 not null,
  title text not null,
  detail text,
  status text default 'upcoming'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_sops (
  id bigint not null,
  student_id bigint not null,
  master_id bigint not null,
  body text default ''::text not null,
  customized boolean default false not null,
  base_version integer default 1 not null,
  updated_by text,
  updated_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_strategy (
  student_id bigint not null,
  offer text,
  lead_magnet text,
  funnel text,
  acquisition text,
  strategy text,
  weekly_targets jsonb default '{}'::jsonb not null,
  red_flags jsonb default '[]'::jsonb not null,
  tracking_notes text,
  updated_at timestamp with time zone default now() not null,
  updated_by text,
  goal_text text,
  goal_days integer,
  goal_set_on date,
  avatar text,
  problem text,
  solution text,
  offer_pricing text,
  guarantee text,
  unique_mechanism text,
  traffic text,
  targets_raw text,
  primary key (student_id)
);

create table if not exists public.student_telegram_links (
  id bigint not null,
  student_id bigint not null,
  telegram_chat_id text not null,
  person_name text,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.student_wins (
  id bigint not null,
  student_id bigint not null,
  text text not null,
  kind text default 'internal'::text not null,
  amount numeric,
  occurred_on date default CURRENT_DATE not null,
  created_at timestamp with time zone default now() not null,
  primary key (id)
);

create table if not exists public.students (
  id bigint not null,
  workspace_id bigint default 1 not null,
  auth_user_id uuid,
  name text not null,
  handle text,
  whatsapp text,
  telegram_chat_id text,
  email text,
  cohort text,
  status text default 'active'::text not null,
  current_station integer default 0 not null,
  niche text,
  channel text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  register_code text,
  posts_content boolean default false not null,
  content_session jsonb default '{}'::jsonb not null,
  outreach_method text,
  timezone text,
  timezone_locked boolean default false not null,
  ping_morning text default '08:00'::text not null,
  ping_night text default '21:00'::text not null,
  pings_enabled boolean default true not null,
  last_morning_ping date,
  last_night_ping date,
  teleprompter text default ''::text not null,
  brief text default ''::text not null,
  pipeline_stages jsonb,
  currency text default 'SEK'::text not null,
  content_language text default 'English'::text not null,
  last_weekly_recap text,
  bottleneck_pin jsonb,
  last_streak_save date,
  plan_mode text default 'same_day'::text not null,
  ping_plan text,
  ping_review text,
  last_plan_ping date,
  last_review_ping date,
  last_answer_at timestamp with time zone,
  last_answer_question text,
  ig_handle text,
  stage_key text,
  last_momentum_nudge date,
  story_stages jsonb,
  is_owner boolean default false not null,
  week_template_seeded boolean default false not null,
  onboarding jsonb default '{}'::jsonb not null,
  last_crm_watch date,
  primary key (id)
);

create table if not exists public.team_activity (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  team_member_id uuid,
  activity_date date default CURRENT_DATE not null,
  outreaches integer default 0,
  dials integer default 0,
  conversations integer default 0,
  note text,
  logged_by text,
  created_at timestamp with time zone default now(),
  followups_outreach integer default 0,
  pickups integer default 0,
  followups_dials integer default 0,
  primary key (id)
);

create table if not exists public.team_members (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  name text not null,
  role text default 'closer'::text not null,
  telegram_chat_id text,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  registration_code text,
  registered_at timestamp with time zone,
  reminder_enabled boolean default true,
  reminder_hour integer default 19,
  reminder_minute integer default 0,
  reminder_tz text default 'Europe/Stockholm'::text,
  last_reminder_date date,
  ghl_user_id text,
  ghl_contact_id text,
  primary key (id)
);

create table if not exists public.telegram_ping_refs (
  chat_id text not null,
  message_id bigint not null,
  lead_id uuid not null,
  client_id uuid,
  kind text,
  created_at timestamp with time zone default now() not null,
  primary key (chat_id, message_id)
);

create table if not exists public.webhook_debug_logs (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  raw_payload jsonb,
  raw_headers jsonb,
  extracted_data jsonb,
  parse_result text,
  primary key (id)
);

create table if not exists public.yt_scripts (
  id uuid default gen_random_uuid() not null,
  title text default ''::text not null,
  modules jsonb default '[]'::jsonb not null,
  full_package text default ''::text not null,
  created_at timestamp with time zone default now() not null,
  sections jsonb default '{}'::jsonb not null,
  primary key (id)
);

create table if not exists public.source_aliases (
  raw_value text not null,
  kind text not null,
  channel text,
  partner text,
  campaign text,
  note text,
  resolved_by text default 'system'::text,
  created_at timestamp with time zone default now() not null,
  primary key (raw_value)
);

-- ── HELPER FUNCTIONS ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- FUNCTIONS
CREATE OR REPLACE FUNCTION public.resolve_channel(raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case lower(coalesce(trim(raw),''))
    when 'instagram' then 'IG'
    when 'ig' then 'IG'
    when 'youtube' then 'YouTube'
    when 'yt' then 'YouTube'
    when 'tiktok' then 'TikTok'
    when 'referral' then 'Referrals'
    when 'referrals' then 'Referrals'
    when 'affiliate' then 'Affiliates'
    when 'affiliates' then 'Affiliates'
    when 'ads' then 'Ads'
    when 'paid' then 'Ads'
    when 'linkedin' then 'LinkedIn'
    when 'x' then 'X'
    when 'twitter' then 'X'
    when 'threads' then 'Threads'
    when 'facebook' then 'Facebook'
    when 'fb' then 'Facebook'
    when 'warm outreach' then 'Warm outreach'
    when 'warm' then 'Warm outreach'
    when 'skool' then 'Skool'
    when 'email' then 'Email'
    when 'sms' then 'SMS'
    else null
  end
$function$;

CREATE OR REPLACE FUNCTION public.resolve_attribution(p_src_channel text, p_effective_source text)
 RETURNS TABLE(channel text, partner text, campaign_override text)
 LANGUAGE sql
 STABLE
AS $function$
  with raw as (
    select lower(nullif(trim(coalesce(p_src_channel, p_effective_source)),'')) as v
  ),
  a as (select sa.* from source_aliases sa join raw on sa.raw_value = raw.v)
  select
    coalesce(
      -- An alias' channel is canonicalised too (falling back to its literal
      -- value if it is already canonical, e.g. 'Skool').
      (select coalesce(public.resolve_channel(a.channel), a.channel)
         from a where a.kind in ('channel','partner') and a.channel is not null),
      public.resolve_channel((select v from raw)),
      'Unclassified'
    ),
    (select a.partner from a where a.kind='partner'),
    (select a.campaign from a where a.kind='campaign');
$function$
;

-- VIEWS
create or replace view public.reporting_leads as  WITH lead_dates AS (
         SELECT events.lead_id,
            min(events.created_at) AS lead_date
           FROM events
          WHERE events.event_type = 'lead_created'::text
          GROUP BY events.lead_id
        ), booked_events AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = ANY (ARRAY['call_booked'::text, 'appointment_booked'::text])
        ), junk_flags AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = ANY (ARRAY['screen_skip_owner'::text, 'screen_skip_friend'::text, 'handoff_biz_owner'::text])
        ), proven AS (
         SELECT DISTINCT l_1.id AS lead_id
           FROM leads l_1
          WHERE (EXISTS ( SELECT 1
                   FROM events e
                  WHERE e.lead_id = l_1.id AND e.event_type = 'call_booked'::text)) OR (EXISTS ( SELECT 1
                   FROM customers c
                  WHERE c.lead_id = l_1.id))
        ), test_flags AS (
         SELECT l_1.id,
            l_1.full_name ~~* '%test%'::text OR l_1.full_name ~~* '%demo%'::text OR l_1.full_name ~~* 'qa-%'::text OR COALESCE(NULLIF(l_1.source_enriched, ''::text), l_1.source) ~~* 'qa-%'::text OR COALESCE(NULLIF(l_1.source_enriched, ''::text), l_1.source) = 'aima'::text AS is_test
           FROM leads l_1
        )
 SELECT l.id,
    l.client_id,
    l.full_name,
    l.stage,
    l.deal_value,
    COALESCE(NULLIF(l.source_enriched, ''::text), l.source) AS effective_source,
    COALESCE(NULLIF(l.campaign_enriched, ''::text), l.campaign) AS effective_campaign,
    COALESCE(ld.lead_date, l.created_at) AS lead_date,
    tf.is_test,
    jf.lead_id IS NOT NULL AS is_screener_junk,
    NOT tf.is_test AND (jf.lead_id IS NULL OR pr.lead_id IS NOT NULL) AS is_real_prospect,
    l.stage = ANY (ARRAY['Call Pitched'::text, 'Appointment Booked'::text, 'Contacted'::text, 'Appointment Confirmed'::text, 'No Show - Re-Nurture'::text, 'Client Won'::text]) AS reached_pitched,
    (l.stage = ANY (ARRAY['Appointment Booked'::text, 'Contacted'::text, 'Appointment Confirmed'::text, 'No Show - Re-Nurture'::text, 'Client Won'::text])) OR be.lead_id IS NOT NULL AS reached_booked,
    l.stage = 'No Show - Re-Nurture'::text AS is_no_show,
    l.stage = 'Client Won'::text AS is_won,
    l.stage = 'Lead Lost'::text AS is_lost,
    l.stage = 'Disqualified'::text AS is_disqualified
   FROM leads l
     LEFT JOIN lead_dates ld ON ld.lead_id = l.id
     LEFT JOIN booked_events be ON be.lead_id = l.id
     LEFT JOIN junk_flags jf ON jf.lead_id = l.id
     LEFT JOIN proven pr ON pr.lead_id = l.id
     LEFT JOIN test_flags tf ON tf.id = l.id;

create or replace view public.reporting_calls as  SELECT co.id,
    co.lead_id,
    co.created_at,
    co.created_at::date AS call_date,
    co.showed,
    co.pitched,
    co.closed,
    co.outcome,
    co.reason,
    co.call_duration_minutes,
    co.customer_id,
    l.full_name,
    COALESCE(NULLIF(l.source_enriched, ''::text), l.source) AS effective_source
   FROM call_outcomes co
     LEFT JOIN leads l ON l.id = co.lead_id;

create or replace view public.reporting_funnel_all as  WITH marked AS (
         SELECT messages.lead_id,
            messages.role,
            messages.created_at,
                CASE
                    WHEN messages.role IS DISTINCT FROM lag(messages.role) OVER (PARTITION BY messages.lead_id ORDER BY messages.created_at) THEN 1
                    ELSE 0
                END AS new_turn
           FROM messages
          WHERE messages.role = ANY (ARRAY['ai'::text, 'human'::text, 'lead'::text])
        ), grouped AS (
         SELECT marked.lead_id,
            marked.role,
            marked.created_at,
            sum(marked.new_turn) OVER (PARTITION BY marked.lead_id ORDER BY marked.created_at) AS turn_id
           FROM marked
        ), turns AS (
         SELECT grouped.lead_id,
            grouped.turn_id,
            max(grouped.role) AS role,
            min(grouped.created_at) AS turn_start
           FROM grouped
          GROUP BY grouped.lead_id, grouped.turn_id
        ), fu AS (
         SELECT messages.lead_id,
            count(*) AS cnt
           FROM messages
          WHERE messages.role = 'ai'::text AND (messages.model_used = ANY (ARRAY['followup_engine'::text, 'followup_engine_voice'::text]))
          GROUP BY messages.lead_id
        ), ash AS (
         SELECT turns.lead_id,
            count(*) FILTER (WHERE turns.role = 'ai'::text)::numeric / NULLIF(count(*) FILTER (WHERE turns.role = ANY (ARRAY['ai'::text, 'human'::text])), 0)::numeric AS share
           FROM turns
          GROUP BY turns.lead_id
        ), replied AS (
         SELECT DISTINCT messages.lead_id
           FROM messages
          WHERE messages.role = 'lead'::text
        ), icp AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = 'tag_icp'::text
        ), qual AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = 'tag_qualified'::text
        )
 SELECT rl.id,
    rl.lead_date,
    rl.reached_pitched,
    rl.reached_booked,
    rl.is_won,
    rl.is_lost,
    rl.is_no_show,
    rl.effective_source,
    ra.channel,
    l.src_placement,
    lower(NULLIF(TRIM(BOTH FROM COALESCE(ra.campaign_override, l.src_campaign, rl.effective_campaign)), ''::text)) AS campaign,
    l.booking_method,
    COALESCE(ash.share, 0::numeric) >= 0.5 AS ai_booked,
    l.disqualify_reason,
    l.opted_in,
        CASE
            WHEN COALESCE(l.opted_in, false) THEN 'inbound'::text
            WHEN lower(COALESCE(l.src_channel, rl.effective_source)) = ANY (ARRAY['instagram'::text, 'ig'::text]) THEN 'outbound'::text
            ELSE 'inbound'::text
        END AS funnel,
    r.lead_id IS NOT NULL AS replied,
    i.lead_id IS NOT NULL AS is_icp,
    q.lead_id IS NOT NULL AS is_qualified,
    COALESCE(fu.cnt, 0::bigint) AS followups,
    round(COALESCE(ash.share, 0::numeric) * 100::numeric) AS ai_share_pct,
    lower(NULLIF(TRIM(BOTH FROM l.src_content), ''::text)) AS content,
    ra.partner
   FROM reporting_leads rl
     JOIN leads l ON l.id = rl.id
     CROSS JOIN LATERAL resolve_attribution(l.src_channel, rl.effective_source) ra(channel, partner, campaign_override)
     LEFT JOIN fu ON fu.lead_id = rl.id
     LEFT JOIN ash ON ash.lead_id = rl.id
     LEFT JOIN replied r ON r.lead_id = rl.id
     LEFT JOIN icp i ON i.lead_id = rl.id
     LEFT JOIN qual q ON q.lead_id = rl.id
  WHERE rl.is_real_prospect;

create or replace view public.reporting_funnel as  SELECT id,
    lead_date,
    reached_pitched,
    reached_booked,
    is_won,
    is_lost,
    is_no_show,
    effective_source,
    channel,
    src_placement,
    campaign,
    booking_method,
    ai_booked,
    disqualify_reason,
    opted_in,
    funnel,
    replied,
    is_icp,
    is_qualified,
    followups,
    ai_share_pct,
    content,
    partner
   FROM reporting_funnel_all
  WHERE lead_date::date >= '2026-06-12'::date;

create or replace view public.reporting_booking_attempts as  WITH raw AS (
         SELECT e.id AS event_id,
            e.lead_id,
            e.created_at AS booked_at,
            NULLIF(e.metadata ->> 'call_at'::text, ''::text)::timestamp with time zone AS call_at,
            NULLIF(e.metadata ->> 'appointment_status'::text, ''::text) AS appt_status,
            e.source_system,
            lag(e.created_at) OVER w AS prev_booked_at,
            lag(NULLIF(e.metadata ->> 'appointment_status'::text, ''::text)) OVER w AS prev_appt_status,
            max(NULLIF(e.metadata ->> 'call_at'::text, ''::text)::timestamp with time zone) OVER (PARTITION BY e.lead_id ORDER BY e.created_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_slot
           FROM events e
          WHERE e.event_type = 'call_booked'::text AND e.lead_id IS NOT NULL
          WINDOW w AS (PARTITION BY e.lead_id ORDER BY e.created_at)
        ), flagged AS (
         SELECT r_1.event_id,
            r_1.lead_id,
            r_1.booked_at,
            r_1.call_at,
            r_1.appt_status,
            r_1.source_system,
            r_1.prev_booked_at,
            r_1.prev_appt_status,
            r_1.prev_max_slot,
                CASE
                    WHEN r_1.prev_booked_at IS NULL THEN true
                    WHEN r_1.call_at IS NOT NULL AND r_1.call_at <= r_1.booked_at THEN false
                    WHEN r_1.prev_appt_status = 'cancelled'::text THEN false
                    WHEN r_1.prev_max_slot IS NOT NULL THEN r_1.booked_at > r_1.prev_max_slot
                    WHEN (EXISTS ( SELECT 1
                       FROM events ns
                      WHERE ns.lead_id = r_1.lead_id AND ns.event_type = 'call_no_show'::text AND ns.created_at > r_1.prev_booked_at AND ns.created_at <= r_1.booked_at)) THEN true
                    ELSE r_1.booked_at > (r_1.prev_booked_at + '7 days'::interval)
                END AS is_attempt
           FROM raw r_1
        ), grouped AS (
         SELECT f.event_id,
            f.lead_id,
            f.booked_at,
            f.call_at,
            f.appt_status,
            f.source_system,
            f.prev_booked_at,
            f.prev_appt_status,
            f.prev_max_slot,
            f.is_attempt,
            sum(
                CASE
                    WHEN f.is_attempt THEN 1
                    ELSE 0
                END) OVER (PARTITION BY f.lead_id ORDER BY f.booked_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS booking_no
           FROM flagged f
        ), rolled AS (
         SELECT grouped.lead_id,
            grouped.booking_no,
            count(*) FILTER (WHERE NOT grouped.is_attempt) AS reschedules,
            (array_agg(grouped.call_at ORDER BY grouped.booked_at DESC) FILTER (WHERE grouped.call_at IS NOT NULL))[1] AS final_call_at,
            (array_agg(grouped.appt_status ORDER BY grouped.booked_at DESC) FILTER (WHERE grouped.appt_status IS NOT NULL))[1] AS final_status
           FROM grouped
          GROUP BY grouped.lead_id, grouped.booking_no
        ), attempts AS (
         SELECT g.event_id,
            g.lead_id,
            g.booking_no,
            g.booked_at,
            g.call_at,
            g.appt_status,
            g.source_system,
            lead(g.booked_at) OVER (PARTITION BY g.lead_id ORDER BY g.booked_at) AS next_attempt_at
           FROM grouped g
          WHERE g.is_attempt
        )
 SELECT a.event_id AS attempt_id,
    a.lead_id,
    a.booked_at,
    COALESCE(r.final_call_at, a.call_at) AS call_at,
    COALESCE(r.final_status, a.appt_status) = 'cancelled'::text AS cancelled,
    rc.call_date,
    rc.outcome,
    COALESCE(rc.showed, false) AS showed,
    COALESCE(rc.pitched, false) AS pitched,
    COALESCE(rc.closed, false) AS closed,
    rc.call_duration_minutes,
    rc.lead_id IS NOT NULL AS has_outcome,
    COALESCE(r.reschedules, 0::bigint) AS reschedules,
    COALESCE(r.reschedules, 0::bigint) > 0 AS was_rescheduled,
    a.call_at AS originally_set_for
   FROM attempts a
     LEFT JOIN rolled r ON r.lead_id = a.lead_id AND r.booking_no = a.booking_no
     LEFT JOIN LATERAL ( SELECT c.id,
            c.lead_id,
            c.created_at,
            c.call_date,
            c.showed,
            c.pitched,
            c.closed,
            c.outcome,
            c.reason,
            c.call_duration_minutes,
            c.customer_id,
            c.full_name,
            c.effective_source
           FROM reporting_calls c
          WHERE c.lead_id = a.lead_id AND c.call_date >= a.booked_at::date AND (a.next_attempt_at IS NULL OR c.call_date < a.next_attempt_at::date)
          ORDER BY c.call_date
         LIMIT 1) rc ON true;

create or replace view public.reporting_money as  SELECT c.id AS customer_id,
    c.client_id,
    c.name,
    c.lead_id,
    c.contract_value,
    c.currency,
    c.closer,
    c.closed_at,
    c.status,
    COALESCE(p.total_collected, 0::numeric) AS cash_collected,
    COALESCE(p.payment_count, 0::bigint) AS payment_count,
        CASE
            WHEN c.contract_value IS NOT NULL THEN c.contract_value - COALESCE(p.total_collected, 0::numeric)
            ELSE NULL::numeric
        END AS outstanding
   FROM customers c
     LEFT JOIN ( SELECT payments.customer_id,
            sum(payments.amount) AS total_collected,
            count(*) AS payment_count
           FROM payments
          GROUP BY payments.customer_id) p ON p.customer_id = c.id;

create or replace view public.reporting_money_summary as  SELECT count(*) AS customer_count,
    COALESCE(sum(contract_value), 0::numeric) AS business_contract_ltv,
    COALESCE(sum(cash_collected), 0::numeric) AS business_cash_ltv,
    COALESCE(sum(outstanding), 0::numeric) AS business_outstanding
   FROM reporting_money;

create or replace view public.reporting_leak_map as  SELECT funnel_stage,
    count(*)::integer AS stalled
   FROM leads
  WHERE status = 'engaged'::text AND funnel_stage IS NOT NULL AND last_message_at < (now() - '24:00:00'::interval)
  GROUP BY funnel_stage;

create or replace view public.reporting_lead_timing as  WITH created AS (
         SELECT events.lead_id,
            min(events.created_at) AS lead_created_at
           FROM events
          WHERE events.event_type = 'lead_created'::text
          GROUP BY events.lead_id
        ), msgs AS (
         SELECT events.lead_id,
            min(events.created_at) AS first_lead_msg_at
           FROM events
          WHERE events.event_type = 'lead_message_received'::text
          GROUP BY events.lead_id
        ), replies AS (
         SELECT events.lead_id,
            min(events.created_at) AS first_ai_reply_at
           FROM events
          WHERE events.event_type = 'ai_replied'::text
          GROUP BY events.lead_id
        ), booked AS (
         SELECT events.lead_id,
            min(events.created_at) AS booked_at
           FROM events
          WHERE events.event_type = ANY (ARRAY['call_booked'::text, 'appointment_booked'::text])
          GROUP BY events.lead_id
        )
 SELECT l.id AS lead_id,
    l.full_name,
    COALESCE(NULLIF(l.source_enriched, ''::text), l.source) AS effective_source,
    c.lead_created_at,
    m.first_lead_msg_at,
    r.first_ai_reply_at,
        CASE
            WHEN r.first_ai_reply_at IS NOT NULL AND m.first_lead_msg_at IS NOT NULL AND r.first_ai_reply_at >= m.first_lead_msg_at THEN EXTRACT(epoch FROM r.first_ai_reply_at - m.first_lead_msg_at)
            ELSE NULL::numeric
        END AS first_reply_seconds,
    b.booked_at,
        CASE
            WHEN b.booked_at IS NOT NULL AND c.lead_created_at IS NOT NULL AND b.booked_at >= c.lead_created_at THEN round(EXTRACT(epoch FROM b.booked_at - c.lead_created_at) / 86400.0, 2)
            ELSE NULL::numeric
        END AS days_lead_to_booked
   FROM leads l
     LEFT JOIN created c ON c.lead_id = l.id
     LEFT JOIN msgs m ON m.lead_id = l.id
     LEFT JOIN replies r ON r.lead_id = l.id
     LEFT JOIN booked b ON b.lead_id = l.id;

create or replace view public.reporting_followups as  SELECT ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'follow_up_sent'::text) AS sent_total,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'follow_up_sent'::text AND events.created_at > (now() - '7 days'::interval)) AS sent_7d,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'follow_up_sent'::text AND events.created_at > (now() - '30 days'::interval)) AS sent_30d,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'lead_revived'::text) AS revived_total,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'lead_revived'::text AND events.created_at > (now() - '7 days'::interval)) AS revived_7d,
    ( SELECT count(DISTINCT r.lead_id) AS count
           FROM events r
          WHERE r.event_type = 'lead_revived'::text AND (EXISTS ( SELECT 1
                   FROM events b
                  WHERE b.lead_id = r.lead_id AND b.event_type = 'appointment_booked'::text AND b.created_at > r.created_at))) AS rebooked_total;

-- INDEXES
CREATE INDEX IF NOT EXISTS ai_usage_action_idx ON public.ai_usage USING btree (action);
CREATE INDEX IF NOT EXISTS ai_usage_occurred_idx ON public.ai_usage USING btree (occurred_at);
CREATE INDEX IF NOT EXISTS ai_usage_student_idx ON public.ai_usage USING btree (student_id);
CREATE INDEX IF NOT EXISTS audit_events_session_idx ON public.audit_events USING btree (session_id);
CREATE INDEX IF NOT EXISTS audit_events_stage_idx ON public.audit_events USING btree (stage);
CREATE INDEX IF NOT EXISTS audit_rate_limit_lookup ON public.audit_rate_limit USING btree (ip, route, created_at);
CREATE INDEX IF NOT EXISTS audit_usage_created_idx ON public.audit_usage USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS audits_created_idx ON public.audits USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS audits_email_idx ON public.audits USING btree (email);
CREATE INDEX IF NOT EXISTS banned_contacts_client_active_idx ON public.banned_contacts USING btree (client_id, active);
CREATE INDEX IF NOT EXISTS banned_contacts_ghl_contact_idx ON public.banned_contacts USING btree (ghl_contact_id) WHERE (ghl_contact_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS banned_contacts_ig_sender_idx ON public.banned_contacts USING btree (ig_sender_id) WHERE (ig_sender_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS banned_contacts_ig_username_idx ON public.banned_contacts USING btree (ig_username) WHERE (ig_username IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS clients_slug_key ON public.clients USING btree (slug);
CREATE INDEX IF NOT EXISTS clip_jobs_card_created_idx ON public.clip_jobs USING btree (card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clip_jobs_status_created_idx ON public.clip_jobs USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS clipper_jobs_card_idx ON public.clipper_jobs USING btree (card_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS clipper_jobs_one_active_per_card ON public.clipper_jobs USING btree (card_id) WHERE (status = ANY (ARRAY['queued'::text, 'processing'::text]));
CREATE INDEX IF NOT EXISTS clipper_jobs_status_idx ON public.clipper_jobs USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS content_pipeline_created_at_idx ON public.content_pipeline USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS content_pipeline_format_idx ON public.content_pipeline USING btree (format) WHERE (format IS NOT NULL);
CREATE INDEX IF NOT EXISTS content_pipeline_funnel_idx ON public.content_pipeline USING btree (funnel);
CREATE INDEX IF NOT EXISTS content_pipeline_make_status_idx ON public.content_pipeline USING btree (make_status) WHERE (make_status IS NOT NULL);
CREATE INDEX IF NOT EXISTS content_pipeline_status_idx ON public.content_pipeline USING btree (status);
CREATE INDEX IF NOT EXISTS content_pipeline_video_id_idx ON public.content_pipeline USING btree (video_id);
CREATE UNIQUE INDEX IF NOT EXISTS content_pipeline_video_id_key ON public.content_pipeline USING btree (video_id);
CREATE INDEX IF NOT EXISTS content_pipeline_yt_id_idx ON public.content_pipeline USING btree (youtube_video_id) WHERE (youtube_video_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS customers_email_idx ON public.customers USING btree (lower(email));
CREATE INDEX IF NOT EXISTS customers_source_video_id_idx ON public.customers USING btree (source_video_id) WHERE (source_video_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS dm_reports_client_idx ON public.dm_intel_reports USING btree (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dm_suggestions_report_idx ON public.dm_suggestions USING btree (report_id);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe_key_uniq ON public.events USING btree (dedupe_key);
CREATE INDEX IF NOT EXISTS events_money_idx ON public.events USING btree (client_id, created_at) WHERE (amount IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS events_one_screen_claim_per_lead ON public.events USING btree (lead_id) WHERE (event_type = 'screen_claim'::text);
CREATE INDEX IF NOT EXISTS events_video_id_idx ON public.events USING btree (video_id) WHERE (video_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS follow_up_log_lead_anchor_attempt_uniq ON public.follow_up_log USING btree (lead_id, anchor, attempt);
CREATE INDEX IF NOT EXISTS follow_up_log_lead_idx ON public.follow_up_log USING btree (lead_id);
CREATE INDEX IF NOT EXISTS follow_up_log_sent_idx ON public.follow_up_log USING btree (sent_at);
CREATE INDEX IF NOT EXISTS idea_queue_pending_idx ON public.idea_queue USING btree (status, queued_at);
CREATE INDEX IF NOT EXISTS idx_dash_student ON public.student_dashboards USING btree (student_id, "position");
CREATE INDEX IF NOT EXISTS idx_dashcol_dash ON public.dashboard_columns USING btree (dashboard_id, "position");
CREATE INDEX IF NOT EXISTS idx_dashkpi_dash ON public.dashboard_kpis USING btree (dashboard_id, "position");
CREATE INDEX IF NOT EXISTS idx_decisions_client ON public.ai_decisions USING btree (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_lead ON public.ai_decisions USING btree (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_client_time ON public.events USING btree (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON public.events USING btree (event_type);
CREATE INDEX IF NOT EXISTS idx_leads_client ON public.leads USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_leads_ghl ON public.leads USING btree (ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads USING btree (status);
CREATE INDEX IF NOT EXISTS idx_messages_client ON public.messages USING btree (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON public.messages USING btree (lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_roadmap_student_pos ON public.student_roadmap_steps USING btree (student_id, "position");
CREATE INDEX IF NOT EXISTS idx_webhook_debug_logs_created_at ON public.webhook_debug_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS inbound_outcomes_lead_idx ON public.inbound_outcomes USING btree (lead_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_outcomes_message_id_key ON public.inbound_outcomes USING btree (message_id);
CREATE INDEX IF NOT EXISTS inbound_outcomes_open_idx ON public.inbound_outcomes USING btree (created_at) WHERE (status = 'open'::text);
CREATE INDEX IF NOT EXISTS jarvis_conversations_user_recent_idx ON public.jarvis_conversations USING btree (user_key, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jarvis_memory_fact_key ON public.jarvis_memory USING btree (fact);
CREATE INDEX IF NOT EXISTS jarvis_owner_messages_recent_idx ON public.jarvis_owner_messages USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS jarvis_tasks_open_idx ON public.jarvis_tasks USING btree (status, due);
CREATE UNIQUE INDEX IF NOT EXISTS leads_client_id_ghl_contact_id_key ON public.leads USING btree (client_id, ghl_contact_id);
CREATE INDEX IF NOT EXISTS leads_client_ig_sender_idx ON public.leads USING btree (client_id, ig_sender_id) WHERE (ig_sender_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS leads_id_ref_idx ON public.leads USING btree (id_ref);
CREATE INDEX IF NOT EXISTS leads_magnet_handoff_due_idx ON public.leads USING btree (magnet_handoff_at) WHERE (magnet_state = 'awaiting_handoff'::text);
CREATE UNIQUE INDEX IF NOT EXISTS leads_one_row_per_manychat_subscriber ON public.leads USING btree (client_id, manychat_subscriber_id) WHERE (manychat_subscriber_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS leads_source_video_id_idx ON public.leads USING btree (source_video_id) WHERE (source_video_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS messages_manychat_unclaimed_idx ON public.messages USING btree (lead_id, created_at) WHERE ((source = 'manychat'::text) AND (ghl_message_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS nf_shared_opportunity_id_student_id_key ON public.nf_shared USING btree (opportunity_id, student_id);
CREATE INDEX IF NOT EXISTS nurture_jobs_due_idx ON public.nurture_jobs USING btree (status, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS nurture_jobs_lead_kind_uniq ON public.nurture_jobs USING btree (lead_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS os_tasks_dedupe_key_key ON public.os_tasks USING btree (dedupe_key);
CREATE INDEX IF NOT EXISTS os_tasks_due_idx ON public.os_tasks USING btree (status, due_at) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS os_tasks_student_idx ON public.os_tasks USING btree (student_id, kind, due_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payments_external_payment_id_key ON public.payments USING btree (external_payment_id) WHERE (external_payment_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS payments_source_video_id_idx ON public.payments USING btree (source_video_id) WHERE (source_video_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS pipeline_source_files_card_idx ON public.pipeline_source_files USING btree (card_id);
CREATE INDEX IF NOT EXISTS pipeline_stages_funnel_idx ON public.pipeline_stages USING btree (funnel, "position");
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_funnel_key_key ON public.pipeline_stages USING btree (funnel, key);
CREATE INDEX IF NOT EXISTS reply_timings_created_idx ON public.reply_timings USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS reply_timings_lead_idx ON public.reply_timings USING btree (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reply_timings_total_idx ON public.reply_timings USING btree (created_at, total_ms) WHERE (total_ms IS NOT NULL);
CREATE INDEX IF NOT EXISTS service_heartbeats_lookup ON public.service_heartbeats USING btree (service, created_at DESC);
CREATE INDEX IF NOT EXISTS smom_student_idx ON public.student_momentum USING btree (student_id, scored_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sni_student_idx ON public.student_niche_intake USING btree (student_id);
CREATE INDEX IF NOT EXISTS sop_masters_kind_idx ON public.sop_masters USING btree (kind, "position");
CREATE UNIQUE INDEX IF NOT EXISTS sop_masters_slug_key ON public.sop_masters USING btree (slug);
CREATE INDEX IF NOT EXISTS spb_gcal_idx ON public.student_plan_blocks USING btree (gcal_event_id) WHERE (gcal_event_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS spb_student_date_idx ON public.student_plan_blocks USING btree (student_id, plan_date);
CREATE INDEX IF NOT EXISTS student_chat_log_student_idx ON public.student_chat_log USING btree (student_id, created_at);
CREATE INDEX IF NOT EXISTS student_client_payments_client_idx ON public.student_client_payments USING btree (client_id);
CREATE INDEX IF NOT EXISTS student_client_payments_student_idx ON public.student_client_payments USING btree (student_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS student_clients_student_idx ON public.student_clients USING btree (student_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS student_content_items_external_uidx ON public.student_content_items USING btree (student_id, external_id) WHERE (external_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS student_content_items_story_idx ON public.student_content_items USING btree (student_id, story_key);
CREATE UNIQUE INDEX IF NOT EXISTS student_daily_logs_student_id_log_date_key ON public.student_daily_logs USING btree (student_id, log_date);
CREATE UNIQUE INDEX IF NOT EXISTS student_daily_targets_student_id_scope_col_key_key ON public.student_daily_targets USING btree (student_id, scope, col_key);
CREATE INDEX IF NOT EXISTS student_daily_targets_student_idx ON public.student_daily_targets USING btree (student_id);
CREATE INDEX IF NOT EXISTS student_deals_sid_date ON public.student_deals USING btree (student_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS student_funnel_student_idx ON public.student_funnel_events USING btree (student_id, occurred_on);
CREATE INDEX IF NOT EXISTS student_ig_daily_day_idx ON public.student_ig_daily USING btree (student_id, day DESC);
CREATE INDEX IF NOT EXISTS student_inbox_seen_lead_idx ON public.student_inbox_seen USING btree (lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS student_kpi_targets_student_id_scope_kpi_key_key ON public.student_kpi_targets USING btree (student_id, scope, kpi_key);
CREATE INDEX IF NOT EXISTS student_kpi_targets_student_idx ON public.student_kpi_targets USING btree (student_id);
CREATE INDEX IF NOT EXISTS student_lead_events_lead_idx ON public.student_lead_events USING btree (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS student_lead_facts_lead_idx ON public.student_lead_facts USING btree (lead_id, field, created_at DESC);
CREATE INDEX IF NOT EXISTS student_lead_facts_student_idx ON public.student_lead_facts USING btree (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS student_leads_pipeline_idx ON public.student_leads USING btree (pipeline_id);
CREATE INDEX IF NOT EXISTS student_leads_stage_idx ON public.student_leads USING btree (stage_id);
CREATE INDEX IF NOT EXISTS student_leads_stage_pos_idx ON public.student_leads USING btree (stage_id, "position");
CREATE INDEX IF NOT EXISTS student_leads_student_idx ON public.student_leads USING btree (student_id);
CREATE INDEX IF NOT EXISTS student_leads_tags_idx ON public.student_leads USING gin (tags);
CREATE INDEX IF NOT EXISTS student_messages_open_idx ON public.student_messages USING btree (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS student_momentum_student_id_scored_on_key ON public.student_momentum USING btree (student_id, scored_on);
CREATE INDEX IF NOT EXISTS student_money_prompts_open_idx ON public.student_money_prompts USING btree (student_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS student_money_prompts_unique ON public.student_money_prompts USING btree (client_id, kind, due_on);
CREATE INDEX IF NOT EXISTS student_oneoff_tasks_student_idx ON public.student_oneoff_tasks USING btree (student_id);
CREATE INDEX IF NOT EXISTS student_os_errors_created_idx ON public.student_os_errors USING btree (created_at);
CREATE INDEX IF NOT EXISTS student_pipeline_stages_pipeline_idx ON public.student_pipeline_stages USING btree (pipeline_id);
CREATE INDEX IF NOT EXISTS student_pipelines_student_idx ON public.student_pipelines USING btree (student_id);
CREATE UNIQUE INDEX IF NOT EXISTS student_sops_student_id_master_id_key ON public.student_sops USING btree (student_id, master_id);
CREATE INDEX IF NOT EXISTS student_sops_student_idx ON public.student_sops USING btree (student_id);
CREATE UNIQUE INDEX IF NOT EXISTS student_telegram_links_telegram_chat_id_key ON public.student_telegram_links USING btree (telegram_chat_id);
CREATE INDEX IF NOT EXISTS student_tg_links_student_idx ON public.student_telegram_links USING btree (student_id);
CREATE UNIQUE INDEX IF NOT EXISTS students_auth_user_id_key ON public.students USING btree (auth_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS students_register_code_key ON public.students USING btree (register_code);
CREATE INDEX IF NOT EXISTS team_members_ghl_contact_id_idx ON public.team_members USING btree (ghl_contact_id) WHERE (ghl_contact_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS telegram_ping_refs_created_idx ON public.telegram_ping_refs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS telegram_ping_refs_lead_idx ON public.telegram_ping_refs USING btree (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS yt_scripts_created_at_idx ON public.yt_scripts USING btree (created_at DESC);

-- TRIGGERS
CREATE OR REPLACE TRIGGER clients_updated_at BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── SEEDS ───────────────────────────────────────────────────────────────────
-- The shared access key every webhook and internal call authenticates with.
-- YOUR-ACCESS-KEY must be replaced before running (see header).
insert into prompter_config (id, access_key)
values (1, 'YOUR-ACCESS-KEY')
on conflict (id) do update set access_key = excluded.access_key;

-- ── HEARTBEAT (pg_cron -> your app) ────────────────────────────────────────
-- Your database wakes your app up. These four ticks ARE the platform's pulse:
--   sweep    every 5 min  rescues any lead left unanswered, resends dropped
--                         bubbles, escalates what needs a human
--   nurture  every 5 min  scheduled nurture touches
--   magnet   every 5 min  lead-magnet deliveries
--   dm-intel monthly      the DM intelligence report
-- YOUR-APP-URL must be replaced before running (see header).
select cron.schedule('sweep-tick',   '*/5 * * * *', $$ select net.http_get(url := 'https://YOUR-APP-URL/api/cron/sweep') $$);
select cron.schedule('nurture-tick', '*/5 * * * *', $$ select net.http_get(url := 'https://YOUR-APP-URL/api/cron/nurture') $$);
select cron.schedule('magnet-tick',  '*/5 * * * *', $$ select net.http_get(url := 'https://YOUR-APP-URL/api/cron/magnet') $$);
select cron.schedule('dm-intel-monthly', '0 8 1 * *', $$ select net.http_get(url := 'https://YOUR-APP-URL/api/cron/dm-intel') $$);

-- Housekeeping: keep the noisy diagnostic tables from growing forever.
select cron.schedule('webhook-debug-logs-retention', '17 3 * * *', $$ delete from webhook_debug_logs where created_at < now() - interval '14 days' $$);
select cron.schedule('audit-rate-limit-retention',   '23 3 * * *', $$ delete from audit_rate_limit where created_at < now() - interval '2 days' $$);
select cron.schedule('service-heartbeats-retention', '29 3 * * *', $$ delete from service_heartbeats where created_at < now() - interval '30 days' $$);
