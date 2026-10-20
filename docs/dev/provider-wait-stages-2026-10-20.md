# 平台调用等待阶段：隔离评审与验证

日期：2026-10-20（Asia/Shanghai）

## 判断与范围

需要最小调整。现有全局队列、Provider Limiter、NodeRun 阶段和共用 UI 展示已经够用；不另建调度或恢复机制。

当前源码的隔离复现得到：全局并发 4、Provider 并发 2、5 个任务时，2 个进入 submit、2 个处于 waiting、1 个全局 queued。因此没有在本次当前源码复现“4 个都等待响应”的完整现场；没有读取真实画布、数据库或调用日志来推断现场原因。

明确复现的缺口是：submit 已返回 pending 和 remoteId 后，在首次 poll 前仍残留 submitting。MiniMax 首轮 pollAfterMs 为 10 秒。原有本地等待文案又把本地并发限制写成“平台并发已满”，容易混淆等待位置。

## 用户可见变化

- 全局 queued 显示“本地排队”，解释为等待 Plein 运行空位。
- Provider waiting 显示“等待调用空位”，解释为 Plein 本地的平台并发已满；不会承诺下一步一定重新提交，因为也可能在恢复查询已有任务。
- 收到平台任务 ID 后立即显示“平台已受理 · 等待任务状态”，不再显示等待提交响应。
- 平台明确返回 queued/running 后，才显示“平台排队”或“生成中”；缺省远端阶段时保持“平台已受理”。该未知阶段不点亮“排队”步骤。
- 恢复 pending、重新查询 fetched、lookup 查到任务的路径同样先显示已受理。

## 证据与边界

是否进入提交以受控 Provider 的 submit spy 和 Limiter 控制流验证；单独缺少 remoteId 不构成未发包证明。没有新增 ETA，没有改变并发配置、平台请求内容、重试策略、数据库 schema 或 submit_unknown 合同。

只读子代理先评审必要性与最小范围，再审查隔离 diff；发现并修正 accepted 阶段点亮“排队”步骤的问题。

改动仅在隔离 checkout `/private/tmp/plein-wait-stages`；基于 `af0a9214f41f2c4498b57c4ff06263cfea60b6cd`。未复制主工作区未提交改动，未修改共享源码或共享 node_modules，未重启主实例，未访问付费平台，未修改真实任务。开发实例有源码监听，因此未把修改直接写回主工作区。

## 验证

从隔离 checkout 直接使用复制的工具（无需依赖安装）：

```sh
./node_modules/.bin/vp test run apps/server/src/plugins/plugins.test.ts apps/server/src/runs/jobs.test.ts apps/server/src/runs/recovery.test.ts apps/web/src/canvas/runStatus.test.ts
./node_modules/.bin/tsc -p apps/server --noEmit
./node_modules/.bin/tsc -p apps/web --noEmit
./node_modules/.bin/vp lint apps/server/src/plugins/host.ts apps/server/src/plugins/plugins.test.ts apps/server/src/runs/jobs.test.ts apps/web/src/canvas/runStatus.ts apps/web/src/canvas/runStatus.test.ts packages/doc/src/types.ts packages/plugin-sdk/src/provider.ts
```

结果：4 个测试文件通过，77 项通过、1 项条件跳过（序列字幕能力相关）；服务端和 Web 类型检查、定向 lint、格式与 diff 空白检查通过。测试服务使用临时数据与随机本地端口，生成由假 Provider 完成。

覆盖：4/2 分层等待、受理后首次轮询前的状态、明确 queued/running 与缺省阶段转换、已有任务恢复不重提，以及原有未知提交/取消/恢复回归。

没有执行真实 MiniMax 2K I2V 请求，也没有声称主实例已更新或完成真实 UI 验收。

## 协调范围

生产逻辑：`apps/server/src/plugins/host.ts`、`apps/web/src/canvas/runStatus.ts`、`packages/doc/src/types.ts`、`packages/plugin-sdk/src/provider.ts`（注释）。

测试：`apps/server/src/plugins/plugins.test.ts`、`apps/server/src/runs/jobs.test.ts`、`apps/web/src/canvas/runStatus.test.ts`。

未修改正在协作的 `apps/server/src/runs/runs.ts`、`apps/web/src/features/runs/Tasks.tsx`，未提交或推送。
