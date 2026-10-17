import { WORK_SCRIPT } from './swap'
import { solveWork } from './work'

// A form field carrying a `workChallenge` in the same attribute, which posts the solution in place of its value.
export const WORK_FIELD = `input[${WORK_SCRIPT}]`

// Each challenge's solution once asked for, so focusing a form and posting it solve it once.
const solutions = new Map<string, Promise<string | undefined>>()
// The challenges a post went with: a solution goes through once, so the next post waits for a fresh one.
const spent = new Set<string>()

// The challenge the page holds for the action at `url`, unless a post spent it: in the script of its head, or one a streamed block brought.
function challengeOf(url: string): string | undefined {
  for (const script of document.querySelectorAll(`script[${WORK_SCRIPT}]`)) {
    try {
      const challenge = (JSON.parse(script.textContent ?? '') as Record<string, string | undefined>)[url]

      if (challenge !== undefined && !spent.has(challenge))
        return challenge
    }
    catch {
      // A script still streaming does not parse yet: the next post reads it whole.
    }
  }

  return undefined
}

async function solving(challenge: string): Promise<string | undefined> {
  let solution = solutions.get(challenge)

  if (!solution)
    solutions.set(challenge, solution = inWorker(challenge))

  return solution
}

// Starts on the challenge of the action at `url`, and on those of `form`'s `workChallenge` fields, while the visitor fills it in.
export function startWork(url: string | undefined, form?: HTMLFormElement): void {
  const challenge = url === undefined ? undefined : challengeOf(url)

  if (challenge !== undefined)
    void solving(challenge)

  for (const field of form?.querySelectorAll<HTMLInputElement>(WORK_FIELD) ?? [])
    void solving(field.getAttribute(WORK_SCRIPT)!)
}

// The solution to post to the action at `url` with: to the page's challenge for it, or to `challenge`, which a refusal sent; `form`'s `workChallenge` fields have theirs put in `data` first.
export async function spendWork(url: string, challenge = challengeOf(url), form?: HTMLFormElement, data?: FormData): Promise<string | undefined> {
  if (form && data)
    await solveFields(form, data)

  if (challenge === undefined)
    return undefined

  spent.add(challenge)

  const solution = await solving(challenge)

  solutions.delete(challenge)

  return solution
}

// Puts the solution of each `workChallenge` field of `form` in `data`, in place of the field's value.
async function solveFields(form: HTMLFormElement, data: FormData): Promise<void> {
  for (const field of form.querySelectorAll<HTMLInputElement>(WORK_FIELD)) {
    const challenge = field.getAttribute(WORK_SCRIPT)!
    const solution = await solving(challenge)

    solutions.delete(challenge)

    if (solution !== undefined && field.name !== '')
      data.set(field.name, solution)
  }
}

async function inWorker(challenge: string): Promise<string | undefined> {
  let worker: Worker

  try {
    worker = new Worker(new URL('./work-worker.ts', import.meta.url), { type: 'module' })
  }
  catch {
    return solveWork(challenge)
  }

  return new Promise((resolve) => {
    worker.addEventListener('message', (event: MessageEvent<string | undefined>) => {
      worker.terminate()
      resolve(event.data)
    })
    // A policy refusing the worker leaves the work to the page's thread.
    worker.addEventListener('error', () => {
      worker.terminate()
      resolve(solveWork(challenge))
    })
    worker.postMessage(challenge)
  })
}
