import type { KayConfig } from '../config'
import type { ApiModule } from './api'
import type { Endpoint, Route, SpecialPages } from './routes'

// What `kay build --compile` bakes into an executable: the routes as the build scanned them, every module they name, and where the embedded client build and public files sit.
export interface Bundle {
  // The project root at build time; the routes and modules are named by paths under it.
  root: string
  routes: Route[]
  // The routes directory's own special pages, answering URLs no page serves.
  fallback: SpecialPages
  // The modules under the API directory, mounted under `/api`.
  api?: ApiModule[]
  // The endpoint files under the routes directory, `llms.txt.ts` and the like.
  endpoints?: Endpoint[]
  modules: Record<string, unknown>
  // The message catalogs the extensions gave each locale, found where the build ran: an extension names its own under the executable's.
  extensionMessages?: Record<string, string[]>
  config: KayConfig
  clientDir: string
  publicDir: string
}

let bundle: Bundle | undefined

// Called by the entry `kay build --compile` generates, before the server entry runs.
export function registerBundle(value: Bundle): void {
  bundle = value
}

export function bundled(): Bundle | undefined {
  return bundle
}

// Bun already imports a file once per process; keeping what it gave spares every request the cost of asking it again.
const imported = new Map<string, unknown>()

// A page, layout, special page, guard or API module: the executable's own copy, or the file imported through the `.kay` loader.
export async function importModule<Module>(file: string): Promise<Module> {
  if (bundle) {
    if (!(file in bundle.modules))
      throw new Error(`kay: this executable holds no ${file}; run \`kay build --compile\` again`)

    return bundle.modules[file] as Module
  }

  let module = imported.get(file)

  if (module === undefined) {
    module = await import(file)
    imported.set(file, module)
  }

  return module as Module
}
