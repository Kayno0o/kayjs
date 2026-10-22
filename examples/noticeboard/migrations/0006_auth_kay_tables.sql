-- migrate:up
-- Rename table "auth_user" to "kay_users"
ALTER TABLE "auth_user" RENAME TO "kay_users";

-- Rename table "auth_identity" to "kay_identities"
ALTER TABLE "auth_identity" RENAME TO "kay_identities";

-- Rename table "auth_token" to "kay_tokens"
ALTER TABLE "auth_token" RENAME TO "kay_tokens";

-- Rename table "auth_recovery_code" to "kay_recovery_codes"
ALTER TABLE "auth_recovery_code" RENAME TO "kay_recovery_codes";

-- Rename table "auth_bearer_token" to "kay_bearer_tokens"
ALTER TABLE "auth_bearer_token" RENAME TO "kay_bearer_tokens";

-- Rename table "auth_session" to "kay_auth_sessions"
ALTER TABLE "auth_session" RENAME TO "kay_auth_sessions";

-- Rename table "auth_passkey" to "kay_passkeys"
ALTER TABLE "auth_passkey" RENAME TO "kay_passkeys";

-- Rename table "auth_audit" to "kay_audits"
ALTER TABLE "auth_audit" RENAME TO "kay_audits";

-- Rename table "auth_organization" to "kay_organizations"
ALTER TABLE "auth_organization" RENAME TO "kay_organizations";

-- Rename table "auth_member" to "kay_members"
ALTER TABLE "auth_member" RENAME TO "kay_members";

-- Rename table "auth_invitation" to "kay_invitations"
ALTER TABLE "auth_invitation" RENAME TO "kay_invitations";

-- Rename table "auth_attempt" to "kay_attempts"
ALTER TABLE "auth_attempt" RENAME TO "kay_attempts";

-- Rename table "auth_oauth_client" to "kay_oauth_clients"
ALTER TABLE "auth_oauth_client" RENAME TO "kay_oauth_clients";

-- Rename table "auth_oauth_grant" to "kay_oauth_grants"
ALTER TABLE "auth_oauth_grant" RENAME TO "kay_oauth_grants";

-- Rename table "auth_oauth_code" to "kay_oauth_codes"
ALTER TABLE "auth_oauth_code" RENAME TO "kay_oauth_codes";

-- Rename table "auth_oauth_refresh" to "kay_oauth_refresh_tokens"
ALTER TABLE "auth_oauth_refresh" RENAME TO "kay_oauth_refresh_tokens";

-- Rename index "auth_attempt_reset_at_idx" to "kay_attempts_reset_at_idx"
ALTER INDEX "auth_attempt_reset_at_idx" RENAME TO "kay_attempts_reset_at_idx";

-- Rename index "auth_audit_actor_id_idx" to "kay_audits_actor_id_idx"
ALTER INDEX "auth_audit_actor_id_idx" RENAME TO "kay_audits_actor_id_idx";

-- Rename index "auth_audit_at_idx" to "kay_audits_at_idx"
ALTER INDEX "auth_audit_at_idx" RENAME TO "kay_audits_at_idx";

-- Rename index "auth_audit_user_id_at_idx" to "kay_audits_user_id_at_idx"
ALTER INDEX "auth_audit_user_id_at_idx" RENAME TO "kay_audits_user_id_at_idx";

-- Rename index "auth_bearer_token_expires_at_idx" to "kay_bearer_tokens_expires_at_idx"
ALTER INDEX "auth_bearer_token_expires_at_idx" RENAME TO "kay_bearer_tokens_expires_at_idx";

-- Rename index "auth_bearer_token_user_id_idx" to "kay_bearer_tokens_user_id_idx"
ALTER INDEX "auth_bearer_token_user_id_idx" RENAME TO "kay_bearer_tokens_user_id_idx";

-- Rename index "auth_bearer_token_user_id_oauth_client_idx" to "kay_bearer_tokens_user_id_oauth_client_idx"
ALTER INDEX "auth_bearer_token_user_id_oauth_client_idx" RENAME TO "kay_bearer_tokens_user_id_oauth_client_idx";

