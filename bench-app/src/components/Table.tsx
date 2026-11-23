import { selector, signal } from 'kay'
import { type Row, rowBuilder } from '../data'

const build = rowBuilder()

export function Table() {
  const rows = signal<Row[]>([])
  const selectedId = signal<number | null>(null)
  const selected = selector(() => selectedId.value)

  function swap() {
    const list = rows.value
    if (list.length < 999)
      return
    const swapped = list.slice()
    swapped[1] = list[998]!
    swapped[998] = list[1]!
    rows.value = swapped
  }

  return (
    <>
      <div class="jumbotron">
        <button id="run" onClick={() => rows.value = build(1000)}>Create 1,000 rows</button>
        <button id="runlots" onClick={() => rows.value = build(10000)}>Create 10,000 rows</button>
        <button id="add" onClick={() => rows.value = [...rows.value, ...build(1000)]}>Append 1,000 rows</button>
        <button id="update" onClick={() => rows.value = rows.value.map((r, i) => i % 10 === 0 ? { ...r, label: `${r.label} !!!` } : r)}>Update every 10th row</button>
        <button id="clear" onClick={() => rows.value = []}>Clear</button>
        <button id="swaprows" onClick={swap}>Swap rows</button>
      </div>
      <table class="table">
        <tbody>
          {rows.value.map(row => (
            <tr key={row.id} class={selected.is(row.id) ? 'danger' : undefined}>
              <td class="id">{row.id}</td>
              <td class="label"><a onClick={() => selectedId.value = row.id}>{row.label}</a></td>
              <td class="remove"><a onClick={() => rows.value = rows.value.filter(item => item.id !== row.id)}>x</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
