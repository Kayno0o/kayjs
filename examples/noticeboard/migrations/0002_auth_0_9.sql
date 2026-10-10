-- migrate:up
-- Add column "locale" to "auth_user"
ALTER TABLE "auth_user" ADD COLUMN "locale" text;

-- Add column "guest" to "auth_user"
ALTER TABLE "auth_user" ADD COLUMN "guest" bool NOT NULL DEFAULT false;

-- Add column "banned_at" to "auth_user"
ALTER TABLE "auth_user" ADD COLUMN "banned_at" timestamptz;

-- Add column "banned_until" to "auth_user"
ALTER TABLE "auth_user" ADD COLUMN "banned_until" timestamptz;

-- Add column "ban_reason" to "auth_user"
ALTER TABLE "auth_user" ADD COLUMN "ban_reason" text;

-- Add column "scopes" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" ADD COLUMN "scopes" text[];

-- Add column "expires_at" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" ADD COLUMN "expires_at" timestamptz;

-- Create table "auth_session"
CREATE TABLE "auth_session" (
  "id" text NOT NULL,
  "user_id" text NOT NULL,
  "version" int4 NOT NULL,
  "user_agent" text NOT NULL,
  "ip" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  "max_age" int4,
  PRIMARY KEY ("id")
);

-- Create table "auth_passkey"
CREATE TABLE "auth_passkey" (
  "id" text NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "public_key" text NOT NULL,
  "counter" int8 NOT NULL,
  "transports" text[] NOT NULL,
  "multi_device" bool NOT NULL,
  "backed_up" bool NOT NULL,
  "created_at" timestamptz NOT NULL,
  "last_used_at" timestamptz,
  PRIMARY KEY ("id")
);

-- Create table "auth_audit"
CREATE TABLE "auth_audit" (
  "id" text NOT NULL,
  "user_id" text NOT NULL,
  "event" text NOT NULL,
  "detail" text,
  "ip" text NOT NULL,
  "user_agent" text NOT NULL,
  "actor_id" text,
  "at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

-- Create table "auth_organization"
CREATE TABLE "auth_organization" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "slug" text,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("slug")
);

