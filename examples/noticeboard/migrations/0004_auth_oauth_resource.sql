-- migrate:up
-- Add column "resource" to "auth_oauth_code"
ALTER TABLE "auth_oauth_code" ADD COLUMN "resource" text;

-- Add column "resource" to "auth_oauth_refresh"
ALTER TABLE "auth_oauth_refresh" ADD COLUMN "resource" text;

-- Add column "oauth_resource" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" ADD COLUMN "oauth_resource" text;

-- migrate:down
-- Revert: Add column "oauth_resource" to "auth_bearer_token"
ALTER TABLE "auth_bearer_token" DROP COLUMN IF EXISTS "oauth_resource";

-- Revert: Add column "resource" to "auth_oauth_refresh"
ALTER TABLE "auth_oauth_refresh" DROP COLUMN IF EXISTS "resource";

-- Revert: Add column "resource" to "auth_oauth_code"
ALTER TABLE "auth_oauth_code" DROP COLUMN IF EXISTS "resource";
