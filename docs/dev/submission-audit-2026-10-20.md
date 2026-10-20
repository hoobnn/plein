# 提交关联与人工恢复审计

本合同为原有 unknown / pending / fetched 恢复合同增加持久化核查证据。

- 每次进入 `Provider.submit` 前，宿主同步写入 `submitting.trace` 和 `call_history` 的 `submit_started`。同一个 SQLite UPDATE 同时写两者，失败不发送。该事件表示准备进入提交，不证明网络到达、平台受理或计费。
- `attemptId` 区分 submit 调用；`requestId` 是客户端关联 UUID。豆包把它放入 `X-Api-Request-Id`，在响应头到达、读取 body 前同步记录平台日志 ID 和 HTTP 状态。其他适配器可逐步采用可选 SDK 上下文；记录 UUID 不自动赋予平台查询或幂等能力。
- `idempotencyKey` 沿用已有稳定合同；幂等重放不因新关联 UUID 改变幂等键。恢复 pending/fetched 不创建新的 attemptId。
- `call_history` 只追加事件，不参与活动 `calls` 的恢复状态推导。人工 resubmit/attach/dismiss 在同一事务中记录原状态、原关联信息、原时间及已有错误，再变更活动调用和排队/处理状态。写失败全部回滚，不排队。
- 用户授权补提交不会证明平台未受理，也不会核销旧未知请求。后续成功仍保留原 UUID、人工决策和新的尝试，任务面板可复制核查摘要。
- `JobInfo.submissionHistory` 使用字段白名单，排除原始错误、输入、凭据、结果 URL。原错误仅保留在本机审计记录，原有任务错误展示合同不变。
- 新增 migration 0005，旧记录默认空历史，不虚构旧 UUID。完整本机备份包含审计；共享 `.plein` 继续不导出 raw calls/call_history，导入后的历史不会续查或提交。

验证使用本地响应、临时 SQLite 和正式维护备份链：发送入口前能读到同一 UUID；写失败零 fetch；响应 ID 留存；补提交成功保留旧未知证据；人工事务失败不改变旧记录、不新增 submit；迁移/备份保留字段；包导入不携带原始审计；复制信息不含输入正文。此回归不证明真实平台计费、硬退出恢复或多期连续生产，后续冻结版本验收需另行执行。

## 独立字幕 journal 与进程硬退出补充验证

字幕识别的文件 journal 与节点任务使用相同的可选审计事件合同。当前 record、trace 和 audit 在同一个临时文件完整写入、fsync 后原子替换；写失败不会进入 submit，人工补提交写失败不删除旧 unknown。人工 attach 保留旧 trace，补提交开始新 UUID，旧 unknown 快照与人工决策和历史事件始终保留。已有文件无 audit 时按空数组兼容。恢复查询提供白名单摘要；识别成功仍沿用原 API 的 null 恢复提示，完整历史留在本机文件及备份中。

`runs/submission-crash.test.ts` 使用真实 Node 子进程、PluginHost、Doubao adapter 和 SQLite，将传输强制发往 127.0.0.1 假服务器。服务器收到请求后不回应，独立 SQLite 连接先验证 UUID 已持久化，随后 SIGKILL 子进程；第二子进程恢复后，原 calls/history 不变，本机假服务器请求总数为 1。该验证证明进程硬退出下关联 ID 与防重提合同，不证明断电、真实平台受理或计费。
