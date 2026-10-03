import { guard } from 'kay'

export default guard(({ locals, redirect }) => {
  if (!('user' in locals))
    redirect('/sign/in')
})
