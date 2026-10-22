import type { BunPlugin, OnLoadArgs, OnLoadResult, PluginBuilder } from 'bun'

export interface CapturedLoad {
  filter: RegExp
  callback: (args: OnLoadArgs) => OnLoadResult | Promise<OnLoadResult>
}

export type CapturedModule = () => { contents: string, loader: 'js' }

// What a plugin set up outside a bundle would register for the runtime, kept instead of registered: the loads it answers and the virtual modules it gives, which a caller runs itself.
export async function capturedLoads(plugin: BunPlugin): Promise<{ loads: CapturedLoad[], modules: Map<string, CapturedModule> }> {
  const loads: CapturedLoad[] = []
  const modules = new Map<string, CapturedModule>()
  const view = {
    onStart: () => undefined,
    onEnd: () => undefined,
    onResolve: () => undefined,
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

  return { loads, modules }
}
