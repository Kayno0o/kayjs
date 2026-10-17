import { expect, mock, test } from 'bun:test'
import * as library from 'kay/library'

void mock.module('kay/library', () => ({ ...library, unansweredPaths: () => {
  throw new Error('SQLITE_IOERR: disk I/O error at /srv/app/data/not-found.sqlite')
} }))

const { readMissing } = await import('../src/missing')

test('a store that cannot be read is a worded failure, its path and error kept to the log', () => {
  const screen = readMissing()

  expect(screen).toEqual({ failure: 'The recorded paths cannot be read: see the server\'s log.' })
  expect(JSON.stringify(screen)).not.toContain('/srv/app')
})
