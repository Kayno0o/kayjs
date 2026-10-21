import { guard } from 'kay'

export default guard(({ redirect, url }) => {
  const to = url.searchParams.get('to')

  if (to !== null)
    redirect(to)
})
