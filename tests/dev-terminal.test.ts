import { readlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { freePort } from './free-port'
import { fixtureCopy } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const CLEAR_SCREEN = '\u001B[2J\u001B[3J\u001B[H'
const CONTROLS = 'press o to open it in the browser, r to restart, c to clear the screen, q to quit'

// The terminal's line discipline as `stty` reads it: `-icanon` once raw, `icanon` back to lines.
function lineMode(tty: string): string | undefined {
  return Bun.spawnSync(['stty', '-F', tty, '-a']).stdout.toString().match(/-?icanon/)?.[0]
}

describe('kay dev at a terminal', () => {
  it('keeps taking keys after r, shows the controls again after c and gives the terminal back on q', async () => {
    const root = await fixtureCopy('bare')
    let output = ''
    const child = Bun.spawn([process.execPath, CLI, 'dev', '--port', String(freePort())], { cwd: root, env: { ...process.env, NO_COLOR: '1' }, terminal: { cols: 160, data: (_terminal, data) => {
      output += new TextDecoder().decode(data)
    } } })
    const tty = readlinkSync(`/proc/${child.pid}/fd/0`)
    const printed = async (text: string, after = 0) => {
      while (!output.includes(text, after))
        await Bun.sleep(20)
    }

    try {
      await printed(CONTROLS)
      child.terminal!.write('r')
      await printed('r pressed: restarted')
      // The server stopped by the restart started before the terminal was raw; it must not have put the terminal back to lines as it exited.
      expect(lineMode(tty)).toBe('-icanon')

      const cleared = output.length

      child.terminal!.write('c')
      await printed(CLEAR_SCREEN, cleared)
      await printed(CONTROLS, output.indexOf(CLEAR_SCREEN, cleared))
      child.terminal!.write('q')
      expect(await child.exited).toBe(0)
      expect(lineMode(tty)).toBe('icanon')
    }
    finally {
      child.kill()
      await child.exited
      child.terminal?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
