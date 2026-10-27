import type { Subprocess } from 'bun'
import type { ClientBuilder } from '../client'
import type { TypesProcess } from '../types-process'

// Where the session is: `starting` until the first types settled, which say a config that does not load, then `running`, then `stopping` for good.
export type Phase = 'starting' | 'running' | 'stopping'

// What the process writing or checking the types answers the session with.
export type TypesWorker = Pick<TypesProcess, 'configuredEntry' | 'problems' | 'loadedModules' | 'loaded' | 'write' | 'close'>

// The processes and the watcher the session drives, which a test replaces to drive its races without spawning any.
export interface DevPorts {
  spawnServer: (root: string, entry: string, env: Record<string, string | undefined>, stdout: 'inherit' | number, ipc: (message: unknown, server: Subprocess) => void) => Subprocess<'pipe'>
  typesProcess: (root: string, entry: string | undefined, env: Record<string, string | undefined>, idleMs?: number) => TypesWorker
  startClientBuilder: (root: string, env: Record<string, string | undefined>, stdout: 'inherit' | number, quiet: boolean) => ClientBuilder
  watchProject: (root: string, onChange: (file: string) => void, options: { rootNaming: boolean, onScratch: () => void }) => () => void
}
