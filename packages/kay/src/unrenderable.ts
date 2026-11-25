// Values whose String() is never what the author meant, shared by the SSR and DOM renderers so both refuse them alike.

// A value with its own toString, such as a server action printing its URL, renders as that string on purpose.
function hasOwnToString(value: object): boolean {
  const { toString } = value
  return typeof toString === 'function' && toString !== Function.prototype.toString && toString !== Object.prototype.toString && toString !== Array.prototype.toString
}

function describe(value: unknown, asClass: boolean): [string, string] | undefined {
  if (typeof value === 'function')
    return hasOwnToString(value) ? undefined : ['a function', 'call it, or pass it to an event prop']
  if (typeof value !== 'object' || value === null)
    return undefined
  if (typeof (value as { then?: unknown }).then === 'function')
    return ['a Promise', 'await it in an async component, or make that component the only child of <Suspense>']
  if ('peek' in value && 'value' in value)
    return ['a signal', 'read its .value']
  if ('__html' in value)
    return ['a { __html } object', 'pass the string to innerHTML, or wrap trusted HTML in raw()']
  if (asClass && Array.isArray(value))
    return ['an array', 'join the names into one string']
  if (hasOwnToString(value))
    return undefined
  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null)
    return ['a plain object', 'render one of its fields']
  return undefined
}

/** Throws when `value` would print as `[object Object]`, `[object Promise]` or a function's source; `place` is `text` or an attribute name. */
export function assertRenderable(value: unknown, place: string): void {
  const found = describe(value, place === 'class')
  if (found !== undefined)
    throw new TypeError(`kay: cannot render ${found[0]} as ${place === 'text' ? 'text' : `the ${place} attribute`}; ${found[1]}.`)
}
