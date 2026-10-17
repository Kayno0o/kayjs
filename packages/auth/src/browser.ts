import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON as CreationOptions, RegistrationResponseJSON, PublicKeyCredentialRequestOptionsJSON as RequestOptions } from '@simplewebauthn/server'
import { ActionError } from 'kay'

// The browser half of a passkey, for the islands asking one: the WebAuthn JSON methods are the browser's own, so no library ships to the page, and the options and answers are typed as the server's actions give and take them.
// What `toJSON()` gives is the DOM's JSON type, which @simplewebauthn's differs from for the prf extension's values, so each answer is told by the part only it has and read as the server's type.
function answerHas(answer: unknown, part: string): boolean {
  return typeof answer === 'object' && answer !== null && 'response' in answer && typeof answer.response === 'object' && answer.response !== null && part in answer.response
}

function isAssertion(answer: unknown): answer is AuthenticationResponseJSON {
  return answerHas(answer, 'signature')
}

function isAttestation(answer: unknown): answer is RegistrationResponseJSON {
  return answerHas(answer, 'attestationObject')
}

// Whether the page's first "keep me signed in" box is checked, undefined when it shows none: read by the sign-in ways that are no form of their own, the passkey and the provider buttons.
export function rememberChoice(): boolean | undefined {
  return document.querySelector<HTMLInputElement>('input[name="remember"]')?.checked
}

// Whether this browser can answer a passkey request.
export function canAskPasskey(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && 'parseRequestOptionsFromJSON' in PublicKeyCredential
}

// Whether this browser can make a passkey.
export function canMakePasskey(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && 'parseCreationOptionsFromJSON' in PublicKeyCredential
}

// The answer to what `passkeySignInOptions()`, `twoFactorPasskeyOptions()` or `passkeyProofOptions()` gave, for the action calling `signInWithPasskey`, `verifyTwoFactorPasskey` or a proof; null when the person picked none.
// With `autofill`, the passkeys are offered in the autofill of a field with `autocomplete="username webauthn"` and the call waits until one is picked, or `signal` aborts it.
export async function askPasskey(options: RequestOptions, { autofill = false, signal }: { autofill?: boolean, signal?: AbortSignal } = {}): Promise<AuthenticationResponseJSON | null> {
  // @simplewebauthn types the prf extension's values as BufferSource where the DOM's JSON type has strings, for the same JSON.
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options as unknown as Parameters<typeof PublicKeyCredential.parseRequestOptionsFromJSON>[0]), ...autofill && { mediation: 'conditional' }, ...signal && { signal } })
  const answer = credential instanceof PublicKeyCredential ? credential.toJSON() : undefined

  return answer !== undefined && isAssertion(answer) ? answer : null
}

// The answer to what `passkeyRegistrationOptions()` gave, for the action calling `registerPasskey`; null when the person made none.
export async function makePasskey(options: CreationOptions): Promise<RegistrationResponseJSON | null> {
  const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options as unknown as Parameters<typeof PublicKeyCredential.parseCreationOptionsFromJSON>[0]) })
  const answer = credential instanceof PublicKeyCredential ? credential.toJSON() : undefined

  return answer !== undefined && isAttestation(answer) ? answer : null
}

// What to tell the person when a passkey request threw: the message for the code an action refused it with, nothing when they dismissed the browser's prompt, else `failed`.
export function passkeyFailure(caught: unknown, errors: Record<string, string>, failed: string): string {
  if (caught instanceof ActionError) {
    const code = (caught.data as { error?: string } | undefined)?.error

    return code !== undefined && Object.hasOwn(errors, code) ? errors[code] ?? failed : failed
  }

  return caught instanceof DOMException && caught.name === 'NotAllowedError' ? '' : failed
}
