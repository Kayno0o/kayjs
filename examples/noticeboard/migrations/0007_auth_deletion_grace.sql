-- migrate:up
-- Add column "delete_at" to "kay_users"
ALTER TABLE "kay_users" ADD COLUMN "delete_at" timestamptz;

-- Create index "kay_users_delete_at_idx" on "kay_users" (delete_at)
CREATE INDEX "kay_users_delete_at_idx" ON "kay_users" USING btree ("delete_at");

-- migrate:down
-- Revert: Create index "kay_users_delete_at_idx" on "kay_users" (delete_at)
DROP INDEX IF EXISTS "kay_users_delete_at_idx";

-- Revert: Add column "delete_at" to "kay_users"
ALTER TABLE "kay_users" DROP COLUMN IF EXISTS "delete_at";
