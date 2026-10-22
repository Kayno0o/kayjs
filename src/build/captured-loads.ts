import type { BunPlugin, OnLoadArgs, OnLoadResult, OnResolveArgs, OnResolveResult, PluginBuilder } from 'bun'

export interface CapturedLoad {
  filter: RegExp
  callback: (args: OnLoadArgs) => OnLoadResult | Promise<OnLoadResult>
}

export interface CapturedResolve {
  filter: RegExp
  callback: (args: OnResolveArgs) => OnResolveResult | Promise<OnResolveResult> | undefined | void
}

export type CapturedModule = () => { contents: string, loader: 'js' }

// What a plugin set up outside a bundle would register for the runtime, kept instead of registered: the loads it answers and the virtual modules it gives, which a caller runs itself.
// Its resolvers are registered through `onResolve` when given, and kept otherwise.
export async function capturedLoads(plugin: BunPlugin, onResolve?: PluginBuilder['onResolve']): Promise<{ loads: CapturedLoad[], modules: Map<string, CapturedModule>, resolves: CapturedResolve[] }> {
  const loads: CapturedLoad[] = []
  const resolves: CapturedResolve[] = []
  const modules = new Map<string, CapturedModule>()
  const view = {
    onStart: () => undefined,
    onEnd: () => undefined,
    onResolve: onResolve ?? ((options: { filter: RegExp }, callback: CapturedResolve['callback']) => {
      resolves.push({ filter: options.filter, callback })
    }),
    config: undefined,
    onLoad: (options: { filter: RegExp, namespace?: string }, callback: CapturedLoad['callback']) => {
      if (options.namespace === undefined)
        loads.push({ filter: options.filter, callback })
    },
    module: (name: string, callback: CapturedModule) => {
      modules.set(name, callback)
    },
  } as unknown as PluginBuilder

  await plugin.setup(view)

  return { loads, modules, resolves }
}
