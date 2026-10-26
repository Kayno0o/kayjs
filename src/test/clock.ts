// The page's clock a test moves: installed before a document's own scripts, it wraps `setTimeout`, `setInterval`, `Date` and `performance.now`, runs as the real ones do until `window.__kayAdvance(ms)` skips ahead, and then runs every timer due in that span in order, with the time the page reads moved to match.
// It is serialised into the page, so it reads nothing from this module.
export function installClock(): void {
  const w = window as unknown as Record<string, unknown>

  if (w.__kayAdvance !== undefined)
    return

  const realSetTimeout = window.setTimeout.bind(window)
  const realClearTimeout = window.clearTimeout.bind(window)
  const RealDate = Date
  const realNow = performance.now.bind(performance)
  const realDateNow = RealDate.now.bind(RealDate)

  interface Timer { due: number, every: number | undefined, run: () => void, handle: number }
  const timers = new Map<number, Timer>()
  let skipped = 0
  // Far above the ids the real timers hand out, which a string handler keeps.
  let next = 1_000_000_000

  const now = () => realNow() + skipped
  const fireRef: { current: (id: number) => void } = { current: () => undefined }
  const arm = (id: number, timer: Timer) => {
    timer.handle = realSetTimeout(() => fireRef.current(id), Math.max(0, timer.due - now()))
  }
  const fire = (id: number) => {
    const timer = timers.get(id)

    if (!timer)
      return

    if (timer.every === undefined) {
      timers.delete(id)
    }
    else {
      timer.due = Math.max(timer.due + timer.every, now())
      arm(id, timer)
    }

    timer.run()
  }

  fireRef.current = fire

  const add = (every: boolean) => (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    // A string handler is the real timer's, unmoved by an advance.
    if (typeof handler !== 'function')
      return realSetTimeout(handler, delay, ...args)

    const id = next++
    const wait = Math.max(Number(delay) || 0, every ? 1 : 0)
    const run = () => void (handler as (...a: unknown[]) => unknown)(...args)
    const timer: Timer = { due: now() + wait, every: every ? wait : undefined, run, handle: 0 }

    timers.set(id, timer)
    arm(id, timer)

    return id
  }
  const clear = (id?: number) => {
    const timer = timers.get(Number(id))

    if (timer) {
      realClearTimeout(timer.handle)
      timers.delete(Number(id))
    }
  }
  const fakeDate = new Proxy(RealDate, {
    construct: (Real, args: unknown[]) => args.length === 0 ? new Real(realDateNow() + skipped) : new (Real as new (...a: unknown[]) => Date)(...args),
    apply: () => new RealDate(realDateNow() + skipped).toString(),
    get: (target, key, receiver) => key === 'now' ? () => realDateNow() + skipped : Reflect.get(target, key, receiver) as unknown,
  })

  window.setTimeout = add(false) as unknown as typeof setTimeout
  window.setInterval = add(true) as unknown as typeof setInterval
  window.clearTimeout = clear as unknown as typeof clearTimeout
  window.clearInterval = clear as unknown as typeof clearInterval
  window.Date = fakeDate
  performance.now = now

  // Runs the timers due within `ms`, earliest first, letting the promises each one starts settle before the next. The real timers still run meanwhile, so a page nobody advances behaves as it always did.
  w.__kayAdvance = async (ms: number) => {
    const target = now() + ms
    const turn = async () => new Promise<void>(resolve => realSetTimeout(resolve, 0))

    for (;;) {
      let first: [number, Timer] | undefined

      for (const entry of timers) {
        if (entry[1].due <= target && (!first || entry[1].due < first[1].due))
          first = entry
      }

      if (!first)
        break

      const [id, timer] = first
      const at = now()

      if (timer.due > at)
        skipped += timer.due - at

      realClearTimeout(timer.handle)
      fire(id)
      await turn()
    }

    const rest = target - now()

    if (rest > 0)
      skipped += rest

    for (const [id, timer] of timers) {
      realClearTimeout(timer.handle)
      arm(id, timer)
    }
  }
}