-- Rename index "auth_bearer_token_user_id_oauth_family_idx" to "kay_bearer_tokens_user_id_oauth_family_idx"
ALTER INDEX "auth_bearer_token_user_id_oauth_family_idx" RENAME TO "kay_bearer_tokens_user_id_oauth_family_idx";

-- Rename index "auth_identity_provider_provider_id_unique" to "kay_identities_provider_provider_id_unique"
ALTER INDEX "auth_identity_provider_provider_id_unique" RENAME TO "kay_identities_provider_provider_id_unique";

-- Rename index "auth_identity_user_id_idx" to "kay_identities_user_id_idx"
ALTER INDEX "auth_identity_user_id_idx" RENAME TO "kay_identities_user_id_idx";

-- Rename index "auth_invitation_email_idx" to "kay_invitations_email_idx"
ALTER INDEX "auth_invitation_email_idx" RENAME TO "kay_invitations_email_idx";

-- Rename index "auth_invitation_expires_at_idx" to "kay_invitations_expires_at_idx"
ALTER INDEX "auth_invitation_expires_at_idx" RENAME TO "kay_invitations_expires_at_idx";

-- Rename index "auth_invitation_organization_id_idx" to "kay_invitations_organization_id_idx"
ALTER INDEX "auth_invitation_organization_id_idx" RENAME TO "kay_invitations_organization_id_idx";

-- Rename index "auth_member_organization_id_user_id_unique" to "kay_members_organization_id_user_id_unique"
ALTER INDEX "auth_member_organization_id_user_id_unique" RENAME TO "kay_members_organization_id_user_id_unique";

-- Rename index "auth_member_user_id_idx" to "kay_members_user_id_idx"
ALTER INDEX "auth_member_user_id_idx" RENAME TO "kay_members_user_id_idx";

-- Rename index "auth_oauth_client_created_at_idx" to "kay_oauth_clients_created_at_idx"
ALTER INDEX "auth_oauth_client_created_at_idx" RENAME TO "kay_oauth_clients_created_at_idx";

-- Rename index "auth_oauth_code_expires_at_idx" to "kay_oauth_codes_expires_at_idx"
ALTER INDEX "auth_oauth_code_expires_at_idx" RENAME TO "kay_oauth_codes_expires_at_idx";

-- Rename index "auth_oauth_code_user_id_idx" to "kay_oauth_codes_user_id_idx"
ALTER INDEX "auth_oauth_code_user_id_idx" RENAME TO "kay_oauth_codes_user_id_idx";

-- Rename index "auth_oauth_grant_client_id_idx" to "kay_oauth_grants_client_id_idx"
ALTER INDEX "auth_oauth_grant_client_id_idx" RENAME TO "kay_oauth_grants_client_id_idx";

-- Rename index "auth_oauth_grant_user_id_client_id_unique" to "kay_oauth_grants_user_id_client_id_unique"
ALTER INDEX "auth_oauth_grant_user_id_client_id_unique" RENAME TO "kay_oauth_grants_user_id_client_id_unique";

-- Rename index "auth_oauth_refresh_expires_at_idx" to "kay_oauth_refresh_tokens_expires_at_idx"
ALTER INDEX "auth_oauth_refresh_expires_at_idx" RENAME TO "kay_oauth_refresh_tokens_expires_at_idx";

-- Rename index "auth_oauth_refresh_user_id_client_id_idx" to "kay_oauth_refresh_tokens_user_id_client_id_idx"
ALTER INDEX "auth_oauth_refresh_user_id_client_id_idx" RENAME TO "kay_oauth_refresh_tokens_user_id_client_id_idx";

-- Rename index "auth_oauth_refresh_user_id_family_idx" to "kay_oauth_refresh_tokens_user_id_family_idx"
ALTER INDEX "auth_oauth_refresh_user_id_family_idx" RENAME TO "kay_oauth_refresh_tokens_user_id_family_idx";

-- Rename index "auth_passkey_user_id_idx" to "kay_passkeys_user_id_idx"
ALTER INDEX "auth_passkey_user_id_idx" RENAME TO "kay_passkeys_user_id_idx";

