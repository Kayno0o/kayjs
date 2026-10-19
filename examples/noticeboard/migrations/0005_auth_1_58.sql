-- migrate:up
-- Add column "data" to "auth_user"
ALTER TABLE "auth_user" ADD COLUMN "data" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Add column "user_verified" to "auth_passkey"
ALTER TABLE "auth_passkey" ADD COLUMN "user_verified" bool NOT NULL DEFAULT false;

-- Create index "auth_user_guest_created_at_idx" on "auth_user" (guest, created_at)
CREATE INDEX "auth_user_guest_created_at_idx" ON "auth_user" USING btree ("guest", "created_at");

-- migrate:down
-- Revert: Create index "auth_user_guest_created_at_idx" on "auth_user" (guest, created_at)
DROP INDEX IF EXISTS "auth_user_guest_created_at_idx";

-- Revert: Add column "user_verified" to "auth_passkey"
ALTER TABLE "auth_passkey" DROP COLUMN IF EXISTS "user_verified";

-- Revert: Add column "data" to "auth_user"
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "data";