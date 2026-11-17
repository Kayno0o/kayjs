import type { CheckDiagnostic } from '../src/check'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { authMethods } from '../src/check/auth-methods'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ found: CheckDiagnostic[], text: Record<string, string> }> {
  const root = await scratchDir('auth-methods-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await authMethods(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-auth-methods', () => {
  it('writes the verbs of a group and moves the methods of auth into theirs', async () => {
    const { found, text } = await fixed({
      'src/a.ts': [
        'export async function run(auth: Auth, locals: Locals) {',
        '  await auth.requireAdmin()',
        '  await locals.auth.organizations.members(org)',
        '  await locals.auth.organizations.removeMember(org, id)',
        '  await locals.auth.account.saveProfile(values)',
        '  await locals.auth.magicLink.signInWithCode(code)',
        '  await auth.captchaChallenge(\'reset\')',
        '  return [await auth.provedLately(\'5m\'), await auth.reprove(proof), await auth.hasScope(\'a\'), await auth.oauthOrigin()]',
        '}',
        '',
      ].join('\n'),
    })

    expect(found).toHaveLength(10)

    expect(text['src/a.ts']).toBe([
      'export async function run(auth: Auth, locals: Locals) {',
      '  await auth.admin.require()',
      '  await locals.auth.organizations.listMembers(org)',
      '  await locals.auth.organizations.deleteMember(org, id)',
      '  await locals.auth.account.updateProfile(values)',
      '  await locals.auth.email.signInWithCode(code)',
      '  await auth.captcha.challenge(\'reset\')',
      '  return [await auth.proof.recent(\'5m\'), await auth.proof.renew(proof), await auth.tokens.hasScope(\'a\'), await auth.oauthServer.origin()]',
      '}',
      '',
    ].join('\n'))
  })

  it('reads a server fence of a .kay file and leaves the new names and other receivers alone', async () => {
    const { found, text } = await fixed({
      'src/page.kay': '--- server\nconst auth = ctx.locals.auth\nawait auth.requireAdmin()\nawait auth.admin.require()\nawait team.members(org)\nawait mailer.reprove()\nawait auth.organizations.listMembers(org)\n---\np x\n',
    })

    expect(found).toHaveLength(1)
    expect(text['src/page.kay']).toBe('--- server\nconst auth = ctx.locals.auth\nawait auth.admin.require()\nawait auth.admin.require()\nawait team.members(org)\nawait mailer.reprove()\nawait auth.organizations.listMembers(org)\n---\np x\n')
  })

  it('keeps `members` of a receiver that is not an auth', async () => {
    const { found } = await fixed({ 'src/b.ts': 'export const x = (auth: Auth, org: Org) => org.organizations.members(1) && auth.members(2)\n' })

    expect(found).toHaveLength(0)
  })
})
