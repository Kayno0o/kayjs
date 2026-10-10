import type { JSX } from 'solid-js'
import type { Product } from '../../../shared/data'
import { batch, createSelector, createSignal, For } from 'solid-js'
import { formatPrice, rowBuilder } from '../../../shared/data'

export type PageProps = { page: 'products', products: Product[] } | { page: 'table' }

interface RowState {
  id: number
  label: () => string
  setLabel: (update: (label: string) => string) => void
}

export function App(props: PageProps) {
  return (
    <Layout page={props.page}>
      {props.page === 'products' ? <Products products={props.products} /> : <Table />}
    </Layout>
  )
}

// Marks the link to the page shown, as kay does by itself.
function Layout(props: { page: PageProps['page'], children: JSX.Element }) {
  const current = (page: PageProps['page']) => props.page === page ? 'page' : undefined

  return (
    <>
      <header class="site">
        <a class="brand" href="/" aria-current={current('products')}>Bench shop</a>
        <nav>
          <a href="/" aria-current={current('products')}>Products</a>
          <a href="/table" aria-current={current('table')}>Table</a>
        </nav>
      </header>
      <main>{props.children}</main>
      <footer>
        <p>Rendered for the benchmark</p>
      </footer>
    </>
  )
}

function Counter(props: { start: number }) {
  const [count, setCount] = createSignal(props.start)

  return (
    <button class="counter" onClick={() => setCount(c => c + 1)}>
      Clicked
      {' '}
      {count()}
    </button>
  )
}

function Products(props: { products: Product[] }) {
  return (
    <>
      <h1>Products</h1>
      <p class="summary">
        {props.products.length}
        {' '}
        products
      </p>
      <Counter start={0} />
      <ul class="products">
        <For each={props.products}>
          {product => (
            <li class="product">
              <h2>{product.name}</h2>
              <p class="price">{formatPrice(product.price)}</p>
              <p class={`stock ${product.stock === 0 ? 'out' : 'in'}`}>
                {product.stock}
                {' '}
                in stock
              </p>
              <ul class="tags">
                <For each={product.tags}>{tag => <li>{tag}</li>}</For>
              </ul>
            </li>
          )}
        </For>
      </ul>
    </>
  )
}

// The js-framework-benchmark's keyed Solid implementation: one signal per label and a selector for the highlighted row.
function Table() {
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
      <h1>Table</h1>
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
