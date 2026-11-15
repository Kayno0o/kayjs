import type { CheckDiagnostic, CheckOptions } from '.'
import { movedKeys } from './moved-keys'

// Each key of the config that lives in a group since 1.105: the files a site serves in `assets`, what runs the server in `ops`.
const GROUPS: Record<string, string> = {
  images: 'assets',
  fonts: 'assets',
  favicon: 'assets',
  manifest: 'assets',
  publicCache: 'assets',
  observe: 'ops',
  health: 'ops',
  metrics: 'ops',
  jobs: 'ops',
}

// The keys `images`, `fonts`, `favicon`, `manifest` and `publicCache` of the config, which belong to `assets` since 1.105, and `observe`, `health`, `metrics` and `jobs`, which belong to `ops`.
export async function configGroups(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return movedKeys(root, options, { lint: 'deprecated-config-groups', needle: /\b(?:images|fonts|favicon|manifest|publicCache|observe|health|metrics|jobs)\b/, group: name => Object.hasOwn(GROUPS, name) ? GROUPS[name] : undefined, help: 'write the key in its group, `assets: { images, fonts, favicon, manifest, publicCache }` or `ops: { observe, health, metrics, jobs }`' })
}
