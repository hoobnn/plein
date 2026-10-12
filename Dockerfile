# syntax=docker/dockerfile:1
# plein 单容器镜像：本地服务端 + 前端静态文件 + ffmpeg（含中文字体，用于烧录字幕）

FROM node:26-slim AS build
# Node 25 起不再自带 corepack，pnpm 版本与 package.json 的 packageManager 保持一致
RUN npm install -g pnpm@12.11.2
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/doc/package.json packages/doc/
COPY packages/canvas-core/package.json packages/canvas-core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/nodes/package.json packages/nodes/
COPY packages/providers/package.json packages/providers/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm --filter @plein/web build && pnpm --filter @plein/server build
# 只带服务端的生产依赖；工作区包已打进 dist
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @plein/server deploy --prod --legacy /out \
    && cp -r apps/web/dist /out/web

FROM node:26-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /out .
ENV NODE_ENV=production \
    PLEIN_HOST=0.0.0.0 \
    PLEIN_PORT=8787 \
    PLEIN_DATA_DIR=/data \
    PLEIN_WEB_DIST=/app/web
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# 服务端不用 Web Storage，关掉以免 Node 26 启动时打印实验特性警告
CMD ["node", "--no-experimental-webstorage", "dist/main.mjs"]
