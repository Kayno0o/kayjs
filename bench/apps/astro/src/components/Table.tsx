import { batch, createSelector, createSignal, For } from 'solid-js'
import { rowBuilder } from '../../../../shared/data'

interface RowState {
  id: number
  label: () => string
  setLabel: (update: (label: string) => string) => void
}

// The Solid app's table, the js-framework-benchmark's keyed Solid implementation, here as an Astro island.
export default function Table() {
  const build = rowBuilder()
  const [rows, setRows] = createSignal<RowState[]>([])
  const [selected, setSelected] = createSignal<number>()
  const isSelected = createSelector(selected)
  const create = (count: number) => build(count).map((row) => {
    const [label, setLabel] = createSignal(row.label)

    return { id: row.id, label, setLabel }
  })
  const update = () => batch(() => {
    for (const [index, row] of rows().entries()) {
      if (index % 10 === 0)
        row.setLabel(label => `${label} !!!`)
    }
  })
  const swap = () => {
    const list = rows().slice()

    if (list.length < 999)
      return

    const second = list[1]!

    list[1] = list[998]!
    list[998] = second
    setRows(list)
  }

  return (
    <>
      <div class="jumbotron">
        <button id="run" onClick={() => setRows(create(1000))}>Create 1,000 rows</button>
        <button id="runlots" onClick={() => setRows(create(10000))}>Create 10,000 rows</button>
        <button id="add" onClick={() => setRows([...rows(), ...create(1000)])}>Append 1,000 rows</button>
        <button id="update" onClick={update}>Update every 10th row</button>
        <button id="clear" onClick={() => setRows([])}>Clear</button>
        <button id="swaprows" onClick={swap}>Swap rows</button>
      </div>
      <table class="table">
        <tbody>
          <For each={rows()}>
            {row => (
              <tr class={isSelected(row.id) ? 'danger' : undefined}>
                <td class="id">{row.id}</td>
                <td class="label"><a onClick={() => setSelected(row.id)}>{row.label()}</a></td>
                <td class="remove"><a onClick={() => setRows(rows().filter(item => item.id !== row.id))}>x</a></td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </>
  )
}
