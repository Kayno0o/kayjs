// A rendered value is `{ t: markup }` carrying a mark that data cannot hold, so a JSON value with a `t` string renders as text.
// A global symbol, so a second copy of the runtime recognises the renders of the first.
const RENDERED = Symbol.for('kay.rendered')

export interface Html {
  t: string
  readonly [RENDERED]: true
}

// Markup the server vouches for: what a component, an element or an island rendered.
export function html(markup: string): Html {
  return { t: markup, [RENDERED]: true }
}

export function isRendered(value: object): value is Html {
  return (value as Partial<Html>)[RENDERED] === true && typeof (value as Partial<Html>).t === 'string'
}
