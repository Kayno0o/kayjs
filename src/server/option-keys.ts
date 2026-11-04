import { KayError } from '../compiler/errors'
import { nearest } from '../nearest'

// Refuses an option a library's factory does not take, with the nearest key it does, as `auth({ prefx })` would otherwise leave `prefix` at its default with nothing said.
// `known` is written as `Record<keyof ItsOptions, true>`, so the compiler holds it to the interface: a key added there and missing here, or listed here and gone from the interface, does not build.
export function checkOptionKeys(what: string, options: object | undefined, known: Record<string, true>): void {
  const found = Object.keys(options ?? {}).filter(key => !Object.hasOwn(known, key)).map((key) => {
    const near = nearest(key, Object.keys(known))

    return `\`${key}\`${near === undefined ? '' : `, did you mean \`${near}\`?`}`
  })

  if (found.length > 0)
    throw new KayError('config-invalid', `kay: ${what} has ${found.length === 1 ? 'an option' : 'options'} it does not know: ${found.join('; ')}`)
}
