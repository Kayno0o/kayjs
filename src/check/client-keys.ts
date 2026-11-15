import type { CheckDiagnostic, CheckOptions } from '.'
import { movedKeys } from './moved-keys'

const MOVED = new Set(['links', 'offline', 'search'])
const NEEDLE = /\b(?:links|offline|search)\b/

// The keys `links`, `offline` and `search` of the config, which belong to `client` since 1.105, with the rest of what the browser is given.
export async function clientKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return movedKeys(root, options, { lint: 'deprecated-client-keys', needle: NEEDLE, group: name => MOVED.has(name) ? 'client' : undefined, help: 'write the key in `client`, `client: { links, offline, search }`' })
}
