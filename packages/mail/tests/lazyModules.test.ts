import { describe, expect, test } from 'bun:test'

async function loaded(mode: 'outbox' | 'smtp' | 'dev'): Promise<{ before: string[], after: string[] }> {
  const run = Bun.spawn(['bun', `${import.meta.dir}/probes/loaded.ts`, mode], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_ROOT: `${import.meta.dir}/fixture` } })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

  if (!out.trim())
    throw new Error(err)

  return JSON.parse(out.trim().split('\n').pop()!)
}

// nodemailer's SMTP pool, which the address parser the mailer reads for every mail does not pull in.
const has = (files: string[], file: string) => files.some(path => path.startsWith(file))

describe('nodemailer', () => {
  test('is not loaded by an app sending to the outbox, nor by one that has not sent yet', async () => {
    const { before, after } = await loaded('outbox')

    expect(has(before, 'nodemailer/dist/esm/smtp-pool')).toBe(false)
    expect(has(after, 'nodemailer/dist/esm/smtp-pool')).toBe(false)
  })

  test('is loaded by the first send over SMTP', async () => {
    const { before, after } = await loaded('smtp')

    expect(has(before, 'nodemailer/dist/esm/smtp-pool')).toBe(false)
    expect(has(after, 'nodemailer/dist/esm/smtp-pool')).toBe(true)
  })

  test('is not loaded by the dev preview page, only by an .eml download', async () => {
    const { before, after } = await loaded('dev')

    expect(has(before, 'nodemailer/dist/esm/mail-composer')).toBe(false)
    expect(has(after, 'nodemailer/dist/esm/mail-composer')).toBe(false)
    expect(has(after, 'nodemailer/dist/esm/smtp-pool')).toBe(false)
  })

  test('the dev pages read their module on the first request to one, and not in production', async () => {
    const { before, after } = await loaded('dev')

    expect(has(before, 'src/preview')).toBe(false)
    expect(has(after, 'src/preview')).toBe(true)
  })

  test('a mailer outside kay dev never reads the dev pages', async () => {
    const { after } = await loaded('outbox')

    expect(has(after, 'src/preview')).toBe(false)
  })
})
