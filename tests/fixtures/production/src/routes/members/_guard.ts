import { guard } from 'kay'

// Reads the session as pages do, through locals.
export default guard(async ({ locals, redirect }) => {
  if (await locals.session.get('user') === undefined)
    redirect('/account')
})
