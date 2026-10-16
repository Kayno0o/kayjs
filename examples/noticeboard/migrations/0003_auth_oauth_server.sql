-- migrate:up
-- Add column "oauth_client" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" ADD COLUMN "oauth_client" text;

-- Add column "oauth_family" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" ADD COLUMN "oauth_family" text;

-- Create table "auth_oauth_client"
CREATE TABLE "auth_oauth_client" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

-- Create table "auth_oauth_grant"
CREATE TABLE "auth_oauth_grant" (
  "id" serial NOT NULL,
  "user_id" text NOT NULL,
  "client_id" text NOT NULL,
  "client_name" text NOT NULL,
  "scopes" text[],
  "created_at" timestamptz NOT NULL,
  "last_used_at" timestamptz,
  PRIMARY KEY ("id")
);

-- Create table "auth_oauth_code"
CREATE TABLE "auth_oauth_code" (
  "digest" text NOT NULL,
  "user_id" text NOT NULL,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "challenge" text NOT NULL,
  "scopes" text[],
  "family" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  PRIMARY KEY ("digest")
);

-- Create table "auth_oauth_refresh"
CREATE TABLE "auth_oauth_refresh" (
  "digest" text NOT NULL,
  "user_id" text NOT NULL,
  "client_id" text NOT NULL,
  "scopes" text[],
  "family" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  PRIMARY KEY ("digest")
);

-- Add FK constraint on "auth_oauth_grant"."user_id" → "auth_user"."id"
ALTER TABLE "auth_oauth_grant" ADD CONSTRAINT "auth_oauth_grant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

-- Add FK constraint on "auth_oauth_code"."user_id" → "auth_user"."id"
ALTER TABLE "auth_oauth_code" ADD CONSTRAINT "auth_oauth_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

-- Add FK constraint on "auth_oauth_refresh"."user_id" → "auth_user"."id"
ALTER TABLE "auth_oauth_refresh" ADD CONSTRAINT "auth_oauth_refresh_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

-- Create index "auth_token_expires_at_idx" on "auth_token" (expires_at)
CREATE INDEX "auth_token_expires_at_idx" ON "auth_token" USING btree ("expires_at");

-- Create index "auth_bearer_token_expires_at_idx" on "auth_bearer_token" (expires_at)
CREATE INDEX "auth_bearer_token_expires_at_idx" ON "auth_bearer_token" USING btree ("expires_at");

-- Create index "auth_bearer_token_user_id_oauth_client_idx" on "auth_bearer_token" (user_id, oauth_client)
CREATE INDEX "auth_bearer_token_user_id_oauth_client_idx" ON "auth_bearer_token" USING btree ("user_id", "oauth_client");

-- Create index "auth_bearer_token_user_id_oauth_family_idx" on "auth_bearer_token" (user_id, oauth_family)
CREATE INDEX "auth_bearer_token_user_id_oauth_family_idx" ON "auth_bearer_token" USING btree ("user_id", "oauth_family");

-- Create index "auth_session_last_seen_at_idx" on "auth_session" (last_seen_at)
CREATE INDEX "auth_session_last_seen_at_idx" ON "auth_session" USING btree ("last_seen_at");

-- Create index "auth_session_created_at_idx" on "auth_session" (created_at)
CREATE INDEX "auth_session_created_at_idx" ON "auth_session" USING btree ("created_at");

-- Create index "auth_audit_actor_id_idx" on "auth_audit" (actor_id)
CREATE INDEX "auth_audit_actor_id_idx" ON "auth_audit" USING btree ("actor_id");

-- Create index "auth_invitation_expires_at_idx" on "auth_invitation" (expires_at)
CREATE INDEX "auth_invitation_expires_at_idx" ON "auth_invitation" USING btree ("expires_at");

-- Create index "auth_attempt_reset_at_idx" on "auth_attempt" (reset_at)
CREATE INDEX "auth_attempt_reset_at_idx" ON "auth_attempt" USING btree ("reset_at");

-- Create index "auth_oauth_client_created_at_idx" on "auth_oauth_client" (created_at)
CREATE INDEX "auth_oauth_client_created_at_idx" ON "auth_oauth_client" USING btree ("created_at");

-- Create index "auth_oauth_grant_user_id_client_id_unique" on "auth_oauth_grant" (user_id, client_id)
CREATE UNIQUE INDEX "auth_oauth_grant_user_id_client_id_unique" ON "auth_oauth_grant" USING btree ("user_id", "client_id");

-- Create index "auth_oauth_grant_client_id_idx" on "auth_oauth_grant" (client_id)
CREATE INDEX "auth_oauth_grant_client_id_idx" ON "auth_oauth_grant" USING btree ("client_id");

-- Create index "auth_oauth_code_expires_at_idx" on "auth_oauth_code" (expires_at)
CREATE INDEX "auth_oauth_code_expires_at_idx" ON "auth_oauth_code" USING btree ("expires_at");

-- Create index "auth_oauth_code_user_id_idx" on "auth_oauth_code" (user_id)
CREATE INDEX "auth_oauth_code_user_id_idx" ON "auth_oauth_code" USING btree ("user_id");

-- Create index "auth_oauth_refresh_user_id_family_idx" on "auth_oauth_refresh" (user_id, family)
CREATE INDEX "auth_oauth_refresh_user_id_family_idx" ON "auth_oauth_refresh" USING btree ("user_id", "family");

