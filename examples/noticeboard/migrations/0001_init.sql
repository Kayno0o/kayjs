-- migrate:up
CREATE TABLE "auth_user" (
  "id" text,
  "email" text,
  "email_verified_at" timestamptz,
  "username" text,
  "username_key" text,
  "password_hash" text,
  "totp_secret" text,
  "totp_enabled_at" timestamptz,
  "totp_last_step" int4 NOT NULL DEFAULT 0,
  "roles" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "session_version" int4 NOT NULL DEFAULT 0,
  "last_sign_in" text,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("email"),
  UNIQUE ("username_key")
);

CREATE TABLE "auth_identity" (
  "id" serial,
  "provider" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "token_expires_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "auth_token" (
  "digest" text,
  "type" text NOT NULL,
  "user_id" text NOT NULL,
  "email" text NOT NULL,
  "redirect" text,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("digest")
);

CREATE TABLE "auth_recovery_code" (
  "id" serial,
  "user_id" text NOT NULL,
  "digest" text NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "auth_bearer_token" (
  "id" text,
  "user_id" text NOT NULL,
  "label" text NOT NULL,
  "digest" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "last_used_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("digest")
);

CREATE TABLE "auth_attempt" (
  "key" text,
  "count" int4 NOT NULL,
  "reset_at" timestamptz NOT NULL,
  PRIMARY KEY ("key")
);

CREATE TABLE "notice" (
  "id" serial,
  "author_id" text NOT NULL,
  "title" varchar(120) NOT NULL,
  "body" text NOT NULL,
  "posted_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

ALTER TABLE "auth_identity" ADD CONSTRAINT "auth_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

ALTER TABLE "auth_recovery_code" ADD CONSTRAINT "auth_recovery_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

ALTER TABLE "auth_bearer_token" ADD CONSTRAINT "auth_bearer_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

ALTER TABLE "notice" ADD CONSTRAINT "notice_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "auth_user" ("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "auth_identity_provider_provider_id_unique" ON "auth_identity" USING btree ("provider", "provider_id");

CREATE INDEX "auth_identity_user_id_idx" ON "auth_identity" USING btree ("user_id");

CREATE INDEX "auth_token_user_id_type_idx" ON "auth_token" USING btree ("user_id", "type");

CREATE UNIQUE INDEX "auth_recovery_code_user_id_digest_unique" ON "auth_recovery_code" USING btree ("user_id", "digest");

CREATE INDEX "auth_bearer_token_user_id_idx" ON "auth_bearer_token" USING btree ("user_id");

CREATE INDEX "notice_posted_at_idx" ON "notice" USING btree ("posted_at");

-- migrate:down
DROP INDEX IF EXISTS "notice_posted_at_idx";
DROP INDEX IF EXISTS "auth_bearer_token_user_id_idx";
DROP INDEX IF EXISTS "auth_recovery_code_user_id_digest_unique";
DROP INDEX IF EXISTS "auth_token_user_id_type_idx";
DROP INDEX IF EXISTS "auth_identity_user_id_idx";
DROP INDEX IF EXISTS "auth_identity_provider_provider_id_unique";
ALTER TABLE "notice" DROP CONSTRAINT IF EXISTS "notice_author_id_fkey";
ALTER TABLE "auth_bearer_token" DROP CONSTRAINT IF EXISTS "auth_bearer_token_user_id_fkey";
ALTER TABLE "auth_recovery_code" DROP CONSTRAINT IF EXISTS "auth_recovery_code_user_id_fkey";
ALTER TABLE "auth_token" DROP CONSTRAINT IF EXISTS "auth_token_user_id_fkey";
ALTER TABLE "auth_identity" DROP CONSTRAINT IF EXISTS "auth_identity_user_id_fkey";
DROP TABLE IF EXISTS "notice";
DROP TABLE IF EXISTS "auth_attempt";
DROP TABLE IF EXISTS "auth_bearer_token";
DROP TABLE IF EXISTS "auth_recovery_code";
DROP TABLE IF EXISTS "auth_token";
DROP TABLE IF EXISTS "auth_identity";
DROP TABLE IF EXISTS "auth_user";