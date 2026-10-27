/**
 * 给一批天然偏慢的用例文件统一放宽超时。
 *
 * 这些用例要么跑真实渲染和编码，要么要建很大的工程（几百个节点、几十个镜头），
 * 单条用例本来就要二十秒往上。默认 60s 的超时在并行、机器还有别的负载时不够用，
 * 逐个文件标 `test.slow()` 就是把这批放宽到三倍。
 *
 * 用法：在文件里 `import { slowFile } from './slow-file'` 并调用 `slowFile(test)`。
 */
import type { TestType } from '@playwright/test'

/** 标记整个文件的用例都算慢用例 */
export function slowFile(test: TestType<{}, {}>): void {
  test.beforeEach(() => {
    test.slow()
  })
}
