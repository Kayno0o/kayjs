import { expect, test } from 'bun:test'
import { safeCode } from 'kay/library'

test('keeps a highlighter\'s colours and drops every other style, tag and button', () => {
  expect(safeCode('<span style="color:#D73A49;--shiki-dark:#F97583;position:fixed">x</span>')).toBe('<span style="color:#D73A49;--shiki-dark:#F97583">x</span>')
  expect(safeCode('<span style="background:url(x)">x</span>')).toBe('<span>x</span>')
  expect(safeCode('<div class="frame"><button>Copy</button><script>alert(1)</script><span>x</span></div>')).not.toMatch(/button|script/)
})
