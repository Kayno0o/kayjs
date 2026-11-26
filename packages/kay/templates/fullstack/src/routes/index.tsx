import { Counter } from '../components/Counter'
import { GreetForm } from '../components/GreetForm'

export default async function Home() {
  return (
    <section>
      <h1>Welcome to Kay</h1>
      <p>Zero-directive islands, Standard-Schema actions, and Bun speed.</p>
      <Counter initial={0} />
      <GreetForm />
    </section>
  )
}
