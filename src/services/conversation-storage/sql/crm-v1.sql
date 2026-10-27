CREATE TABLE IF NOT EXISTS conversation_schema_version (domain text PRIMARY KEY, version integer NOT NULL, checksum text NOT NULL);
CREATE TABLE crm_scope (
  scope_id text PRIMARY KEY, agency_id text NOT NULL, platform_creator_id text NOT NULL,
  discovery_after text NOT NULL DEFAULT '', revision bigint NOT NULL DEFAULT 0, persona_revision bigint NOT NULL DEFAULT 0, persona jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(agency_id,platform_creator_id)
);
CREATE TABLE crm_profile (
  scope_id text NOT NULL REFERENCES crm_scope ON DELETE CASCADE, fan_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 0, profile jsonb NOT NULL DEFAULT '{}', manual_fields jsonb NOT NULL DEFAULT '[]', field_versions jsonb NOT NULL DEFAULT '{}',
  history_epoch text, history_revision bigint NOT NULL DEFAULT 0, rewrite_revision bigint NOT NULL DEFAULT 0,
  accepted_input jsonb, analysis_basis jsonb, reply_token text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,fan_id)
);
CREATE TABLE crm_note (
  scope_id text NOT NULL, fan_id text NOT NULL, note_id text NOT NULL, revision bigint NOT NULL DEFAULT 1,
  text text NOT NULL, author_id text NOT NULL, deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope_id,fan_id,note_id), FOREIGN KEY(scope_id,fan_id) REFERENCES crm_profile ON DELETE CASCADE
);
CREATE TABLE crm_command_receipt (
  scope_id text NOT NULL REFERENCES crm_scope ON DELETE CASCADE, command_id text NOT NULL, request_hash text NOT NULL,
  result jsonb NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(scope_id,command_id)
);
CREATE INDEX crm_command_receipt_expiry ON crm_command_receipt(expires_at,scope_id,command_id);
CREATE TABLE crm_analysis_work (
  scope_id text NOT NULL, fan_id text NOT NULL, generation bigint NOT NULL DEFAULT 1,
  config jsonb NOT NULL, state text NOT NULL DEFAULT 'READY', lane integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(), active_run_id text, failures integer NOT NULL DEFAULT 0, last_error text NOT NULL DEFAULT '', allow_prefix boolean NOT NULL DEFAULT true,
  PRIMARY KEY(scope_id,fan_id), FOREIGN KEY(scope_id,fan_id) REFERENCES crm_profile ON DELETE CASCADE
);
CREATE INDEX crm_analysis_work_due ON crm_analysis_work(scope_id,state,lane,next_run_at,fan_id);
CREATE TABLE crm_analysis_run (
  run_id text PRIMARY KEY, scope_id text NOT NULL, fan_id text NOT NULL, generation bigint NOT NULL,
  lease_token text NOT NULL, lease_device text NOT NULL, lease_actor text NOT NULL, lease_until timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'RUNNING', config jsonb NOT NULL, input jsonb NOT NULL, persona_revision bigint NOT NULL,
  context jsonb, cursor jsonb, pending jsonb, completed_pages integer NOT NULL DEFAULT 0, completed_messages bigint NOT NULL DEFAULT 0,
  input_done boolean NOT NULL DEFAULT false, base_messages bigint NOT NULL DEFAULT 0, reduction_through integer NOT NULL DEFAULT -1, summary jsonb, final jsonb, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(scope_id,fan_id) REFERENCES crm_profile ON DELETE CASCADE
);
CREATE INDEX crm_analysis_run_lease ON crm_analysis_run(state,lease_until);
CREATE INDEX crm_analysis_run_history ON crm_analysis_run(scope_id,fan_id,created_at);
CREATE TABLE crm_analysis_chunk (
  run_id text NOT NULL REFERENCES crm_analysis_run ON DELETE CASCADE, page_number integer NOT NULL,
  page_hash text NOT NULL, summary jsonb NOT NULL, PRIMARY KEY(run_id,page_number)
);
CREATE TABLE crm_audit (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES crm_scope ON DELETE CASCADE, fan_id text,
  actor_id text NOT NULL, kind text NOT NULL, revision bigint NOT NULL, fields jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_audit_expiry ON crm_audit(created_at,id);
CREATE TABLE crm_reply_run (
  token text PRIMARY KEY, scope_id text NOT NULL, fan_id text NOT NULL, device_id text NOT NULL, actor_id text NOT NULL,
  input jsonb NOT NULL, profile_revision bigint NOT NULL, persona_revision bigint NOT NULL, result_hash text,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  FOREIGN KEY(scope_id,fan_id) REFERENCES crm_profile ON DELETE CASCADE
);
CREATE INDEX crm_reply_expiry ON crm_reply_run(expires_at,token);

CREATE INDEX crm_command_receipt_scope_expiry ON crm_command_receipt(scope_id,expires_at,command_id);
CREATE INDEX crm_audit_scope_expiry ON crm_audit(scope_id,created_at,id);
CREATE INDEX crm_analysis_run_gc ON crm_analysis_run(scope_id,updated_at,run_id) WHERE state<>'RUNNING';
CREATE INDEX crm_profile_analysis_pending ON crm_profile(scope_id,fan_id) WHERE history_revision>0 AND (accepted_input IS NULL OR accepted_input->>'epoch' IS DISTINCT FROM history_epoch OR (accepted_input->>'revision')::bigint<history_revision);
