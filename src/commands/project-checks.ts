import type { CheckDiagnostic } from '../check'
import type { KayConfig, ProjectCheck, ProjectCheckContext } from '../config'
import { join, resolve } from 'node:path'
import { CONFIG_FILE } from '../config'
import { listRoutes } from './routes'

// A check that has not finished by then is reported, so one that waits on nothing cannot hold `kay check` for good.
const CHECK_TIMEOUT_MS = 30_000

// Runs each check the app lists in `checks`, all at once, and gives their findings as problems in the checks' order. A check that throws or runs out of time is one problem of its own.
export async function runProjectChecks(root: string, config: KayConfig, timeout = CHECK_TIMEOUT_MS): Promise<CheckDiagnostic[]> {
  const checks = config.checks ?? []
  let listing: ReturnType<typeof listRoutes> | undefined
  const routes: ProjectCheckContext['routes'] = async () => (await (listing ??= listRoutes(root))).routes.map(({ copy: _copy, ...route }) => route)
  const results = await Promise.all(checks.map(async (check, index) => runCheck(root, check, `checks[${index}]${typeof check === 'function' && check.name !== '' ? ` (${check.name})` : ''}`, timeout, routes)))

  return results.flat()
}

async function runCheck(root: string, check: ProjectCheck, name: string, timeout: number, routes: ProjectCheckContext['routes']): Promise<CheckDiagnostic[]> {
  const found: CheckDiagnostic[] = []
  let closed = false
  const problem = (message: string, severity: 'error' | 'warning' = 'error', file = join(root, CONFIG_FILE), line = 1, column = 1, code?: string): CheckDiagnostic => ({ file, line, column, severity, message, code })
  let timer: Timer | undefined

  try {
    if (typeof check !== 'function')
      throw new TypeError('it is not a function')

    const finished = (async () => check({
      root,
      routes,
      report: (finding) => {
        if (closed)
          return

        found.push(problem(finding.message, finding.level === 'warning' ? 'warning' : 'error', finding.file === undefined ? undefined : resolve(root, finding.file), finding.line, finding.column, finding.code))
      },
    }))()
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, timeout, 'timeout')
    })

    if (await Promise.race([finished, timedOut]) === 'timeout')
      found.push(problem(`the check ${name} of ${CONFIG_FILE} did not finish within ${timeout / 1000} seconds`))
  }
  catch (error) {
    found.push(problem(`the check ${name} of ${CONFIG_FILE} threw: ${error instanceof Error ? error.message : String(error)}`))
  }
  finally {
    clearTimeout(timer)
    closed = true
  }

  return found
}
