import type { KayLibrary } from '../build/libraries'
import type { CheckOptions, ProbeMemory, ShadowTypes } from '../check'
import type { ShadowFile, ShadowSettings } from '../check/shadow'
import type { Diagnostic as KayDiagnostic } from '../compiler'
import type { Route, RouteMount } from '../server/routes'
import type { ComponentInterface } from './component-props'
import type { Diagnostic } from './protocol'
import type { Connection } from './rpc'

// Where a file tsgo names is for the editor: its .kay source for a shadow file, the file itself outside the shadow tree.
export interface Target {
  uri: string
  shadow?: ShadowFile
}

// The settings of a project's shadow tree as its last write left them, which each of its .kay files compiles with.
export function shadowSettingsOf(project: Project): ShadowSettings {
  return { routesDir: project.routesDir, mounts: project.mounts, islandOnly: project.islandOnly, lints: project.options.lints }
}

// A folder holding a tsconfig.json: its .kay files compile against its own routes and config, into its own shadow tree.
export interface Project {
  root: string
  options: CheckOptions
  routesDir: string
  // The routes its extensions mount, and their directories, which every compile reads.
  mounts: RouteMount[]
  // The prefixes its locales serve pages under.
  locales: string[]
  shadowTree: string
  shadowFiles: Set<string>
  // The content hash of each, as the last write left it: a time stamp cannot tell two writes within one millisecond apart.
  shadowStamps: Map<string, bigint>
  // As of the last shadow write: the static components only islands render, the library components the app never imports, whose errors are the library's, and the libraries.
  islandOnly: Set<string>
  unreached: Set<string>
  libraries: KayLibrary[]
  // What the checking scripts found last, run again only for a change in what they read.
  probes: ProbeMemory
  // The last shadow write, which the project-wide checks read.
  types?: ShadowTypes
  configured: boolean
  // What template completion looked up, dropped on a save and when the config is read again: the route table, the message catalog, the interface of each component read from disk and the props TypeScript gives a tag.
  lookups: { paths?: Promise<string[]>, messages?: Promise<string[]>, routes?: Promise<Route[]>, ownMatchers?: Promise<string[]>, interfaces: Map<string, ComponentInterface | undefined>, typedProps: Map<string, Promise<ComponentInterface['props'] | undefined>> }
}

export interface Document extends ShadowFile {
  uri: string
  shadowUri: string
  version: number
  diagnostics: KayDiagnostic[]
  // Compiled as rendered inline with the islands that alone render it.
  insideIsland: boolean
  // The signals of the modules it imports, as compiled with: a module changing them compiles the file again.
  signals: string
  // The `query` types of the layouts above it, as compiled with: a layout gaining or dropping one compiles the file again.
  queries: string
}

// What the modules of the server read of it: the editor's and tsgo's connections, the open documents and the projects.
export interface LspHost {
  readonly root: string
  readonly client: Connection
  readonly server: Connection
  readonly nodeUris: boolean
  readonly projects: Map<string, Project>
  readonly documents: Map<string, Document>
  // The open `src/ui.ts` documents by uri; TypeScript's server types them, kay adds the parts, variants and tokens.
  readonly uiFiles: Map<string, string>
  readonly problems: Map<string, Diagnostic[]>
  projectAt: (root: string) => Project
  shadowProject: (path: string) => Project | undefined
  placed: (project: Project, file: string) => { file: string, shadowOf: (file: string) => string }
  // Numbers the probe documents, so two asked at once never share one.
  nextProbe: () => number
}

// Background work reports its failure instead of ending the process with an unhandled rejection.
export async function guard(task: Promise<void>): Promise<void> {
  try {
    await task
  }
  catch (error) {
    console.error('kay lsp:', error)
  }
}

// A lookup kept until the next save, forgotten when it fails so the next completion asks again; only its own failed promise is dropped, not a newer one a save put there.
export async function remembered<Key extends 'paths' | 'messages' | 'routes' | 'ownMatchers'>(lookups: Project['lookups'], key: Key, ask: () => Promise<Awaited<NonNullable<Project['lookups'][Key]>>>): Promise<Awaited<NonNullable<Project['lookups'][Key]>>> {
  const kept = (lookups[key] ?? ask()) as Promise<Awaited<NonNullable<Project['lookups'][Key]>>>

  lookups[key] = kept as Project['lookups'][Key]

  try {
    return await kept
  }
  catch (error) {
    if (lookups[key] === kept)
      delete lookups[key]

    throw error
  }
}

export const ERROR = 1 as const
export const WARNING = 2 as const
export const QUICK_FIX = 'quickfix'
export const FIX_ALL = 'source.fixAll.kay'
