import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { forgetPageData, pageData } from '../src/runtime/page-data'

describe('the scripts a page holds for its islands', () => {
  beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
  afterAll(async () => GlobalRegistrator.unregister())

  it('are searched for once per page by a read that keeps them, again after a swap', () => {
    document.body.innerHTML = '<script type="application/json" data-kay-test>1</script>'

    const searched = spyOn(document, 'querySelectorAll')

    try {
      for (let read = 0; read < 3; read++)
        expect(pageData<number>('script[data-kay-test]', JSON.parse, true)).toEqual([1])

      expect(searched).toHaveBeenCalledTimes(1)

      document.body.innerHTML = '<script type="application/json" data-kay-test>2</script>'
      forgetPageData()

      expect(pageData<number>('script[data-kay-test]', JSON.parse, true)).toEqual([2])
      expect(searched).toHaveBeenCalledTimes(2)

      // A read that does not keep them sees a script added without a swap.
      document.body.innerHTML += '<script type="application/json" data-kay-test>3</script>'

      expect(pageData<number>('script[data-kay-test]')).toEqual([2, 3])
    }
    finally {
      searched.mockRestore()
    }
  })
})
