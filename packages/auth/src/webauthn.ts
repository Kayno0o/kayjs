// simplewebauthn, loaded with the first passkey ceremony so an app with no passkeys never reads it; the reflect polyfill goes first.
type Webauthn = typeof import('@simplewebauthn/server')

let loaded: Promise<Webauthn> | undefined

async function load(): Promise<Webauthn> {
  await import('./reflect')

  return import('@simplewebauthn/server')
}

function webauthn(): Promise<Webauthn> {
  loaded ??= load()

  return loaded
}

export async function generateAuthenticationOptions(...args: Parameters<Webauthn['generateAuthenticationOptions']>) {
  return (await webauthn()).generateAuthenticationOptions(...args)
}

export async function generateRegistrationOptions(...args: Parameters<Webauthn['generateRegistrationOptions']>) {
  return (await webauthn()).generateRegistrationOptions(...args)
}

export async function verifyAuthenticationResponse(...args: Parameters<Webauthn['verifyAuthenticationResponse']>) {
  return (await webauthn()).verifyAuthenticationResponse(...args)
}

export async function verifyRegistrationResponse(...args: Parameters<Webauthn['verifyRegistrationResponse']>) {
  return (await webauthn()).verifyRegistrationResponse(...args)
}