-- Create index "auth_oauth_refresh_user_id_client_id_idx" on "auth_oauth_refresh" (user_id, client_id)
CREATE INDEX "auth_oauth_refresh_user_id_client_id_idx" ON "auth_oauth_refresh" USING btree ("user_id", "client_id");

-- Create index "auth_oauth_refresh_expires_at_idx" on "auth_oauth_refresh" (expires_at)
CREATE INDEX "auth_oauth_refresh_expires_at_idx" ON "auth_oauth_refresh" USING btree ("expires_at");

-- migrate:down
-- Revert: Create index "auth_oauth_refresh_expires_at_idx" on "auth_oauth_refresh" (expires_at)
DROP INDEX IF EXISTS "auth_oauth_refresh_expires_at_idx";

-- Revert: Create index "auth_oauth_refresh_user_id_client_id_idx" on "auth_oauth_refresh" (user_id, client_id)
DROP INDEX IF EXISTS "auth_oauth_refresh_user_id_client_id_idx";

-- Revert: Create index "auth_oauth_refresh_user_id_family_idx" on "auth_oauth_refresh" (user_id, family)
DROP INDEX IF EXISTS "auth_oauth_refresh_user_id_family_idx";

-- Revert: Create index "auth_oauth_code_user_id_idx" on "auth_oauth_code" (user_id)
DROP INDEX IF EXISTS "auth_oauth_code_user_id_idx";

-- Revert: Create index "auth_oauth_code_expires_at_idx" on "auth_oauth_code" (expires_at)
DROP INDEX IF EXISTS "auth_oauth_code_expires_at_idx";

-- Revert: Create index "auth_oauth_grant_client_id_idx" on "auth_oauth_grant" (client_id)
DROP INDEX IF EXISTS "auth_oauth_grant_client_id_idx";

-- Revert: Create index "auth_oauth_grant_user_id_client_id_unique" on "auth_oauth_grant" (user_id, client_id)
DROP INDEX IF EXISTS "auth_oauth_grant_user_id_client_id_unique";

-- Revert: Create index "auth_oauth_client_created_at_idx" on "auth_oauth_client" (created_at)
DROP INDEX IF EXISTS "auth_oauth_client_created_at_idx";

-- Revert: Create index "auth_attempt_reset_at_idx" on "auth_attempt" (reset_at)
DROP INDEX IF EXISTS "auth_attempt_reset_at_idx";

-- Revert: Create index "auth_invitation_expires_at_idx" on "auth_invitation" (expires_at)
DROP INDEX IF EXISTS "auth_invitation_expires_at_idx";

-- Revert: Create index "auth_audit_actor_id_idx" on "auth_audit" (actor_id)
DROP INDEX IF EXISTS "auth_audit_actor_id_idx";

-- Revert: Create index "auth_session_created_at_idx" on "auth_session" (created_at)
DROP INDEX IF EXISTS "auth_session_created_at_idx";

-- Revert: Create index "auth_session_last_seen_at_idx" on "auth_session" (last_seen_at)
DROP INDEX IF EXISTS "auth_session_last_seen_at_idx";

-- Revert: Create index "auth_bearer_token_user_id_oauth_family_idx" on "auth_bearer_token" (user_id, oauth_family)
DROP INDEX IF EXISTS "auth_bearer_token_user_id_oauth_family_idx";

-- Revert: Create index "auth_bearer_token_user_id_oauth_client_idx" on "auth_bearer_token" (user_id, oauth_client)
DROP INDEX IF EXISTS "auth_bearer_token_user_id_oauth_client_idx";

-- Revert: Create index "auth_bearer_token_expires_at_idx" on "auth_bearer_token" (expires_at)
DROP INDEX IF EXISTS "auth_bearer_token_expires_at_idx";

-- Revert: Create index "auth_token_expires_at_idx" on "auth_token" (expires_at)
DROP INDEX IF EXISTS "auth_token_expires_at_idx";

-- Revert: Add FK constraint on "auth_oauth_refresh"."user_id" → "auth_user"."id"
ALTER TABLE "auth_oauth_refresh" DROP CONSTRAINT IF EXISTS "auth_oauth_refresh_user_id_fkey";

-- Revert: Add FK constraint on "auth_oauth_code"."user_id" → "auth_user"."id"
ALTER TABLE "auth_oauth_code" DROP CONSTRAINT IF EXISTS "auth_oauth_code_user_id_fkey";

-- Revert: Add FK constraint on "auth_oauth_grant"."user_id" → "auth_user"."id"
ALTER TABLE "auth_oauth_grant" DROP CONSTRAINT IF EXISTS "auth_oauth_grant_user_id_fkey";

-- Revert: Create table "auth_oauth_refresh"
DROP TABLE IF EXISTS "auth_oauth_refresh";

-- Revert: Create table "auth_oauth_code"
DROP TABLE IF EXISTS "auth_oauth_code";

-- Revert: Create table "auth_oauth_grant"
DROP TABLE IF EXISTS "auth_oauth_grant";

-- Revert: Create table "auth_oauth_client"
DROP TABLE IF EXISTS "auth_oauth_client";

-- Revert: Add column "oauth_family" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" DROP COLUMN IF EXISTS "oauth_family";

-- Revert: Add column "oauth_client" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" DROP COLUMN IF EXISTS "oauth_client";