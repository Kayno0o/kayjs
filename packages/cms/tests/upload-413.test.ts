import { expect, test } from 'bun:test'
import { ActionError, ApiError } from 'kay'
import { uploadFailure } from '../src/editor/upload'
import { tooLarge, tooLargeForServer } from '../src/upload-text'

const rules = { accept: 'image/png', images: 'image/png', maxBytes: 64 * 1024 }
const big = new File([new Uint8Array(32 * 1024)], 'photo.png')

test('a 413 past the editor\'s own size check is kay\'s body limit, whatever the message says', () => {
  for (const message of ['Request Body Too Large', 'photo.png is 1 MB, over the 64 KB an upload may be', 'an upload may be', ''])
    expect(uploadFailure(new ApiError(413, message), big, rules)).toMatchObject({ status: 413, body: tooLargeForServer('photo.png', big.size) })
})

test('with no rules to check against, the route\'s own words are shown', () => {
  const words = tooLarge('photo.png', big.size, 1024)

  expect(uploadFailure(new ApiError(413, words), big, undefined)).toMatchObject({ status: 413, body: words })
})

test('a 415 or a 400 shows the route\'s words, any other failure is rethrown as it was', () => {
  expect(uploadFailure(new ApiError(415, 'no'), big, rules)).toBeInstanceOf(ActionError)
  expect(uploadFailure(new ApiError(400, 'empty'), big, rules)).toMatchObject({ status: 400, body: 'empty' })

  const offline = new ApiError(0, 'offline')

  expect(uploadFailure(offline, big, rules)).toBe(offline)
})
