import type { Refusal, ServedRoute } from './guards'
import type { Rendering, RenderOptions } from './render'
import { projectPath } from './render-document'
import { Denied, NotFound, Redirect } from './signals'

// What each guard did, for the dev tool: a guard's redirect goes out through `renderFailure` with the same spelling, so its outcome names the `Location` sent.
// Those before a refusal passed, the one refusing says how, the rest did not run.
export function guardRuns(guards: ServedRoute['guards'], refusal: Refusal | undefined, spelling?: RenderOptions['redirectSpelling']): NonNullable<Rendering['guards']> {
  const refused = refusal ? guards.indexOf(refusal.guard) : -1

  return guards.map((guard, index) => {
    const file = projectPath(guard.file)

    if (index < refused || refused === -1)
      return { file, outcome: 'passed' }

    return { file, outcome: index > refused ? 'did not run' : refusalOutcome(refusal!.error, spelling) }
  })
}

// The redirect names the `Location` that goes out, spelled as the response spells it.
export function refusalOutcome(error: unknown, spelling?: RenderOptions['redirectSpelling']): string {
  if (error instanceof Redirect)
    return `redirected to ${spelling?.(error.location) ?? error.location} (${error.status})`

  if (error instanceof Denied)
    return `denied with ${error.status}${error.message === '' ? '' : `: ${error.message}`}`

  return error instanceof NotFound ? 'answered not found' : `failed: ${error instanceof Error ? error.message : String(error)}`
}
