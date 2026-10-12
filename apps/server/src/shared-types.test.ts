import type { PortType as DocPortType, RunStatus } from '@plein/doc'
import type { LibraryKindId } from '@plein/nodes'
import type { PortType as SdkPortType } from '@plein/plugin-sdk'
import type { JobStatus, LibraryKind } from '@plein/protocol'
import { describe, expectTypeOf, it } from 'vitest'

// doc 刻意不依赖其他包，几处同名类型各自定义；这里在类型层面保证它们一致
describe('共享类型保持一致', () => {
  it('端口类型、运行状态、资产库分类', () => {
    expectTypeOf<DocPortType>().toEqualTypeOf<SdkPortType>()
    expectTypeOf<RunStatus>().toEqualTypeOf<JobStatus>()
    expectTypeOf<LibraryKindId>().toEqualTypeOf<LibraryKind>()
  })
})
