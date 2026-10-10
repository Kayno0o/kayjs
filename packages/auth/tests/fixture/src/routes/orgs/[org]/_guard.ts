import { auth } from '../../../auth'

export default auth.guard({ redirect: '/login', require: auth.memberOf('admin') })
