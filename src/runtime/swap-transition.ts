import { followable, followAsked, linkIn, plainClick } from './navigate'
import { bounded, inFlight, LATE } from './swap-flight'

// A view transition not finished after this long is skipped.
export const TRANSITION_TIMEOUT_MS = 3000

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

const transitionSheets = new WeakMap<CSSStyleSheet, { length: number, names: boolean }>()

// Runs the commit through a view transition, ending once the transition did or was skipped.
export async function transitioned(commit: () => void): Promise<void> {
  const transition = (document as Document & { startViewTransition: (update: () => void) => ViewTransition }).startViewTransition(commit)

  const skip = () => transition.skipTransition()

  // A transition skipped before its animations start rejects `ready` with an AbortError, which is expected and no error of the page.
  void settled(transition.ready)
  const onRoot = (event: MouseEvent) => linkUnderTransition(event, skip)

  // A newer transition skips the older one, so the older listener goes now rather than when its swap settles.
  if (inFlight.transition)
    document.removeEventListener('click', inFlight.transition)

  document.addEventListener('click', inFlight.transition = onRoot)

  try {
    // A transition stuck, as in a tab the browser keeps from painting, is skipped, which still runs the commit.
    if (await bounded(transition.finished, TRANSITION_TIMEOUT_MS) === LATE) {
      skip()
      // Skipping before the commit ran schedules it: it is awaited so the swap ends after it.
      await transition.updateCallbackDone
    }
  }
  finally {
    document.removeEventListener('click', onRoot)

    if (inFlight.transition === onRoot)
      inFlight.transition = undefined
  }
}

async function settled(work: Promise<unknown>): Promise<void> {
  try {
    await work
  }
  catch {}
}

// A click during a view transition lands on the root, not on the link under the pointer: the transition is skipped, which gives the page its elements back, and the link is looked for where the click was made. Any click on the root cuts the transition short, as the page needs its elements back to answer it.
function linkUnderTransition(event: MouseEvent, skip: () => void): void {
  if (event.target !== document.documentElement || !plainClick(event))
    return

  skip()

  const link = linkIn(document.elementFromPoint(event.clientX, event.clientY))
  const url = link && followable(link)

  if (!url)
    return

  event.preventDefault()
  void followAsked(url, { intent: 'visit', link })
}

// The page's stylesheets opt in with `@view-transition { navigation: auto; }`, as for full loads. A visitor asking for less motion gets none.
export function viewTransitions(): boolean {
  if (!('startViewTransition' in document) || matchMedia(REDUCED_MOTION).matches)
    return false

  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList

    try {
      rules = sheet.cssRules
    }
    catch {
      continue
    }

    let known = transitionSheets.get(sheet)

    // Walked once per sheet, again if rules were added or removed; only a sheet naming the rule has its conditions tested.
    if (known?.length !== rules.length) {
      known = { length: rules.length, names: namesTransition(rules) }
      transitionSheets.set(sheet, known)
    }

    if (known.names && optsIn(rules))
      return true
  }

  return false
}

function namesTransition(rules: CSSRuleList): boolean {
  for (const rule of rules) {
    if (rule.constructor.name === 'CSSViewTransitionRule' || ('cssRules' in rule && namesTransition(rule.cssRules as CSSRuleList)))
      return true
  }

  return false
}

// An `@media` or `@supports` rule counts when it holds.
function optsIn(rules: CSSRuleList): boolean {
  for (const rule of rules) {
    if (rule.constructor.name === 'CSSViewTransitionRule' && (rule as CSSRule & { navigation?: string }).navigation === 'auto')
      return true

    if (((rule instanceof CSSMediaRule && matchMedia(rule.media.mediaText).matches) || (rule instanceof CSSSupportsRule && CSS.supports(rule.conditionText))) && optsIn(rule.cssRules))
      return true
  }

  return false
}
