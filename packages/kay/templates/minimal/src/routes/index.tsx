import { Counter } from '../components/Counter'

export default async function Home() {
  return (
    <section>
      <h1>Welcome to Kay</h1>
      <p>Zero-directive islands, native TSX, and Bun speed.</p>
      <Counter initial={0} />
    </section>
  )
}
