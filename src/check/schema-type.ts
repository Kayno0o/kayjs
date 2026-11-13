import type { CheckDiagnostic, CheckOptions } from '.'
import { renamedTypes } from './renamed-exports'

const OLD_NAME = /\bTSchema\b/

// `TSchema` imported from `kay/library`, which is `Schema` since 1.103: kay's own name for what `s` builds, so a signature of the app does not name TypeBox. The fix renames the import and every use of it.
export async function schemaType(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedTypes(root, options, { lint: 'deprecated-schema-type', modules: { 'kay/library': { TSchema: 'Schema' } }, needle: OLD_NAME, since: '1.103', until: '1.106' })
}
