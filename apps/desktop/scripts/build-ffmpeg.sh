#!/usr/bin/env bash
# 构建随桌面安装包附带的 ffmpeg / ffprobe：
# - LGPL 构建（不含 libx264 等 GPL 组件），H.264 用系统的 VideoToolbox 硬件编码；
# - 带 libass（烧字幕），连同 freetype、fribidi、harfbuzz 静态链接，只依赖系统框架；
# - 字体走 macOS 的 CoreText，不需要 fontconfig。
#
# 用法：apps/desktop/scripts/build-ffmpeg.sh [输出目录]
# 默认输出到 apps/desktop/stage/ffmpeg；中间文件在 FFMPEG_WORK（默认 apps/desktop/.ffmpeg-build），可缓存。
# 依赖：Xcode 命令行工具、pkg-config、meson、ninja（brew install pkg-config meson ninja）。
# 在 Linux 上也能跑（用于检查脚本；字体走 fontconfig，没有 VideoToolbox）。
set -euo pipefail

FFMPEG_VERSION=7.1.1
FREETYPE_VERSION=2.13.3
FRIBIDI_VERSION=1.0.16
HARFBUZZ_VERSION=11.2.1
LIBASS_VERSION=0.17.3
LIBVPX_VERSION=1.16.0
# Official webmproject archive, pinned bytes (not a moving branch).
LIBVPX_SHA256=7a479a3c66b9f5d5542a4c6a1b7d3768a983b1e5c14c60a9396edc9b649e015c

here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$here/stage/ffmpeg}
work=${FFMPEG_WORK:-$here/.ffmpeg-build}
prefix=$work/prefix
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
os=$(uname -s)

mkdir -p "$work/src" "$prefix"
export PKG_CONFIG_PATH=$prefix/lib/pkgconfig
export PKG_CONFIG_LIBDIR=$prefix/lib/pkgconfig
if [ "$os" = Darwin ]; then
  # 与 Electron 支持的最低系统一致
  export MACOSX_DEPLOYMENT_TARGET=12.0
fi
export CFLAGS="-O2 -fPIC ${CFLAGS:-}"

fetch() { # fetch <目录名> <地址> [备用地址...]
  local dir=$work/src/$1
  [ -d "$dir" ] && return
  echo "下载 $1"
  local archive=$work/src/$1.archive
  shift
  local url ok=
  for url in "$@"; do
    if curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 -o "$archive" "$url"; then
      ok=1
      break
    fi
    echo "下载失败，换下一个地址：$url" >&2
  done
  [ -n "$ok" ] || { echo "无法下载 $dir" >&2; exit 1; }
  mkdir -p "$dir"
  tar -xf "$archive" -C "$dir" --strip-components=1
  rm "$archive"
}

# Verify cached archives too; extracted directories alone are not a checksum proof.
fetch_verified() {
  local name=$1 expected=$2 url=$3 archive=$work/src/$1.tar.gz
  if [ ! -f "$archive" ]; then
    curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 -o "$archive" "$url"
  fi
  local actual
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  [ "$actual" = "$expected" ] || { echo "SHA256 mismatch for $name: $actual" >&2; exit 1; }
  if [ ! -d "$work/src/$name" ]; then
    mkdir -p "$work/src/$name"
    tar -xf "$archive" -C "$work/src/$name" --strip-components=1
  fi
}

built() { [ -f "$prefix/.built-$1" ]; }
mark() { touch "$prefix/.built-$1"; }

meson_static() { # meson_static <源码目录> [meson 选项...]
  local src=$1
  shift
  meson setup "$src/_build" "$src" --prefix="$prefix" --libdir=lib --buildtype=release \
    --default-library=static --wrap-mode=nodownload "$@"
  ninja -C "$src/_build" -j "$jobs"
  ninja -C "$src/_build" install
}

fetch "freetype-$FREETYPE_VERSION" \
  "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VERSION.tar.xz" \
  "https://downloads.sourceforge.net/project/freetype/freetype2/$FREETYPE_VERSION/freetype-$FREETYPE_VERSION.tar.xz"
if ! built freetype; then
  meson_static "$work/src/freetype-$FREETYPE_VERSION" \
    -Dharfbuzz=disabled -Dpng=disabled -Dbrotli=disabled -Dbzip2=disabled -Dzlib=disabled
  mark freetype
fi

fetch "fribidi-$FRIBIDI_VERSION" \
  "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VERSION/fribidi-$FRIBIDI_VERSION.tar.xz"
if ! built fribidi; then
  meson_static "$work/src/fribidi-$FRIBIDI_VERSION" -Ddocs=false -Dtests=false -Dbin=false
  mark fribidi
fi

fetch "harfbuzz-$HARFBUZZ_VERSION" \
  "https://github.com/harfbuzz/harfbuzz/releases/download/$HARFBUZZ_VERSION/harfbuzz-$HARFBUZZ_VERSION.tar.xz"
if ! built harfbuzz; then
  meson_static "$work/src/harfbuzz-$HARFBUZZ_VERSION" \
    -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled \
    -Dchafa=disabled -Dgraphite2=disabled -Dcoretext=disabled -Dtests=disabled -Ddocs=disabled \
    -Dutilities=disabled -Dintrospection=disabled
  mark harfbuzz
fi

fetch "libass-$LIBASS_VERSION" \
  "https://github.com/libass/libass/releases/download/$LIBASS_VERSION/libass-$LIBASS_VERSION.tar.xz"
