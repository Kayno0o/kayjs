<script setup lang="ts">
import type { Row } from '../../../../shared/data'
import { rowBuilder } from '../../../../shared/data'

// The js-framework-benchmark's keyed Vue implementation: a shallow ref of plain rows replaced on each change, rows memoised on their label and selection.
const build = rowBuilder()
const rows = shallowRef<Row[]>([])
const selected = ref<number>()

function update() {
  for (let index = 0; index < rows.value.length; index += 10)
    rows.value[index]!.label += ' !!!'

  rows.value = rows.value.slice()
}

function swap() {
  if (rows.value.length < 999)
    return

  const list = rows.value.slice()

  list[1] = rows.value[998]!
  list[998] = rows.value[1]!
  rows.value = list
}

function remove(id: number) {
  rows.value = rows.value.filter(row => row.id !== id)
}
</script>

<template>
  <div class="jumbotron">
    <button id="run" @click="rows = build(1000)">Create 1,000 rows</button>
    <button id="runlots" @click="rows = build(10000)">Create 10,000 rows</button>
    <button id="add" @click="rows = [...rows, ...build(1000)]">Append 1,000 rows</button>
    <button id="update" @click="update">Update every 10th row</button>
    <button id="clear" @click="rows = []">Clear</button>
    <button id="swaprows" @click="swap">Swap rows</button>
  </div>
  <table class="table">
    <tbody>
      <tr v-for="{ id, label } of rows" :key="id" v-memo="[label, id === selected]" :class="id === selected ? 'danger' : undefined">
        <td class="id">{{ id }}</td>
        <td class="label"><a @click="selected = id">{{ label }}</a></td>
        <td class="remove"><a @click="remove(id)">x</a></td>
      </tr>
    </tbody>
  </table>
</template>
