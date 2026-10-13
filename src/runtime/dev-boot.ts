// What a page a dev server serves runs first, inline in its head: each problem kay logs in the browser, as `[kay] ...`, each error nothing caught and each source the policy blocked is kept for the dev tool, which loads later as a module; the console still shows them.
// The page carries this function's own source, so it reads nothing outside itself, and a policy allows it by one hash.

export interface DevProblem {
  level: 'error' | 'warn'
  text: string
  // What the dev tool cannot tell from the text: an error nothing caught, or what the policy blocked.
  kind?: 'uncaught' | 'policy'
  // The error thrown, whose stack the dev tool shows in place of the text.
  error?: unknown
  // The island kay caught the error in.
  island?: string | undefined
}

// An array until the dev tool loads and takes what it holds, then the dev tool's own `push`.
export interface DevProblems {
  push: (problem: DevProblem) => unknown
}

export function bootDevTool(win: Window & { $kayProblems?: DevProblems }): void {
  win.$kayProblems ??= [] as DevProblem[]

  for (const level of ['error', 'warn'] as const) {
    const logged = console[level].bind(console)

    console[level] = (...args: unknown[]) => {
      logged(...args)

      const [message] = args

      if (typeof message === 'string' && message.startsWith('[kay] '))
        win.$kayProblems!.push({ level, text: message.slice(6) })
    }
  }

  win.addEventListener('error', (event) => {
    // Chromium's note that a resize observer's callback ran out of frame, which nothing threw.
    if (event.message.startsWith('ResizeObserver loop'))
      return

    win.$kayProblems!.push({ level: 'error', kind: 'uncaught', text: event.message, error: event.error as unknown })
  })
  win.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason

    win.$kayProblems!.push({ level: 'error', kind: 'uncaught', text: `Uncaught (in promise) ${String(reason)}`, error: reason })
  })
  win.addEventListener('securitypolicyviolation', (event) => {
    const where = event.sourceFile === '' ? '' : ` at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`
    const report = event.disposition === 'report'

    win.$kayProblems!.push({ level: report ? 'warn' : 'error', kind: 'policy', text: `${report ? 'would block' : 'blocked'} ${event.blockedURI === '' ? 'inline' : event.blockedURI} by ${event.effectiveDirective}${where}` })
  })
}
