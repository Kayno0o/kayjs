import type { AnyElysia, Elysia, SingletonBase } from 'elysia'

const ELYSIA = 'elysia'

type Empty = Record<never, never>

// What kay hands an app to `.use()` or list in `extensions`: the server plugin of a feature, whose `Locals` its handlers read as `ctx.locals`, from the whole app (`global`) or from the plugin's own scope (`scoped`).
// It is an Elysia instance in kay 1.x, so `new Elysia().use(plugin)` types as ever; an app names this type and reaches the instance only through `elysia`, which Elysia 2 may make a wrapper.
export type KayPlugin<Locals extends SingletonBase['resolve'] = Empty, Scope extends 'global' | 'scoped' = 'global'> = Elysia<
  '',
  { decorator: Empty, store: Empty, derive: Empty, resolve: Scope extends 'scoped' ? Empty : Locals },
  { typebox: Empty, error: Empty },
  { schema: Empty, standaloneSchema: Empty, macro: Empty, macroFn: Empty, parser: Empty, response: Empty },
  Empty,
  { derive: Scope extends 'scoped' ? Locals : Empty, resolve: Empty, schema: Empty, standaloneSchema: Empty, response: Empty }
> & {
  // The Elysia instance behind the plugin, for code that must call Elysia itself. Not part of kay's stable API: its type follows the Elysia kay is built on.
  readonly elysia: AnyElysia
}

// What a function taking a plugin accepts: kay's own or a plain Elysia instance, which kay 1.x took before `KayPlugin` and still does for three minors.
export type PluginInput = AnyElysia | KayPlugin

// Gives `instance` its `elysia`, itself: a plain constant, so Elysia's own copying of an instance's properties meets a value and no getter.
export function kayPlugin<Instance extends AnyElysia>(instance: Instance): Instance & { readonly elysia: AnyElysia } {
  if (!Object.hasOwn(instance, ELYSIA))
    Object.defineProperty(instance, ELYSIA, { value: instance, enumerable: false })

  return instance as Instance & { readonly elysia: AnyElysia }
}