if ! built libass; then
  (
    cd "$work/src/libass-$LIBASS_VERSION"
    if [ "$os" = Darwin ]; then
      fonts=(--enable-coretext --disable-fontconfig)
    else
      fonts=(--enable-fontconfig)
      # Linux 上只为检查脚本：fontconfig 用系统的
      export PKG_CONFIG_LIBDIR=$PKG_CONFIG_LIBDIR:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/pkgconfig:/usr/share/pkgconfig
    fi
    ./configure --prefix="$prefix" --enable-static --disable-shared --disable-asm \
      --disable-libunibreak "${fonts[@]}"
    make -j "$jobs"
    make install
  )
  mark libass
fi

fetch_verified "libvpx-$LIBVPX_VERSION" "$LIBVPX_SHA256" \
  "https://github.com/webmproject/libvpx/archive/refs/tags/v$LIBVPX_VERSION.tar.gz"
if ! built "libvpx-$LIBVPX_VERSION-$LIBVPX_SHA256"; then
  (
    cd "$work/src/libvpx-$LIBVPX_VERSION"
    ./configure --prefix="$prefix" --enable-static --disable-shared --enable-pic \
      --disable-examples --disable-tools --disable-docs --disable-unit-tests
    make -j "$jobs"
    make install
  )
  mark "libvpx-$LIBVPX_VERSION-$LIBVPX_SHA256"
fi

# ffmpeg.org 偶尔连不上，退到 GitHub 上的官方镜像（同一标签的源码）
fetch "ffmpeg-$FFMPEG_VERSION" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
  "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n$FFMPEG_VERSION.tar.gz"
ffmpeg_flags=(
  --prefix="$prefix"
  --pkg-config-flags=--static
  --disable-debug --disable-doc --disable-ffplay --disable-network
  --disable-autodetect --enable-zlib
  --enable-libvpx --enable-libass --enable-libfreetype --enable-libfribidi --enable-libharfbuzz
)
if [ "$os" = Darwin ]; then
  ffmpeg_flags+=(--enable-videotoolbox --enable-audiotoolbox)
else
  ffmpeg_flags+=(--enable-libfontconfig)
fi
(
  cd "$work/src/ffmpeg-$FFMPEG_VERSION"
  [ "$os" = Darwin ] || export PKG_CONFIG_LIBDIR=$PKG_CONFIG_LIBDIR:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/pkgconfig:/usr/share/pkgconfig
  ./configure "${ffmpeg_flags[@]}"
  make -j "$jobs"
)

rm -rf "$out"
mkdir -p "$out"
cp "$work/src/ffmpeg-$FFMPEG_VERSION/ffmpeg" "$work/src/ffmpeg-$FFMPEG_VERSION/ffprobe" "$out/"
strip "$out/ffmpeg" "$out/ffprobe" 2>/dev/null || true

# LGPL：附上版本、源码地址和配置，用户可以自行替换成别的 ffmpeg
cat >"$out/README.txt" <<EOF
Plein 附带的 ffmpeg / ffprobe（LGPL 2.1 或更高版本）

ffmpeg $FFMPEG_VERSION     https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
libass $LIBASS_VERSION      https://github.com/libass/libass（ISC）
freetype $FREETYPE_VERSION  https://freetype.org（FreeType License）
fribidi $FRIBIDI_VERSION    https://github.com/fribidi/fribidi（LGPL 2.1）
harfbuzz $HARFBUZZ_VERSION  https://github.com/harfbuzz/harfbuzz（MIT）
libvpx $LIBVPX_VERSION      https://github.com/webmproject/libvpx/archive/refs/tags/v$LIBVPX_VERSION.tar.gz（BSD 3-Clause + PATENTS）
libvpx source SHA256: $LIBVPX_SHA256

配置：./configure ${ffmpeg_flags[*]/--prefix=*/}
构建脚本：https://github.com/hoobnn/plein/blob/main/apps/desktop/scripts/build-ffmpeg.sh

要换成自己的 ffmpeg，替换本目录下的两个可执行文件即可。
EOF
cp "$work/src/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$out/COPYING.LGPLv2.1"
cp "$work/src/libvpx-$LIBVPX_VERSION/LICENSE" "$out/LICENSE.libvpx"
cp "$work/src/libvpx-$LIBVPX_VERSION/PATENTS" "$out/PATENTS.libvpx"

# 自检：必须是 LGPL、带 ass 滤镜（先取输出再匹配，免得 grep -q 提前退出触发 pipefail）
license=$("$out/ffmpeg" -hide_banner -L 2>&1)
filters=$("$out/ffmpeg" -hide_banner -filters 2>/dev/null)
encoders=$("$out/ffmpeg" -hide_banner -encoders 2>/dev/null)
grep -q 'GNU Lesser General Public' <<<"$license" || { echo '不是 LGPL 构建' >&2; exit 1; }
grep -qE '^\s*\S+\s+ass\s' <<<"$filters" || { echo '缺少 ass 滤镜' >&2; exit 1; }
grep -q libvpx-vp9 <<<"$encoders" || { echo '缺少 libvpx-vp9 编码器' >&2; exit 1; }
if [ "$os" = Darwin ]; then
  grep -q h264_videotoolbox <<<"$encoders" || { echo '缺少 h264_videotoolbox 编码器' >&2; exit 1; }
  # 只能依赖系统库，不能指向 Homebrew 或构建目录
  if otool -L "$out/ffmpeg" "$out/ffprobe" | grep -vE '^\S|/System/Library/|/usr/lib/'; then
    echo '链接了系统以外的动态库' >&2
    exit 1
  fi
fi
echo "ffmpeg 已构建：$out"
"$out/ffmpeg" -hide_banner -version | head -1
