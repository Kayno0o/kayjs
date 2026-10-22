const CONTEXT = Symbol.for('kay.context')

// What an extension's `context` module default-exports: how its request values are loaded, once per request.
export interface ContextDefinition<Values extends object = object> {
  readonly [CONTEXT]: true
  readonly load: (request: Request) => Values | Promise<Values>
}

// Declares the request values an extension's `context` module gives templates as `ctx.<key>`: `load` runs at most once per request, ahead of the render of each page reaching a template that reads `ctx`, and the keys of what it returns are typed from it in `kay check` and the editor.
export function defineContext<Values extends object>(load: (request: Request) => Values | Promise<Values>): ContextDefinition<Values> {
  return { [CONTEXT]: true, load }
}

export function isContextDefinition(value: unknown): value is ContextDefinition {
  return typeof value === 'object' && value !== null && CONTEXT in value
}

// The values a `context` module's definition loads, which `kay check` reads off the module itself.
export type ContextOfModule<Module> = Module extends { default: ContextDefinition<infer Values> } ? Values : object

// What a template reads off `ctx`: the values of every extension giving a context, none until one does.
export type TemplateContext = TemplateValues extends { values: infer Values extends object } ? Values : object

// Augmented by the `.kay/types/kay-env.d.ts` that `kay check` writes, with the values the extensions' `context` modules load.
export interface TemplateValues {}

let current: (() => Record<string, unknown> | undefined) | undefined

// Given by the server, which knows the request being rendered.
export function setTemplateContext(read: () => Record<string, unknown> | undefined): void {
  current = read
}

function valuesNow(key: string | symbol): Record<string, unknown> {
  if (current === undefined)
    throw new Error(`kay: \`ctx\` is read on the server, so a component rendered in the browser, such as an island, cannot read ctx.${String(key)}; pass the value in as a prop`)

  const values = current()

  if (values === undefined)
    throw new Error(`kay: ctx.${String(key)} is read in a render that loaded no request values, which only a page rendered per request does; a page reads \`ctx\` in its template or in a component it imports, never in a module`)

  return values
}

// The request values templates read, as `ctx.user` or `ctx.can('admin')`: kay imports it where a template reads `ctx` and the file declares none of its own.
// eslint-disable-next-line ts/no-unnecessary-type-assertion -- an app's extensions augment TemplateContext, which an empty target then lacks the keys of
export const ctx = new Proxy({} as TemplateContext, {
  get: (_, key) => valuesNow(key)[key as string],
  has: (_, key) => key in valuesNow(key),
  ownKeys: () => Reflect.ownKeys(valuesNow('keys')),
  getOwnPropertyDescriptor: (_, key) => {
    const values = valuesNow(key)

    return key in values ? { value: values[key as string], enumerable: true, configurable: true } : undefined
  },
})

let loader: ((request: Request) => Promise<void>) | undefined

// Given by the server, which loads the values of the extensions' contexts.
export function setContextLoader(load: (request: Request) => Promise<void>): void {
  loader = load
}

// What the layout kay mounts around the pages reading `ctx` calls ahead of their render, from `kay/internal` so the type check of that layout pulls none of the server in.
export async function loadTemplateContext({ request }: { request: Request }): Promise<void> {
  await loader?.(request)
}
