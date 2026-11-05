import { describe, expect, test } from 'bun:test'
import { normalizeAddress } from 'kay/library'
import { emailProblem, normalizeEmail } from '../src/rules'

const CANDIDATES = [
  'ada@example.com',
  'Ada@Example.COM',
  ' ada@example.com ',
  'ada+news@example.com',
  'ada@bücher.example',
  'ada@BÜCHER.example',
  'ａｄａ@example.com',
  'ada@ｅｘａｍｐｌｅ.com',
  'é@example.com',
  'o\'brien@example.com',
  'ada@example.com.',
  '"ada"@example.com',
  '"ada smith"@example.com',
  'ada@example',
  'ada@[192.168.0.1]',
  'ada@192.168.0.1',
  'a@b@example.com',
  'a,b@example.com',
  'Ada <ada@example.com>',
  'ada@example.com\nBcc: x@y.test',
  'ada@example.com\r\nBcc: x@y.test',
  `${'a'.repeat(250)}@example.com`,
  `ada@${'a'.repeat(250)}.com`,
  'аlice@example.com',
  'ada@exa mple.com',
  'ada@-example.com',
]

describe('email rules', () => {
  test('an address accepted at sign-up is never refused as a recipient by mail', () => {
    for (const candidate of CANDIDATES) {
      if (emailProblem(candidate) === undefined)
        expect(normalizeAddress(normalizeEmail(candidate))).toBeDefined()
    }
  })

  test('the strict check keeps the real ones and refuses the rest', () => {
    for (const good of ['ada@example.com', ' Ada@Example.COM ', 'ada+news@example.com', 'ada@bücher.example', 'é@example.com'])
      expect(emailProblem(good)).toBeUndefined()

    for (const bad of ['ada@example.com.', '"ada"@example.com', 'ada@example', 'ada@192.168.0.1', 'a,b@example.com', 'Ada <ada@example.com>', 'ada@example.com\nBcc: x@y.test', `${'a'.repeat(250)}@example.com`])
      expect(emailProblem(bad)).toBe('invalid')
  })

  test('the confusables rule stays on top', () => {
    expect(emailProblem('аlice@example.com')).toBe('invalid')
  })
})
