import { expect, test } from 'bun:test'
import { testApp } from './helpers/app'

// The flat methods of before 1.87 are gone: a call is a type error under `kay check` (the expected errors below), and a call that slips past it has no method to reach.
test('the flat account, provider and audit methods are gone, and createUser is auth.admin.createUser', () => {
  const { auth } = testApp()

  // @ts-expect-error moved to auth.account.delete in 1.87
  expect(auth.deleteAccount).toBeUndefined()
  // @ts-expect-error moved to auth.account.changeUsername in 1.87
  expect(auth.changeUsername).toBeUndefined()
  // @ts-expect-error moved to auth.oauth.identities in 1.87
  expect(auth.listIdentities).toBeUndefined()
  // @ts-expect-error moved to auth.audit.list in 1.87
  expect(auth.listAuditLog).toBeUndefined()
  // @ts-expect-error moved to auth.admin.createUser in 1.87
  expect(auth.createUser).toBeUndefined()
})
