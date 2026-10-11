'use client'

import type { Dispatch } from 'react'
import type { Row as RowData } from '../../../shared/data'
import { memo, useReducer, useState } from 'react'
import { rowBuilder } from '../../../shared/data'

interface State {
  rows: RowData[]
  selected: number | undefined
}

type Action = { type: 'set', rows: RowData[] } | { type: 'append', rows: RowData[] } | { type: 'update' } | { type: 'swap' } | { type: 'select', id: number } | { type: 'remove', id: number }

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'set':
      return { ...state, rows: action.rows }
    case 'append':
      return { ...state, rows: [...state.rows, ...action.rows] }
    case 'update':
      return { ...state, rows: state.rows.map((row, index) => index % 10 === 0 ? { ...row, label: `${row.label} !!!` } : row) }
    case 'swap': {
      if (state.rows.length < 999)
        return state

      const rows = state.rows.slice()

      rows[1] = state.rows[998]!
      rows[998] = state.rows[1]!

      return { ...state, rows }
    }
    case 'select':
      return { ...state, selected: action.id }
    case 'remove':
      return { ...state, rows: state.rows.filter(row => row.id !== action.id) }
  }
}

// A memoised row, so a change re-renders only the rows it touches.
const Row = memo(({ row, selected, dispatch }: { row: RowData, selected: boolean, dispatch: Dispatch<Action> }) => (
  <tr className={selected ? 'danger' : undefined}>
    <td className="id">{row.id}</td>
    <td className="label"><a onClick={() => dispatch({ type: 'select', id: row.id })}>{row.label}</a></td>
    <td className="remove"><a onClick={() => dispatch({ type: 'remove', id: row.id })}>x</a></td>
  </tr>
))

// The js-framework-benchmark's keyed React hooks implementation: one reducer for the rows and the selection, memoised rows.
export function Table() {
  const [build] = useState(() => rowBuilder())
  const [{ rows, selected }, dispatch] = useReducer(reduce, { rows: [], selected: undefined })

  return (
    <>
      <div className="jumbotron">
        <button id="run" onClick={() => dispatch({ type: 'set', rows: build(1000) })}>Create 1,000 rows</button>
        <button id="runlots" onClick={() => dispatch({ type: 'set', rows: build(10000) })}>Create 10,000 rows</button>
        <button id="add" onClick={() => dispatch({ type: 'append', rows: build(1000) })}>Append 1,000 rows</button>
        <button id="update" onClick={() => dispatch({ type: 'update' })}>Update every 10th row</button>
        <button id="clear" onClick={() => dispatch({ type: 'set', rows: [] })}>Clear</button>
        <button id="swaprows" onClick={() => dispatch({ type: 'swap' })}>Swap rows</button>
      </div>
      <table className="table">
        <tbody>
          {rows.map(row => <Row key={row.id} row={row} selected={row.id === selected} dispatch={dispatch} />)}
        </tbody>
      </table>
    </>
  )
}