-- Rename index "auth_recovery_code_user_id_digest_unique" to "kay_recovery_codes_user_id_digest_unique"
ALTER INDEX "auth_recovery_code_user_id_digest_unique" RENAME TO "kay_recovery_codes_user_id_digest_unique";

-- Rename index "auth_session_created_at_idx" to "kay_auth_sessions_created_at_idx"
ALTER INDEX "auth_session_created_at_idx" RENAME TO "kay_auth_sessions_created_at_idx";

-- Rename index "auth_session_last_seen_at_idx" to "kay_auth_sessions_last_seen_at_idx"
ALTER INDEX "auth_session_last_seen_at_idx" RENAME TO "kay_auth_sessions_last_seen_at_idx";

-- Rename index "auth_session_user_id_idx" to "kay_auth_sessions_user_id_idx"
ALTER INDEX "auth_session_user_id_idx" RENAME TO "kay_auth_sessions_user_id_idx";

-- Rename index "auth_token_expires_at_idx" to "kay_tokens_expires_at_idx"
ALTER INDEX "auth_token_expires_at_idx" RENAME TO "kay_tokens_expires_at_idx";

-- Rename index "auth_token_user_id_type_idx" to "kay_tokens_user_id_type_idx"
ALTER INDEX "auth_token_user_id_type_idx" RENAME TO "kay_tokens_user_id_type_idx";

-- Rename index "auth_user_created_at_idx" to "kay_users_created_at_idx"
ALTER INDEX "auth_user_created_at_idx" RENAME TO "kay_users_created_at_idx";

-- Rename index "auth_user_guest_created_at_idx" to "kay_users_guest_created_at_idx"
ALTER INDEX "auth_user_guest_created_at_idx" RENAME TO "kay_users_guest_created_at_idx";

-- migrate:down
-- Revert: Rename index "auth_user_guest_created_at_idx" to "kay_users_guest_created_at_idx"
ALTER INDEX "kay_users_guest_created_at_idx" RENAME TO "auth_user_guest_created_at_idx";

-- Revert: Rename index "auth_user_created_at_idx" to "kay_users_created_at_idx"
ALTER INDEX "kay_users_created_at_idx" RENAME TO "auth_user_created_at_idx";

-- Revert: Rename index "auth_token_user_id_type_idx" to "kay_tokens_user_id_type_idx"
ALTER INDEX "kay_tokens_user_id_type_idx" RENAME TO "auth_token_user_id_type_idx";

-- Revert: Rename index "auth_token_expires_at_idx" to "kay_tokens_expires_at_idx"
ALTER INDEX "kay_tokens_expires_at_idx" RENAME TO "auth_token_expires_at_idx";

-- Revert: Rename index "auth_session_user_id_idx" to "kay_auth_sessions_user_id_idx"
ALTER INDEX "kay_auth_sessions_user_id_idx" RENAME TO "auth_session_user_id_idx";

-- Revert: Rename index "auth_session_last_seen_at_idx" to "kay_auth_sessions_last_seen_at_idx"
ALTER INDEX "kay_auth_sessions_last_seen_at_idx" RENAME TO "auth_session_last_seen_at_idx";

-- Revert: Rename index "auth_session_created_at_idx" to "kay_auth_sessions_created_at_idx"
ALTER INDEX "kay_auth_sessions_created_at_idx" RENAME TO "auth_session_created_at_idx";

-- Revert: Rename index "auth_recovery_code_user_id_digest_unique" to "kay_recovery_codes_user_id_digest_unique"
ALTER INDEX "kay_recovery_codes_user_id_digest_unique" RENAME TO "auth_recovery_code_user_id_digest_unique";

-- Revert: Rename index "auth_passkey_user_id_idx" to "kay_passkeys_user_id_idx"
ALTER INDEX "kay_passkeys_user_id_idx" RENAME TO "auth_passkey_user_id_idx";

