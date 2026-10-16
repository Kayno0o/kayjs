import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { t } from 'elysia'

// The parts of a browser's answer a ceremony reads, as `credential.toJSON()` writes them: a post that lacks one is refused here, and the signature and challenge are the ceremony's to check.
const PART_MAX = 32_768
const part = t.String({ maxLength: PART_MAX })
const credential = { id: t.String({ maxLength: 1024 }), rawId: t.String({ maxLength: 1024 }), type: t.Literal('public-key') }

// The answer to `passkeySignInOptions()`, `twoFactorPasskeyOptions()` or `passkeyProofOptions()`, for the schema of an action calling `signInWithPasskey`, `verifyTwoFactorPasskey` or a proof.
export const passkeyAssertion = t.Unsafe<AuthenticationResponseJSON>(t.Object({
  ...credential,
  response: t.Object({ clientDataJSON: part, authenticatorData: part, signature: part, userHandle: t.Optional(part) }, { additionalProperties: true }),
}, { additionalProperties: true }))

// The answer to `passkeyRegistrationOptions()`, for the schema of an action calling `registerPasskey`.
export const passkeyAttestation = t.Unsafe<RegistrationResponseJSON>(t.Object({
  ...credential,
  response: t.Object({ clientDataJSON: part, attestationObject: part }, { additionalProperties: true }),
}, { additionalProperties: true }))
