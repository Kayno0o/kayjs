import { expect, test } from 'bun:test'

// Heavy dependencies an app reads only for a feature it uses.
test('an app with no passkey and no OAuth loads neither simplewebauthn nor jose', async () => {
  const run = Bun.spawn([process.execPath, `${import.meta.dir}/probes/loaded.ts`], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  const packages = JSON.parse(out.trim().split('\n').pop()!) as string[]

  expect(err).toBe('')
  expect(packages).toContain('elysia')
  expect(packages).not.toContain('@simplewebauthn/server')
  expect(packages).not.toContain('jose')
})