-- Revert: Rename index "auth_oauth_refresh_user_id_family_idx" to "kay_oauth_refresh_tokens_user_id_family_idx"
ALTER INDEX "kay_oauth_refresh_tokens_user_id_family_idx" RENAME TO "auth_oauth_refresh_user_id_family_idx";

-- Revert: Rename index "auth_oauth_refresh_user_id_client_id_idx" to "kay_oauth_refresh_tokens_user_id_client_id_idx"
ALTER INDEX "kay_oauth_refresh_tokens_user_id_client_id_idx" RENAME TO "auth_oauth_refresh_user_id_client_id_idx";

-- Revert: Rename index "auth_oauth_refresh_expires_at_idx" to "kay_oauth_refresh_tokens_expires_at_idx"
ALTER INDEX "kay_oauth_refresh_tokens_expires_at_idx" RENAME TO "auth_oauth_refresh_expires_at_idx";

-- Revert: Rename index "auth_oauth_grant_user_id_client_id_unique" to "kay_oauth_grants_user_id_client_id_unique"
ALTER INDEX "kay_oauth_grants_user_id_client_id_unique" RENAME TO "auth_oauth_grant_user_id_client_id_unique";

-- Revert: Rename index "auth_oauth_grant_client_id_idx" to "kay_oauth_grants_client_id_idx"
ALTER INDEX "kay_oauth_grants_client_id_idx" RENAME TO "auth_oauth_grant_client_id_idx";

-- Revert: Rename index "auth_oauth_code_user_id_idx" to "kay_oauth_codes_user_id_idx"
ALTER INDEX "kay_oauth_codes_user_id_idx" RENAME TO "auth_oauth_code_user_id_idx";

-- Revert: Rename index "auth_oauth_code_expires_at_idx" to "kay_oauth_codes_expires_at_idx"
ALTER INDEX "kay_oauth_codes_expires_at_idx" RENAME TO "auth_oauth_code_expires_at_idx";

-- Revert: Rename index "auth_oauth_client_created_at_idx" to "kay_oauth_clients_created_at_idx"
ALTER INDEX "kay_oauth_clients_created_at_idx" RENAME TO "auth_oauth_client_created_at_idx";

-- Revert: Rename index "auth_member_user_id_idx" to "kay_members_user_id_idx"
ALTER INDEX "kay_members_user_id_idx" RENAME TO "auth_member_user_id_idx";

-- Revert: Rename index "auth_member_organization_id_user_id_unique" to "kay_members_organization_id_user_id_unique"
ALTER INDEX "kay_members_organization_id_user_id_unique" RENAME TO "auth_member_organization_id_user_id_unique";

-- Revert: Rename index "auth_invitation_organization_id_idx" to "kay_invitations_organization_id_idx"
ALTER INDEX "kay_invitations_organization_id_idx" RENAME TO "auth_invitation_organization_id_idx";

-- Revert: Rename index "auth_invitation_expires_at_idx" to "kay_invitations_expires_at_idx"
ALTER INDEX "kay_invitations_expires_at_idx" RENAME TO "auth_invitation_expires_at_idx";

-- Revert: Rename index "auth_invitation_email_idx" to "kay_invitations_email_idx"
ALTER INDEX "kay_invitations_email_idx" RENAME TO "auth_invitation_email_idx";

-- Revert: Rename index "auth_identity_user_id_idx" to "kay_identities_user_id_idx"
ALTER INDEX "kay_identities_user_id_idx" RENAME TO "auth_identity_user_id_idx";

-- Revert: Rename index "auth_identity_provider_provider_id_unique" to "kay_identities_provider_provider_id_unique"
ALTER INDEX "kay_identities_provider_provider_id_unique" RENAME TO "auth_identity_provider_provider_id_unique";

-- Revert: Rename index "auth_bearer_token_user_id_oauth_family_idx" to "kay_bearer_tokens_user_id_oauth_family_idx"
ALTER INDEX "kay_bearer_tokens_user_id_oauth_family_idx" RENAME TO "auth_bearer_token_user_id_oauth_family_idx";

