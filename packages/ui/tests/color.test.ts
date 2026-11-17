import { expect, test } from 'bun:test'
import { colorStyle } from '../src/color'

test('a colour becomes one declaration of the private property, the app\'s own style after it', () => {
  expect(colorStyle('--tile-color', '#8fb8f4')).toBe('--tile-color: #8fb8f4')
  expect(colorStyle('--tile-color', ' oklch(0.7 0.1 250) ', 'margin: 1px')).toBe('--tile-color: oklch(0.7 0.1 250); margin: 1px')
  expect(colorStyle('--tile-color', undefined, 'margin: 1px')).toBe('margin: 1px')
  expect(colorStyle('--tile-color', undefined)).toBeUndefined()
})

test('a value that could end the declaration or the attribute is dropped', () => {
  for (const hostile of ['red; background: url(//x)', 'red}', '"><script>', 'red /* x */', 'red !important', 'a\\b', ''])
    expect(colorStyle('--tile-color', hostile)).toBeUndefined()
})
