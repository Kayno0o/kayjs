import type { CheckDiagnostic, CheckOptions } from '.'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { lintLevel } from '../compiler/lints'
import { pluginFiles, PLUGINS_DIR } from '../config-extensions'

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g
const SOURCE_EXTENSION = /\.[cm]?[jt]s$/

// The `paths` of the root tsconfig.json written as `"~/*": ["./src/*"]`, as a prefix and the directory it stands for; an `extends` is not followed.
function aliases(root: string): { prefix: string, dir: string }[] {
  const file = join(root, 'tsconfig.json')

  if (!existsSync(file))
    return []

  try {
    const { compilerOptions } = Bun.JSONC.parse(readFileSync(file, 'utf8')) as { compilerOptions?: { baseUrl?: string, paths?: Record<string, string[]> } }
    const base = resolve(root, compilerOptions?.baseUrl ?? '.')

    return Object.entries(compilerOptions?.paths ?? {}).flatMap(([key, targets]) => key.endsWith('/*') && targets[0]?.endsWith('/*') ? [{ prefix: key.slice(0, -1), dir: resolve(base, targets[0].slice(0, -1)) }] : [])
  }
  catch {
    return []
  }
}

// A `src/jobs.ts` that no server plugin and no `src/server.ts` imports directly: the queues in it are mounted by nothing, so none runs. An import through a third module is not followed. The one home of jobs is `src/plugins/jobs.ts`, where a queue is defined and mounted at once.
export function unmountedJobs(root: string, options: CheckOptions): CheckDiagnostic[] {
  const level = lintLevel('unmounted-jobs', options.lints)
  const file = join(root, 'src/jobs.ts')

  if (level === 'allow' || !existsSync(file))
    return []

  const paths = aliases(root)
  const target = resolve(file).replace(SOURCE_EXTENSION, '')
  const mounters = [join(root, 'src/server.ts'), ...pluginFiles(root).map(name => join(root, PLUGINS_DIR, name))]
  const imports = (path: string) => {
    for (const [, specifier] of readFileSync(path, 'utf8').matchAll(SPECIFIER)) {
      const alias = paths.find(({ prefix }) => specifier!.startsWith(prefix))
      const absolute = specifier!.startsWith('.') ? resolve(dirname(path), specifier!) : alias && join(alias.dir, specifier!.slice(alias.prefix.length))

      if (absolute !== undefined && absolute.replace(SOURCE_EXTENSION, '') === target)
        return true
    }

    return false
  }

  if (mounters.some(path => existsSync(path) && imports(path)))
    return []

  return [{
    file,
    line: 1,
    column: 1,
    message: 'No server plugin imports this file, so the queues in it are mounted by nothing and none runs',
    help: 'define and mount the queues in `src/plugins/jobs.ts`, the one home of jobs: `export default` the queue, and an action imports it from there to `enqueue`; or `export { queue as default } from \'../jobs\'` in a plugin',
    code: 'unmounted-jobs',
    severity: level === 'warn' ? 'warning' : 'error',
  }]
}
