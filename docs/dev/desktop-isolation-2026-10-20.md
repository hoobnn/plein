# 桌面生产与验收隔离（2026-10-20）

## 范围

本阶段提供正式包与验收包两个固定身份，不扩展双 Vite。更改只在独立 worktree 中实施，不重启制作实例、不重装或改写共享依赖。此文记录合同测试，尚不代表真实双开或安装包验收通过。

| 项目           | 正式包                             | 验收包                                                 |
| -------------- | ---------------------------------- | ------------------------------------------------------ |
| bundle ID      | `com.ikuyu.plein`                  | `com.ikuyu.plein.acceptance`                           |
| product name   | `Plein`                            | `Plein Acceptance`                                     |
| 输出目录       | `apps/desktop/release`             | `apps/desktop/release-acceptance`                      |
| macOS userData | 保持原路径                         | `<appData>/Plein Acceptance`                           |
| 业务数据       | 保持 `PLEIN_DATA_DIR` 覆盖及原默认 | 验收 userData 下的 `data`；忽略继承的 `PLEIN_DATA_DIR` |
| 窗口标识       | 保持原隐藏标题栏                   | 标准原生标题栏，`Plein Acceptance · 验收环境`          |
| 更新           | 保持既有逻辑                       | 始终关闭；不写正式 `app-update.yml`                    |

`profile.ts` 先设置名称与 userData，再获取单实例锁。桌面 session、日志、窗口、prefs 因此跟随独立 userData。正式版不改默认路径、bundle ID 或输出文件名。

包内 `pleinDesktopProfile` 在构建时冻结。已打包应用忽略运行时 `PLEIN_DESKTOP_PROFILE`，避免继承环境变量改变应用身份。老正式包没有此字段时仍按正式版处理；不支持任意第三种 profile。未打包 Electron 拒绝 `acceptance` 模式，因为仅更改名字和数据目录不能改变 macOS bundle ID。

## 构建和启动

仅在冻结的独立 checkout 中构建，独立安装依赖和产物，不把 `node_modules`、`stage`、`dist` 或 `release` 链接回生产树：

```sh
PLEIN_DESKTOP_PROFILE=acceptance pnpm dist:desktop
```

实际运行 `release-acceptance` 下的 `Plein Acceptance.app`。验收包使用自己的固定数据目录；导入项目包时由产品导入功能写入，不把生产数据目录传给验收实例。本地验收包为 ad-hoc 签名，发布签名、公证和更新链路仍需独立验收。

构建阶段仍会写当前 checkout 的 Web dist、desktop dist 与 stage。因此独立输出目录本身不构成源码/依赖隔离，必须配合冻结 checkout。此实现不更改正式发版 workflow，不创建或推送版本。

## 已运行验证

无需任何 npm 依赖或依赖写入，使用 Node 24+ 执行：

```sh
node --test apps/desktop/scripts/profile.contract.mjs
```

8 项合同测试通过，覆盖固定身份/拒绝非法值、锁前 userData 配置、生产默认兼容、包内 profile 不受环境切换、验收数据不读取生产 override、禁更新，原生标题栏样式，以及真实 electron-builder 配置的身份/metadata/输出/afterPack 更新源行为。测试只创建并清理临时目录，未启动 Electron。

`git diff --check` 通过。该 worktree 没有 node_modules，未安装依赖，因此未运行完整 desktop typecheck、打包和真实应用验收；这几项须由冻结环境执行。

## 必须补齐的真机证据

- 生产包与验收包同时运行，核对应用绝对路径、bundle ID、PID、userData、业务数据、日志与服务端实际地址；CUA 能分别选择正确应用。
- 同身份重复启动只激活自己的旧窗口，不激活另一身份。
- 两实例分别修改窗口与偏好，退出/重启后各自恢复；验收包导入真实项目并重导出时，生产 DB/素材未改变。
- 关闭验收开发服务器后仍能从包内资源启动，字幕字体、ffmpeg 与原生模块来源可核验。
- 在验收 checkout 重建依赖和产物，不改变生产运行时文件哈希或打断生产本地任务。
- 同一冻结 manifest 连续冷启动 3 次；最终用真实生产项目包做全新数据导入、编辑、重导出、全片解码与回放。
- 另一台 Mac 的项目包迁移需要真实另机证据，本机新目录不得替代。

## 打包资源与开发覆盖加固

补充评审确认：冻结 bundle ID 仍不足以阻止 `PLEIN_DESKTOP_DEV=1` 或 `--dev` 把安装包窗口指向 Vite，服务端还可能占用开发端口 8787。现在所有已打包应用始终为非开发模式；未打包开发行为保持兼容。

包内 server/main、Web index、ffmpeg、ffprobe、字幕字体固定为当前 app resources 下路径，并在 `serverPaths()` 被启动流程调用时检查文件和二进制执行权限。资源缺失不再借用继承路径或 PATH；错误经现有 boot → fatal 启动对话框展示，模块导入不探测资源。

服务端子进程资源环境变量统一覆盖为包内路径，并移除继承的开发模式和开发页面地址。显式 mock 配置不属于本次资源隔离修改，沿用原有行为，不能据此宣称真实平台生成。

验收包保留自己 userData 中的 prefs.port 与占用时 fallback 0，不强制每次换随机端口，以免丢失按 origin 保存的 localStorage 状态；生产 prefs 路径不参与验收实例。

Node 独立合同现在共 13 项通过，新增打包开发标记免疫、指定/动态端口合同、恶意或陈旧资源环境覆盖、开发配置兼容、缺任一包内资源失败、不可执行媒体工具失败。仍未运行真实 Electron 双开及 fatal 对话框验收，不能由纯函数合同替代。
