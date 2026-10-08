import { auth } from '../../auth'

// Everything under /account is for members: a visitor goes to sign in, and comes back here after.
export default auth.guard({ redirect: '/login' })
