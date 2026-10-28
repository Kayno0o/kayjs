export const BEAT_MS = 1000
export const RUN_LIMIT_MS = 3000

// How the playground judges its frame from the page's beat: `tick` pings the frame, or says it is stuck once it has left a ping unanswered past the limit, and `heard` is any reply from it.
export function watchdog(): { tick: (now: number) => 'ping' | 'stuck', heard: () => void } {
  // When the oldest ping the frame has not answered was sent: a page task that ran long sends no pings, so the frame's silence is not counted from before it.
  let asked: number | undefined
  let overdueAt: number | undefined

  return {
    tick(now) {
      if (asked !== undefined && now - asked > RUN_LIMIT_MS) {
        overdueAt ??= now

        // A reply queued behind a long page task is handled before a later tick, but Chromium keeps an interval on its grid, so the tick after a late one can come at once: the frame is judged on the next tick on the beat.
        if (now - overdueAt >= BEAT_MS / 2)
          return 'stuck'
      }

      asked ??= now

      return 'ping'
    },
    heard() {
      asked = undefined
      overdueAt = undefined
    },
  }
}