-- Revert: Rename index "auth_bearer_token_user_id_oauth_client_idx" to "kay_bearer_tokens_user_id_oauth_client_idx"
ALTER INDEX "kay_bearer_tokens_user_id_oauth_client_idx" RENAME TO "auth_bearer_token_user_id_oauth_client_idx";

-- Revert: Rename index "auth_bearer_token_user_id_idx" to "kay_bearer_tokens_user_id_idx"
ALTER INDEX "kay_bearer_tokens_user_id_idx" RENAME TO "auth_bearer_token_user_id_idx";

-- Revert: Rename index "auth_bearer_token_expires_at_idx" to "kay_bearer_tokens_expires_at_idx"
ALTER INDEX "kay_bearer_tokens_expires_at_idx" RENAME TO "auth_bearer_token_expires_at_idx";

-- Revert: Rename index "auth_audit_user_id_at_idx" to "kay_audits_user_id_at_idx"
ALTER INDEX "kay_audits_user_id_at_idx" RENAME TO "auth_audit_user_id_at_idx";

-- Revert: Rename index "auth_audit_at_idx" to "kay_audits_at_idx"
ALTER INDEX "kay_audits_at_idx" RENAME TO "auth_audit_at_idx";

-- Revert: Rename index "auth_audit_actor_id_idx" to "kay_audits_actor_id_idx"
ALTER INDEX "kay_audits_actor_id_idx" RENAME TO "auth_audit_actor_id_idx";

-- Revert: Rename index "auth_attempt_reset_at_idx" to "kay_attempts_reset_at_idx"
ALTER INDEX "kay_attempts_reset_at_idx" RENAME TO "auth_attempt_reset_at_idx";

-- Revert: Rename table "auth_oauth_refresh" to "kay_oauth_refresh_tokens"
ALTER TABLE "kay_oauth_refresh_tokens" RENAME TO "auth_oauth_refresh";

-- Revert: Rename table "auth_oauth_code" to "kay_oauth_codes"
ALTER TABLE "kay_oauth_codes" RENAME TO "auth_oauth_code";

-- Revert: Rename table "auth_oauth_grant" to "kay_oauth_grants"
ALTER TABLE "kay_oauth_grants" RENAME TO "auth_oauth_grant";

-- Revert: Rename table "auth_oauth_client" to "kay_oauth_clients"
ALTER TABLE "kay_oauth_clients" RENAME TO "auth_oauth_client";

-- Revert: Rename table "auth_attempt" to "kay_attempts"
ALTER TABLE "kay_attempts" RENAME TO "auth_attempt";

-- Revert: Rename table "auth_invitation" to "kay_invitations"
ALTER TABLE "kay_invitations" RENAME TO "auth_invitation";

-- Revert: Rename table "auth_member" to "kay_members"
ALTER TABLE "kay_members" RENAME TO "auth_member";

-- Revert: Rename table "auth_organization" to "kay_organizations"
ALTER TABLE "kay_organizations" RENAME TO "auth_organization";

-- Revert: Rename table "auth_audit" to "kay_audits"
ALTER TABLE "kay_audits" RENAME TO "auth_audit";

-- Revert: Rename table "auth_passkey" to "kay_passkeys"
ALTER TABLE "kay_passkeys" RENAME TO "auth_passkey";

-- Revert: Rename table "auth_session" to "kay_auth_sessions"
ALTER TABLE "kay_auth_sessions" RENAME TO "auth_session";

-- Revert: Rename table "auth_bearer_token" to "kay_bearer_tokens"
ALTER TABLE "kay_bearer_tokens" RENAME TO "auth_bearer_token";

-- Revert: Rename table "auth_recovery_code" to "kay_recovery_codes"
ALTER TABLE "kay_recovery_codes" RENAME TO "auth_recovery_code";

-- Revert: Rename table "auth_token" to "kay_tokens"
ALTER TABLE "kay_tokens" RENAME TO "auth_token";

-- Revert: Rename table "auth_identity" to "kay_identities"
ALTER TABLE "kay_identities" RENAME TO "auth_identity";

-- Revert: Rename table "auth_user" to "kay_users"
ALTER TABLE "kay_users" RENAME TO "auth_user";