import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- A message's words with personal fields such as {{first_name}}. A WhatsApp template names the one Meta approved,
   -- with the fields that fill its {{1}}, {{2}} and so on.
   CREATE TABLE templates (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
     lang TEXT NOT NULL,
     subject TEXT,
     body TEXT NOT NULL,
     format TEXT NOT NULL DEFAULT 'text' CHECK (format IN ('text', 'html')),
     wa_name TEXT,
     wa_params TEXT NOT NULL DEFAULT '[]',
     -- Meta's answer for a WhatsApp template: APPROVED, PENDING, REJECTED, PAUSED, DISABLED; null before it was asked.
     approval TEXT,
     approval_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- An imported list and its people, for a campaign without Audience.
   CREATE TABLE lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE list_members (
     list_id TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
     n INTEGER NOT NULL,
     email TEXT,
     phone TEXT,
     user_id TEXT,
     name TEXT,
     fields TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (list_id, n)
   ) WITHOUT ROWID;
   CREATE INDEX list_members_email ON list_members (email);
   CREATE INDEX list_members_phone ON list_members (phone);
   -- One send to a segment or a list. While sending, cursor is where reading the audience stopped, so a restart
   -- carries on there; ab holds the variants, the test share, the wait and, once decided, the winner.
   CREATE TABLE campaigns (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL,
     channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
     audience_kind TEXT NOT NULL CHECK (audience_kind IN ('segment', 'list')),
     audience_id TEXT NOT NULL,
     audience_name TEXT NOT NULL,
     template_id TEXT NOT NULL REFERENCES templates (id),
     ab TEXT,
     state TEXT NOT NULL CHECK (state IN ('draft', 'scheduled', 'sending', 'paused', 'sent')),
     scheduled_at TEXT,
     started_at TEXT,
     finished_at TEXT,
     cursor TEXT,
     read_done INTEGER NOT NULL DEFAULT 0,
     audience_size INTEGER NOT NULL DEFAULT 0,
     no_address INTEGER NOT NULL DEFAULT 0,
     -- Why it stopped by itself, such as a segment that is gone.
     problem TEXT,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- Journeys: started by an event or by entering a segment, steps as JSON; one run per person, ever.
   CREATE TABLE journeys (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('draft', 'live', 'paused')),
     trigger TEXT NOT NULL,
     goal TEXT,
     steps TEXT NOT NULL,
     -- Audience's /changes cursor for a segment trigger.
     cursor TEXT,
     problem TEXT,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE journey_runs (
     id TEXT PRIMARY KEY,
     journey_id TEXT NOT NULL REFERENCES journeys (id) ON DELETE CASCADE,
     person_key TEXT NOT NULL,
     email TEXT,
     phone TEXT,
     user_id TEXT,
     profile TEXT,
     person TEXT NOT NULL,
     step INTEGER NOT NULL DEFAULT 0,
     next_at TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('active', 'done', 'converted', 'exited')),
     reason TEXT,
     entered_at TEXT NOT NULL,
     left_at TEXT,
     UNIQUE (journey_id, person_key)
   );
   CREATE INDEX journey_runs_due ON journey_runs (state, next_at);
   CREATE INDEX journey_runs_email ON journey_runs (email) WHERE email IS NOT NULL;
   CREATE INDEX journey_runs_phone ON journey_runs (phone) WHERE phone IS NOT NULL;
   CREATE INDEX journey_runs_user ON journey_runs (user_id) WHERE user_id IS NOT NULL;
   CREATE TABLE journey_passes (run_id TEXT NOT NULL REFERENCES journey_runs (id) ON DELETE CASCADE, step_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (run_id, step_id)) WITHOUT ROWID;
   CREATE INDEX journey_passes_at ON journey_passes (at);
   -- Every message, one row per person, campaign or journey step and address. dedupe is unique, so the same message
   -- is never made twice for one address; a row is claimed (sending) and committed before the provider is called, and
   -- one found still sending after a restart is set to unknown, never sent again.
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     dedupe TEXT NOT NULL UNIQUE,
     campaign_id TEXT REFERENCES campaigns (id) ON DELETE CASCADE,
     journey_id TEXT REFERENCES journeys (id) ON DELETE CASCADE,
     run_id TEXT,
     step_id TEXT,
     variant TEXT,
     channel TEXT NOT NULL,
     address TEXT NOT NULL,
     person TEXT NOT NULL,
     template_id TEXT NOT NULL,
     utm_campaign TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('waiting', 'queued', 'sending', 'sent', 'delivered', 'held', 'suppressed', 'failed', 'bounced', 'unknown', 'cancelled')),
     reason TEXT,
     provider TEXT,
     provider_id TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at TEXT NOT NULL,
     links TEXT,
     created_at TEXT NOT NULL,
     sent_at TEXT,
     delivered_at TEXT,
     opened_at TEXT,
     clicked_at TEXT,
     bounced_at TEXT,
     unsubscribed_at TEXT
   );
   CREATE INDEX messages_due ON messages (state, channel, next_at);
   CREATE INDEX messages_campaign ON messages (campaign_id, state);
   CREATE INDEX messages_run ON messages (run_id);
   CREATE INDEX messages_provider ON messages (provider_id) WHERE provider_id IS NOT NULL;
   CREATE INDEX messages_address ON messages (channel, address);
   CREATE INDEX messages_created ON messages (created_at);
   CREATE INDEX messages_sent ON messages (sent_at) WHERE sent_at IS NOT NULL;
   CREATE TABLE clicks (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE, url TEXT NOT NULL, at TEXT NOT NULL);
   CREATE INDEX clicks_at ON clicks (at);
   -- Bounces, hard and soft. An uncleared hard bounce keeps the address from being sent to; cleared_at is "fixed".
   -- hash is the address's sha256, which is what is compared, and stays after an erasure clears the address.
   CREATE TABLE bounces (
     id INTEGER PRIMARY KEY,
     channel TEXT NOT NULL,
     hash TEXT NOT NULL,
     address TEXT,
     kind TEXT NOT NULL CHECK (kind IN ('hard', 'soft')),
     reason TEXT NOT NULL,
     message_id TEXT,
     source TEXT,
     at TEXT NOT NULL,
     cleared_at TEXT,
     cleared_by TEXT
   );
   CREATE INDEX bounces_hash ON bounces (channel, hash);
   CREATE INDEX bounces_at ON bounces (at);
   -- Messages' own opt-out list: every unsubscribe and STOP, kept whether or not Consent is linked, checked first.
   CREATE TABLE optouts (
     channel TEXT NOT NULL,
     hash TEXT NOT NULL,
     address TEXT,
     source TEXT NOT NULL,
     message_id TEXT,
     at TEXT NOT NULL,
     PRIMARY KEY (channel, hash)
   ) WITHOUT ROWID;
   -- Calls to the linked products that must arrive: events for Audience, refusals for Consent. Tried again until done.
   CREATE TABLE outbox (
     id INTEGER PRIMARY KEY,
     target TEXT NOT NULL CHECK (target IN ('audience', 'consent')),
     body TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at TEXT NOT NULL,
     error TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX outbox_due ON outbox (target, next_at);
   -- Erasure requests from Audience, kept without the identifiers.
   CREATE TABLE erasures (reference TEXT PRIMARY KEY, product TEXT NOT NULL, deleted INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
