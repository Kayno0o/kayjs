import { WORK_SCRIPT } from './swap'
import { solveWork } from './work'

// Each challenge's solution once asked for, so focusing a form and posting it solve it once.
const solutions = new Map<string, Promise<string | undefined>>()
// The challenges a post went with: a solution goes through once, so the next post waits for a fresh one.
const spent = new Set<string>()

// The challenge the page holds for the action at `url`, unless a post spent it.
function challengeOf(url: string): string | undefined {
  const script = document.querySelector(`script[${WORK_SCRIPT}]`)

  try {
    const challenge = script ? (JSON.parse(script.textContent ?? '') as Record<string, string | undefined>)[url] : undefined

    return challenge === undefined || spent.has(challenge) ? undefined : challenge
  }
  catch {
    return undefined
  }
}

async function solving(challenge: string): Promise<string | undefined> {
  let solution = solutions.get(challenge)

  if (!solution)
    solutions.set(challenge, solution = inWorker(challenge))

  return solution
}

// Starts on the challenge of the action at `url` while the visitor fills its form in.
export function startWork(url: string): void {
  const challenge = challengeOf(url)

  if (challenge !== undefined)
    void solving(challenge)
}

// The solution to post to the action at `url` with: to the page's challenge for it, or to `challenge`, which a refusal sent.
export async function spendWork(url: string, challenge = challengeOf(url)): Promise<string | undefined> {
  if (challenge === undefined)
    return undefined

  spent.add(challenge)

  const solution = await solving(challenge)

  solutions.delete(challenge)

  return solution
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
