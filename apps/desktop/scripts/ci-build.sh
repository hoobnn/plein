#!/usr/bin/env bash
# 发版时由 hoobnn/ci-workflows 的 macos-release.yml 作为 build-command 调用，产出
# apps/desktop/release/mac-arm64/Plein.app，之后由它重签外层、公证、打 zip / dmg 并发布。
#
# 复用工作流只做 checkout，不装 Node / pnpm，也用不了 actions/cache，所以工具链和 ffmpeg 都在这里准备
# （ffmpeg 从源码构建约 5 分钟）。
#
# 内层签名交给 electron-builder：复用工作流签 inner-binaries 时不带 entitlements，而 Electron 的
# Helper 需要 allow-jit 等权限，Framework、原生模块也多。复用工作流已把 Developer ID 证书导入
# 临时钥匙串，并传入 APPLE_SIGN_IDENTITY_APPLICATION；这里用它由内向外签好整个 .app
# （hardenedRuntime + entitlementsInherit），不公证。
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
tmp=${RUNNER_TEMP:-$(mktemp -d)}

# Node：取 .nvmrc 大版本的最新发行版，校验 SHA-256
node_dist="https://nodejs.org/dist/latest-v$(tr -d '[:space:]v' < .nvmrc).x"
curl -fsSL -o "$tmp/SHASUMS256.txt" "$node_dist/SHASUMS256.txt"
node_tar=$(awk '/ node-v[0-9.]+-darwin-arm64\.tar\.xz$/ { print $2 }' "$tmp/SHASUMS256.txt")
curl -fsSL -o "$tmp/$node_tar" "$node_dist/$node_tar"
(cd "$tmp" && grep " $node_tar\$" SHASUMS256.txt | shasum -a 256 -c -)
tar -xf "$tmp/$node_tar" -C "$tmp"
export PATH="$tmp/${node_tar%.tar.xz}/bin:$PATH"
# pnpm：版本取自 package.json 的 packageManager
npm install -g --silent "$(node -p "require('./package.json').packageManager")"
node --version && pnpm --version

brew install meson ninja pkgconf
apps/desktop/scripts/build-ffmpeg.sh

pnpm install --frozen-lockfile
pnpm --filter @plein/web build

# 标签 v0.1.0 → 0.1.0，写进 CFBundleShortVersionString；复用工作流会核对它和标签一致
if [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  export PLEIN_VERSION=${GITHUB_REF#refs/tags/v}
fi
# electron-builder 的身份名不带类型前缀
export CSC_NAME=${APPLE_SIGN_IDENTITY_APPLICATION#Developer ID Application: }

cd apps/desktop
pnpm stage:server
pnpm exec electron-builder --mac --dir --publish never --config electron-builder.config.mjs
