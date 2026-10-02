<script lang="ts">
  import { rowBuilder } from '../../../shared/data'

  // The js-framework-benchmark's keyed Svelte 5 implementation: a reactive label per row.
  class Item {
    id: number
    label = $state('')

    constructor(id: number, label: string) {
      this.id = id
      this.label = label
    }
  }

  const build = rowBuilder()
  let rows: Item[] = $state.raw([])
  let selected = $state(0)

  const create = (count: number) => build(count).map(row => new Item(row.id, row.label))

  function update() {
    for (let i = 0; i < rows.length; i += 10)
      rows[i]!.label += ' !!!'
  }

  function swap() {
    if (rows.length < 999)
      return

    const list = rows.slice()
    const second = list[1]!

    list[1] = list[998]!
    list[998] = second
    rows = list
  }
</script>

<h1>Table</h1><div class="jumbotron"><button id="run" onclick={() => (rows = create(1000))}>Create 1,000 rows</button><button id="runlots" onclick={() => (rows = create(10000))}>Create 10,000 rows</button><button id="add" onclick={() => (rows = [...rows, ...create(1000)])}>Append 1,000 rows</button><button id="update" onclick={update}>Update every 10th row</button><button id="clear" onclick={() => (rows = [])}>Clear</button><button id="swaprows" onclick={swap}>Swap rows</button></div><table class="table"><tbody>{#each rows as row (row.id)}<tr class={selected === row.id ? 'danger' : ''}><td class="id">{row.id}</td><td class="label"><a onclick={() => (selected = row.id)}>{row.label}</a></td><td class="remove"><a onclick={() => (rows = rows.filter(item => item.id !== row.id))}>x</a></td></tr>{/each}</tbody></table>
