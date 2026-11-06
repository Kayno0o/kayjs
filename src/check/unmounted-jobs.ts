import type { CheckDiagnostic, CheckOptions } from '.'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintLevel } from '../compiler/lints'
import { PLUGINS_DIR } from '../config-extensions'

const JOBS_IMPORT = /['"](?:\.{1,2}\/)+(?:[\w-]+\/)*jobs(?:\.ts)?['"]/

// A `src/jobs.ts` that no server plugin and no `src/server.ts` imports: the queues in it are mounted by nothing, so none runs. The one home of jobs is `src/plugins/jobs.ts`, where a queue is defined and mounted at once.
export function unmountedJobs(root: string, options: CheckOptions): CheckDiagnostic[] {
  const level = lintLevel('unmounted-jobs', options.lints)
  const file = join(root, 'src/jobs.ts')

  if (level === 'allow' || !existsSync(file))
    return []

  const dir = join(root, PLUGINS_DIR)
  const mounters = [join(root, 'src/server.ts'), ...existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : []]

  if (mounters.some(path => existsSync(path) && JOBS_IMPORT.test(readFileSync(path, 'utf8'))))
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
