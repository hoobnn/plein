# 模型账户权限的诚实预检（2026-10-20）

## 结论与范围

配置齐全、平台连接检查通过，都不足以证明当前账号具备具体模型、ASR 资源、Music 或音色权限。本增量不新增任何探针、付费请求、模态审批或“试一下就知道”的自动生成。

`ProviderTestResult` 现在明确返回 `scope`（配置或连接检查的类型，不代表该检查成功）、`modelAccess: unverified` 和 `checkedAt`。成功和失败均保留这三个字段。没有 `test` 实现的平台即使 descriptor 声称 connection，也只归类配置检查；目录与测试接口共用同一推断规则。

本地配置检查原有说明保留；连接成功说明为“连接检查通过；尚未验证具体模型、资源权限或余额”。设置中的“已配置”使用中性样式，附本地配置不代表模型权限或余额的说明。编辑配置后既有清除旧反馈机制不变，不持久化成功证明。

## 执行前说明

- 实际输入摘要中，只有节点声明 `audio.transcribe` 或 `audio.music` 时追加 `model_access_unverified` 提示，包含真实选择的完整模型引用。这是非阻断说明，不影响原缺配置/参数硬门禁，也不更改缓存键。
- 序列“识别全部对白”按钮旁明确显示所选模型的权限未验证、识别可能计费、已识别结果可复用。
- 原生序列本地导出不属于识别能力，不因保存了 ASR 模型或 `asrTiming` 参数就增加“即将调用 ASR”的提示。已有导出合同仍禁止导出时隐式识别。
- 未建立模型历史可用性数据库，不把一次历史成功、模型目录枚举、连接检查或宽泛 `auth` 错误推断为当前权限结论。

## 验证

已增加服务端合同：配置检查与连接检查都保持模型权限未验证；无 test 的平台只报告配置检查且 submit 为零；Music 与独立 ASR 的实际输入提示不发提交、不阻断；序列本地导出预览不误加 ASR 提示。现有浏览器配置恢复测试改为断言诚实连接反馈，并核对已配置不使用成功颜色。

独立 worktree 无 node_modules，未安装或写共享依赖。已用只读复用的 Oxfmt CLI 完成代码格式化，`git diff --check` 通过；Vitest、typecheck 与浏览器执行待主会话冻结环境运行，不能将新增测试代码记为测试已通过。

建议冻结环境运行：

```sh
pnpm exec vp test run apps/server/src/plugins/plugins.test.ts apps/server/src/runs/preview.test.ts
pnpm typecheck
pnpm exec playwright test -c e2e/playwright.dev.config.ts e2e/provider-settings-recovery.spec.ts
```

所有上述测试使用模拟平台，不验证真实付费平台权限。真实 ASR/Music 当前未授权问题仍如实保留，账户权限由平台授权或今后用户主动授权的真实生产请求证明。

## 传输错误边界

检查接口请求在客户端失败时没有服务端检查结果。ProviderSettings 使用既有本地 status 保存“检查请求失败”，不向 ProviderTestResult 填入虚构 scope、modelAccess 或 checkedAt，也不把本地网络异常当作平台完成了检查。已增加 503 → 本地错误 → 真实 mock 接口重试成功的浏览器合同；该测试待冻结环境执行。
