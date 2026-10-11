import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Build output, dependencies and generated types never make a build stale.
const GENERATED = new Set(['node_modules', 'dist', '.next', '.nuxt', '.output', '.astro'])

function newestSource(dir: string): number {
  let newest = 0

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (GENERATED.has(entry.name))
      continue

    const path = join(dir, entry.name)

    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs)
  }

  return newest
}

// Runs a framework's build CLI under Bun when the app or the shared data changed since the build that wrote `marker`.
// Its output goes to stderr: the bench scripts print their results on stdout.
export async function ensureBuilt(dir: string, marker: string, cli: string[]): Promise<void> {
  const built = statSync(join(dir, marker), { throwIfNoEntry: false })?.mtimeMs ?? 0

  if (Math.max(newestSource(dir), newestSource(import.meta.dir)) < built)
    return

  const child = Bun.spawn([process.execPath, ...cli], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`building ${dir} failed:\n${stdout}${stderr}`)
}
