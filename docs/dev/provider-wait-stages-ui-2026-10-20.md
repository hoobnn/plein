# 平台调用等待阶段：实际界面验收

日期：2026-10-20（Asia/Shanghai）

## 结论

实际界面验收通过。Mac 解锁后，先在原生 Electron 开发版只读检查制作画布任务面板，再在 Chrome 中使用当前源码构建的实际 Plein 界面核对受控假任务的阶段切换。

主实例 `localhost:5173/#/c/cv_2dwkTrseH7hV` 显示 13 单视频批次已完成，历史“提交结果未知”的人工核查入口仍存在。没有重新运行、恢复、取消或采用任何制作任务，没有修改制作画布或重启主实例。

## 受控任务验收

复制当前源码与依赖到独立 checkout，构建实际 Web UI；使用独立端口 18973、全新临时数据。仅覆盖进程内的假 Provider，未使用凭据或外部网络请求。全局并发 4、假 Provider 并发 2，同时启动 5 个任务，经过真实 NodeRuns → PluginHost → Limiter → 文档同步 → 节点卡片与任务面板。

| 检查点 | 实际界面结果 |
| --- | --- |
| 提交被受控暂停 | 2 单等待提交响应，2 单等待调用空位，1 单本地排队 |
| 提交超过 30 秒 | 只有提交中的 2 单出现响应较慢说明；本地空位等待不出现该警告 |
| 假平台返回任务 ID | 2 单立即显示平台已受理、等待任务状态，慢响应说明消失 |
| 已受理但没有远端阶段 | 任务面板对应两行不显示四步进度条，没有暗示平台正在排队 |
| 假平台明确返回 queued | 对应任务显示平台排队，排队步骤点亮 |
| 假平台明确返回 running、progress=0.42 | 对应任务显示生成中 42%，生成步骤点亮 |
| 后续轮询没有远端阶段 | 回到平台已受理，隐藏步骤条，未继续臆测生成 |
| 释放假平台结果 | 空位依次释放，5 个任务全部已完成，进行中列表清空 |

假 Provider 调用日志证明初始只进入两次 submit；后续三次只在前面的任务完成后发生。这个结论基于实际 submit 入口日志与控制流，不依据缺少 remoteId 单独判断。

## 证据

截图、DOM/AX 记录、假 Provider 入口日志、验收 harness 与隔离环境清单保存在仓库忽略目录：

`.cache/acceptance/provider-wait-stages-2026-10-20/`

- `main-instance-tasks.png`：原生开发版制作画布任务面板。
- `01-local-wait-and-submitting.png`：两层本地等待与慢提交响应。
- `02-accepted.png`、`02-accepted.dom.json`：已受理阶段，两行四步进度条数量均为 0。
- `03-remote-queued.png`、`04-generating.png`：真实 UI 展示假平台明确报告的阶段。
- `05-unknown-remote-stage.png`：缺省远端阶段时回到已受理。
- `06-completed.png`、`06-completed.dom.json`：五个假任务全部完成。
- `provider-events.jsonl`、`ui-wait-acceptance.ts`：受控假平台入口证据与复现脚本。

## 同步维护与边界

更新 `e2e/task-submission-wait.spec.ts`：把旧“等待空位”断言改为“等待调用空位”，补充本地限制说明、accepted 文案、消除慢响应提示与隐藏四步条断言。根目录 TypeScript 检查、该文件格式检查及 diff 空白检查通过。

本次实际 UI 操作通过 cua_repl 完成；未重新执行 Playwright E2E runner。此前 77 项队列/恢复回归结果见原阶段实现报告，本次不重复计数。

未验证新的付费 MiniMax I2V 请求。主实例已结束的历史任务不能重现活动阶段，活动阶段验收基于实际 Plein UI 与隔离假 Provider；不把它描述为付费平台在线验收。

隔离验收服务和浏览器标签已关闭，临时 checkout、构建与测试数据已清理。共享依赖未修改。没有提交或推送。
