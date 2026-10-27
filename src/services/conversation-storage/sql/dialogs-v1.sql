CREATE TABLE IF NOT EXISTS conversation_schema_version (domain text PRIMARY KEY, version integer NOT NULL, checksum text NOT NULL);
CREATE TABLE dialog_archive_scope (
  scope_id text PRIMARY KEY, agency_id text NOT NULL, platform text NOT NULL CHECK(platform='onlyfans'), platform_creator_id text NOT NULL,
  epoch text NOT NULL, collection_from timestamptz NOT NULL DEFAULT now(),
  quota_bytes bigint NOT NULL DEFAULT 200000000 CHECK(quota_bytes>0), used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  revision bigint NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'ACTIVE', inventory_complete boolean NOT NULL DEFAULT false,
  relay_pending boolean NOT NULL DEFAULT false, relay_next_at timestamptz NOT NULL DEFAULT now(), relay_lease_until timestamptz, relay_token text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(agency_id,platform,platform_creator_id)
);
CREATE TABLE dialog_archive_thread (
  scope_id text NOT NULL REFERENCES dialog_archive_scope ON DELETE CASCADE, dialog_id text NOT NULL, platform_fan_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 0, rewrite_revision bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL DEFAULT '{}', stats jsonb NOT NULL DEFAULT '{}', upper_at timestamptz, upper_id text,
  collector_device text, collector_token text, collector_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,dialog_id)
);
CREATE INDEX dialog_archive_thread_due ON dialog_archive_thread(scope_id,updated_at,dialog_id);
CREATE TABLE dialog_archive_message (
  scope_id text NOT NULL, dialog_id text NOT NULL, message_id text NOT NULL,
  platform_creator_id text NOT NULL, platform_fan_id text NOT NULL, platform_author_id text NOT NULL,
  created_at timestamptz NOT NULL, changed_at timestamptz, first_seen_at timestamptz NOT NULL DEFAULT now(),
  sender text NOT NULL CHECK(sender IN ('creator','user')), price_cents bigint NOT NULL CHECK(price_cents>=0),
  provider_opened boolean NOT NULL DEFAULT false, canonical_opened boolean NOT NULL DEFAULT false,
  provider_observed_at timestamptz, canonical_revision bigint NOT NULL DEFAULT 0,
  data jsonb NOT NULL, content_hash text NOT NULL, storage_bytes integer NOT NULL CHECK(storage_bytes>=0),
  revision bigint NOT NULL, PRIMARY KEY(scope_id,dialog_id,message_id),
  FOREIGN KEY(scope_id,dialog_id) REFERENCES dialog_archive_thread ON DELETE CASCADE
);
CREATE INDEX dialog_archive_message_page ON dialog_archive_message(scope_id,dialog_id,created_at,length(message_id),message_id);
CREATE INDEX dialog_archive_message_creator_time ON dialog_archive_message(scope_id,created_at,message_id,dialog_id);
CREATE INDEX dialog_archive_message_first_seen ON dialog_archive_message(scope_id,first_seen_at,dialog_id,message_id) WHERE sender='user';
CREATE TABLE dialog_archive_receipt (
  scope_id text NOT NULL REFERENCES dialog_archive_scope ON DELETE CASCADE, command_id text NOT NULL, request_hash text NOT NULL,
  result jsonb NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(scope_id,command_id)
);
CREATE INDEX dialog_archive_receipt_expiry ON dialog_archive_receipt(expires_at,scope_id,command_id);
CREATE TABLE dialog_archive_page (
  scope_id text NOT NULL, dialog_id text NOT NULL, episode text NOT NULL, cursor text NOT NULL, next_cursor text NOT NULL,
  known_page integer, result jsonb NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope_id,dialog_id,episode,cursor), FOREIGN KEY(scope_id,dialog_id) REFERENCES dialog_archive_thread ON DELETE CASCADE
);
CREATE INDEX dialog_archive_page_expiry ON dialog_archive_page(created_at,scope_id,dialog_id);
-- One coalesced pending notification per conversation; a CRM outage cannot create an unbounded event per message.
CREATE TABLE dialog_archive_outbox (
  scope_id text NOT NULL, dialog_id text NOT NULL, revision bigint NOT NULL, rewrite_revision bigint NOT NULL,
  acknowledged_revision bigint NOT NULL DEFAULT 0, retry_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY(scope_id,dialog_id), FOREIGN KEY(scope_id,dialog_id) REFERENCES dialog_archive_thread ON DELETE CASCADE
);
CREATE INDEX dialog_archive_outbox_due ON dialog_archive_outbox(retry_at,scope_id,dialog_id) WHERE revision>acknowledged_revision;
CREATE TABLE dialog_archive_day (
  scope_id text NOT NULL REFERENCES dialog_archive_scope ON DELETE CASCADE, day date NOT NULL, dialog_id text NOT NULL,
  incoming bigint NOT NULL DEFAULT 0, outgoing bigint NOT NULL DEFAULT 0, media bigint NOT NULL DEFAULT 0,
  ppv_sent bigint NOT NULL DEFAULT 0, ppv_opened bigint NOT NULL DEFAULT 0, offered_cents bigint NOT NULL DEFAULT 0, purchased_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(scope_id,day,dialog_id)
);

CREATE TABLE dialog_archive_debt (
  scope_id text NOT NULL, dialog_id text NOT NULL, owner text NOT NULL, desired bigint NOT NULL, completed bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'WAITING', next_at timestamptz NOT NULL DEFAULT now(),
  lease_device text, reason text, receipt_id text, PRIMARY KEY(scope_id,dialog_id,owner),
  FOREIGN KEY(scope_id,dialog_id) REFERENCES dialog_archive_thread ON DELETE CASCADE
);
CREATE INDEX dialog_archive_debt_due ON dialog_archive_debt(scope_id,next_at,dialog_id,owner) WHERE desired>completed AND status<>'STOPPED';
CREATE INDEX dialog_archive_media_page ON dialog_archive_message(scope_id,dialog_id,message_id) WHERE sender='creator' AND data->'mediaIds'<>'[]'::jsonb;
CREATE INDEX dialog_archive_media_asset ON dialog_archive_message USING gin((data->'mediaIds')) WHERE sender='creator';

CREATE INDEX dialog_archive_receipt_scope_expiry ON dialog_archive_receipt(scope_id,expires_at,command_id);
CREATE INDEX dialog_archive_page_scope_expiry ON dialog_archive_page(scope_id,created_at,dialog_id);

CREATE INDEX dialog_archive_scope_relay ON dialog_archive_scope(relay_next_at,scope_id) WHERE relay_pending;

CREATE INDEX dialog_archive_creator_reply ON dialog_archive_message(scope_id,dialog_id,created_at DESC,length(message_id) DESC,message_id DESC) WHERE sender='creator';

CREATE INDEX dialog_archive_outbox_scope_due ON dialog_archive_outbox(scope_id,retry_at,dialog_id) WHERE revision>acknowledged_revision;
