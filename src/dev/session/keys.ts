import type { Readable } from 'node:stream'

const CTRL_C = '\x03'
const ESCAPE = '\x1B'

export interface TerminalKeys {
  // From the first server listening on, every key reaches the handler; before it, q and Ctrl+C alone.
  goLive: () => void
  stopReading: () => void
  // Lines again, once every child is gone.
  restore: () => void
}

// The keys of a person at a terminal, `quit` getting q and Ctrl+C, which raw mode no longer turns into a signal; an escape sequence, as Alt+key or an arrow sends, is no key.
// The terminal turns raw before `kay dev` starts any child and gets its lines back only once every child is gone: a Bun process whose stdout is the terminal puts back, as it exits, the mode the terminal had when it started.
export function readTerminalKeys(keys: Readable, act: (key: string) => void, quit: () => void): TerminalKeys {
  const rawMode = (on: boolean) => (keys as Readable & { setRawMode?: (mode: boolean) => void }).setRawMode?.(on)
  const restore = () => rawMode(false)
  let live = false
  const onKey = (chunk: Buffer | string) => {
    const pressed = String(chunk)

    if (pressed.startsWith(ESCAPE))
      return

    for (const key of pressed) {
      if (key === 'q' || key === CTRL_C)
        quit()
      else if (live)
        act(key)
    }
  }

  rawMode(true)
  process.once('exit', restore)
  keys.on('data', onKey)

  return {
    goLive: () => {
      live = true
    },
    stopReading: () => {
      keys.off('data', onKey)
      keys.pause()
    },
    restore: () => {
      restore()
      process.off('exit', restore)
    },
  }
}
