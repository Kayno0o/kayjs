import type { Subprocess } from 'bun'
import { join } from 'node:path'
import process from 'node:process'
import { scratchDir } from 'kay/test'

const RESTARTED = /: restarted in /g
const CLI = join(import.meta.dir, '../../../../src/cli.ts')

const FILES: Record<string, string> = {
  'kay.config.ts': `import { mail } from '@kaynooo/kayjs-mail'\nimport { defineConfig } from 'kay/server'\n\nexport default defineConfig({ extensions: [mail({ module: './src/mail' })] })\n`,
  'src/mail.ts': `import { mailer } from '@kaynooo/kayjs-mail'\n\nexport const mail = mailer({ from: 'Dev <dev@example.com>' })\n`,
  'src/server.ts': `import { Elysia } from 'elysia'\nimport { pages } from 'kay/server'\nimport { mail } from './mail'\n\nexport const app = new Elysia().get('/send/:n', async ({ params }) => {\n  await mail.send({ to: 'ada@example.com', subject: \`Mail \${params.n}\`, text: 'Hello' })\n\n  return 'sent'\n}).use(await pages()).listen(Number(process.env.PORT))\n`,
  'src/routes/index.kay': `---\n---\nh1 Home\na.other(href="/other") Other\n`,
  'src/routes/other.kay': `---\n---\nh1 Other\na.home(href="/") Home\n`,
}

// A free port, so the server's address is known before it starts.
function freePort(): number {
  const probe = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })
  const { port } = probe

  probe.stop(true)

  return port
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  }
  catch {
    return false
  }
}

// `kay dev` running a small app listing the mailer, as its own process the way a developer runs it, in a scratch folder.
export async function devApp(): Promise<{ root: string, url: string, restart: () => Promise<void>, stop: () => Promise<void> }> {
  const root = await scratchDir('mail-dev-')
  const port = freePort()

  await Promise.all(Object.entries(FILES).map(async ([path, content]) => Bun.write(join(root, path), content)))

  const env = { ...process.env }

  delete env.KAY_ROOT
  delete env.KAY_DEV_CODE

  const child: Subprocess<'ignore', 'pipe', 'inherit'> = Bun.spawn([process.execPath, CLI, 'dev', root, '--port', String(port)], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const lines: string[] = []

  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()

      if (done)
        return

      lines.push(decoder.decode(value, { stream: true }))
    }
  })()

  const restarts = () => lines.join('').match(RESTARTED)?.length ?? 0

  for (const start = Date.now(); !lines.join('').includes('ready in'); await Bun.sleep(25)) {
    if (Date.now() - start > 30_000) {
      child.kill('SIGKILL')

      throw new Error(`kay dev did not become ready:\n${lines.join('')}`)
    }
  }

  return {
    root,
    url: `http://localhost:${port}`,
    // A server module saved as an editor saves it, which `kay dev` answers with a new server process, answering once it listens.
    restart: async () => {
      const before = restarts()

      await Bun.write(join(root, 'src/mail.ts'), `${await Bun.file(join(root, 'src/mail.ts')).text()}\n// edit ${before}\n`)

      for (const start = Date.now(); restarts() === before || !await answers(`http://localhost:${port}/_kay/mail.json`); await Bun.sleep(50)) {
        if (Date.now() - start > 30_000) {
          child.kill('SIGKILL')

          throw new Error(`kay dev did not restart:\n${lines.join('')}`)
        }
      }
    },
    stop: async () => {
      child.kill('SIGTERM')
      await child.exited
    },
  }
}