-- Create table "auth_member"
CREATE TABLE "auth_member" (
  "id" serial NOT NULL,
  "organization_id" text NOT NULL,
  "user_id" text NOT NULL,
  "roles" text[] NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

-- Create table "auth_invitation"
CREATE TABLE "auth_invitation" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL,
  "email" text NOT NULL,
  "roles" text[] NOT NULL,
  "invited_by" text,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

-- Add FK constraint on "auth_session"."user_id" → "auth_user"."id"
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

-- Add FK constraint on "auth_passkey"."user_id" → "auth_user"."id"
ALTER TABLE "auth_passkey" ADD CONSTRAINT "auth_passkey_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

-- Add FK constraint on "auth_member"."organization_id" → "auth_organization"."id"
ALTER TABLE "auth_member" ADD CONSTRAINT "auth_member_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth_organization" ("id") ON DELETE CASCADE;

-- Add FK constraint on "auth_member"."user_id" → "auth_user"."id"
ALTER TABLE "auth_member" ADD CONSTRAINT "auth_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

-- Add FK constraint on "auth_invitation"."organization_id" → "auth_organization"."id"
ALTER TABLE "auth_invitation" ADD CONSTRAINT "auth_invitation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth_organization" ("id") ON DELETE CASCADE;

-- Add FK constraint on "auth_invitation"."invited_by" → "auth_user"."id"
ALTER TABLE "auth_invitation" ADD CONSTRAINT "auth_invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth_user" ("id") ON DELETE SET NULL;

-- Create index "auth_user_created_at_idx" on "auth_user" (created_at)
CREATE INDEX "auth_user_created_at_idx" ON "auth_user" USING btree ("created_at");

-- Create index "auth_session_user_id_idx" on "auth_session" (user_id)
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");

-- Create index "auth_passkey_user_id_idx" on "auth_passkey" (user_id)
CREATE INDEX "auth_passkey_user_id_idx" ON "auth_passkey" USING btree ("user_id");

-- Create index "auth_audit_user_id_at_idx" on "auth_audit" (user_id, at)
CREATE INDEX "auth_audit_user_id_at_idx" ON "auth_audit" USING btree ("user_id", "at");

-- Create index "auth_audit_at_idx" on "auth_audit" (at)
CREATE INDEX "auth_audit_at_idx" ON "auth_audit" USING btree ("at");

-- Create index "auth_member_organization_id_user_id_unique" on "auth_member" (organization_id, user_id)
CREATE UNIQUE INDEX "auth_member_organization_id_user_id_unique" ON "auth_member" USING btree ("organization_id", "user_id");

-- Create index "auth_member_user_id_idx" on "auth_member" (user_id)
CREATE INDEX "auth_member_user_id_idx" ON "auth_member" USING btree ("user_id");

-- Create index "auth_invitation_organization_id_idx" on "auth_invitation" (organization_id)
CREATE INDEX "auth_invitation_organization_id_idx" ON "auth_invitation" USING btree ("organization_id");

-- Create index "auth_invitation_email_idx" on "auth_invitation" (email)
CREATE INDEX "auth_invitation_email_idx" ON "auth_invitation" USING btree ("email");

-- migrate:down
-- Revert: Create index "auth_invitation_email_idx" on "auth_invitation" (email)
DROP INDEX IF EXISTS "auth_invitation_email_idx";

-- Revert: Create index "auth_invitation_organization_id_idx" on "auth_invitation" (organization_id)
DROP INDEX IF EXISTS "auth_invitation_organization_id_idx";

-- Revert: Create index "auth_member_user_id_idx" on "auth_member" (user_id)
DROP INDEX IF EXISTS "auth_member_user_id_idx";

-- Revert: Create index "auth_member_organization_id_user_id_unique" on "auth_member" (organization_id, user_id)
DROP INDEX IF EXISTS "auth_member_organization_id_user_id_unique";

-- Revert: Create index "auth_audit_at_idx" on "auth_audit" (at)
DROP INDEX IF EXISTS "auth_audit_at_idx";

-- Revert: Create index "auth_audit_user_id_at_idx" on "auth_audit" (user_id, at)
DROP INDEX IF EXISTS "auth_audit_user_id_at_idx";

-- Revert: Create index "auth_passkey_user_id_idx" on "auth_passkey" (user_id)
DROP INDEX IF EXISTS "auth_passkey_user_id_idx";

-- Revert: Create index "auth_session_user_id_idx" on "auth_session" (user_id)
DROP INDEX IF EXISTS "auth_session_user_id_idx";

-- Revert: Create index "auth_user_created_at_idx" on "auth_user" (created_at)
DROP INDEX IF EXISTS "auth_user_created_at_idx";

-- Revert: Add FK constraint on "auth_invitation"."invited_by" → "auth_user"."id"
ALTER TABLE "auth_invitation" DROP CONSTRAINT IF EXISTS "auth_invitation_invited_by_fkey";

-- Revert: Add FK constraint on "auth_invitation"."organization_id" → "auth_organization"."id"
ALTER TABLE "auth_invitation" DROP CONSTRAINT IF EXISTS "auth_invitation_organization_id_fkey";

-- Revert: Add FK constraint on "auth_member"."user_id" → "auth_user"."id"
ALTER TABLE "auth_member" DROP CONSTRAINT IF EXISTS "auth_member_user_id_fkey";

-- Revert: Add FK constraint on "auth_member"."organization_id" → "auth_organization"."id"
ALTER TABLE "auth_member" DROP CONSTRAINT IF EXISTS "auth_member_organization_id_fkey";

-- Revert: Add FK constraint on "auth_passkey"."user_id" → "auth_user"."id"
ALTER TABLE "auth_passkey" DROP CONSTRAINT IF EXISTS "auth_passkey_user_id_fkey";

-- Revert: Add FK constraint on "auth_session"."user_id" → "auth_user"."id"
ALTER TABLE "auth_session" DROP CONSTRAINT IF EXISTS "auth_session_user_id_fkey";

-- Revert: Create table "auth_invitation"
DROP TABLE IF EXISTS "auth_invitation";

-- Revert: Create table "auth_member"
DROP TABLE IF EXISTS "auth_member";

-- Revert: Create table "auth_organization"
DROP TABLE IF EXISTS "auth_organization";

-- Revert: Create table "auth_audit"
DROP TABLE IF EXISTS "auth_audit";

-- Revert: Create table "auth_passkey"
DROP TABLE IF EXISTS "auth_passkey";

-- Revert: Create table "auth_session"
DROP TABLE IF EXISTS "auth_session";

-- Revert: Add column "expires_at" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" DROP COLUMN IF EXISTS "expires_at";

-- Revert: Add column "scopes" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" DROP COLUMN IF EXISTS "scopes";

-- Revert: Add column "ban_reason" to "auth_user"
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "ban_reason";

-- Revert: Add column "banned_until" to "auth_user"
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "banned_until";

-- Revert: Add column "banned_at" to "auth_user"
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "banned_at";

-- Revert: Add column "guest" to "auth_user"
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "guest";

-- Revert: Add column "locale" to "auth_user"
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "locale";