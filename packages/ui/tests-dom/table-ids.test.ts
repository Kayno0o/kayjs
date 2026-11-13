import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import TableIdsFull from '../tests/fixture/src/components/table-ids-full.kay'
import TableIds from '../tests/fixture/src/components/table-ids.kay'

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  for (const one of mounted.splice(0))
    one.unmount()
})

// How many ids the Table drew between the two the page draws around it.
async function drawn(component: typeof TableIds): Promise<number> {
  const page = await mountComponent(component)

  mounted.push(page)

  const number = (id: string) => Number((/(\d+)$/).exec(page.root.querySelector(id)!.textContent)![1])

  return number('#after') - number('#before')
}

test('a Table without `expandable` draws the ids the full Table draws, so the ones after it match the server markup', async () => {
  const full = await drawn(TableIdsFull)

  // The table's own id and the toggle's popover.
  expect(full).toBeGreaterThan(2)
  expect(await drawn(TableIds)).toBe(full)
})
