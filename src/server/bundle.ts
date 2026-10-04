import type { KayConfig } from '../config'
import type { Route, SpecialPages } from './routes'

// What `kay build --compile` bakes into an executable: the routes as the build scanned them, every module they name, and where the embedded client build and public files sit.
export interface Bundle {
  // The project root at build time; the routes and modules are named by paths under it.
  root: string
  routes: Route[]
  // The routes directory's own special pages, answering URLs no page serves.
  fallback: SpecialPages
  modules: Record<string, unknown>
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

// A page, layout, special page or guard: the executable's own copy, or the file imported through the `.kay` loader.
export async function importModule<Module>(file: string): Promise<Module> {
  return (bundle?.modules[file] ?? await import(file)) as Module
}
