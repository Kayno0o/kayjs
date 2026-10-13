// What a page a dev server serves runs first, inline in its head: each problem kay logs in the browser, as `[kay] ...`, is kept for the dev tool, which loads later as a module; the console still shows it.
// The page carries this function's own source, so it reads nothing outside itself, and a policy allows it by one hash.

export interface DevProblem {
  level: 'error' | 'warn'
  text: string
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
}
