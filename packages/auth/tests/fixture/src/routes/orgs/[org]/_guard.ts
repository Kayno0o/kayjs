import { auth } from '../../../auth'

export default auth.guard({ require: auth.memberOf('admin') })
