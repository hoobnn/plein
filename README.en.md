<div align="center">

<img src="apps/web/public/plein-icon.png" width="112" alt="Plein" />

# Plein

**A local-first AI infinite canvas for short drama.**<br/>
Idea, script, characters, storyboard, shots, voiceover and the final cut live on one infinite canvas. Every step stays visible, editable and re-runnable on its own.

[![CI](https://github.com/hoobnn/plein/actions/workflows/ci.yml/badge.svg)](https://github.com/hoobnn/plein/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hoobnn/plein)](https://github.com/hoobnn/plein/releases)
![Platform](<https://img.shields.io/badge/platform-macOS%20(Apple%20silicon)%20%7C%20self--hosted-lightgrey>)

[简体中文](README.md) · **English**

[Quick start](#quick-start) · [Features](#features) · [Roadmap](#roadmap) · [Docs](#docs) · [Contributing](CONTRIBUTING.md)

</div>

> [!NOTE]
> Plein 0.1.0 is out for macOS (Apple silicon). The full pipeline has produced a 6-shot vertical sample on real platforms (Alibaba Cloud Model Studio + Doubao Speech). The data format may still change during 0.x, see the [roadmap](#roadmap).
>
> The app UI and most docs are currently in Simplified Chinese only.

![Canvas: storyboard frames, videos and line-by-line voiceover for each shot](docs/images/canvas.png)

## Why Plein

- **The pipeline is on the canvas**: script, character cards, storyboard, shot images, videos, voiceover and the sequence are all wired-up nodes on the canvas. No black boxes. Change one step and you can see exactly what downstream needs a re-run.
- **Review before you spend**: inserting a template only builds the skeleton and never calls a model on its own. Review the storyboard and shot images first, then generate videos and voiceover in batches. Any shot can switch candidates, regenerate, or be replaced by hand.
- **Your data stays yours**: one Node process, one SQLite file, one asset folder. API keys live only on the local server, never in the canvas or the browser.
- **Built for Chinese model platforms**: Volcengine Ark, Doubao Speech, Alibaba Cloud Model Studio (Bailian) and MiniMax work out of the box; node parameters adapt to the selected model.
- **Let AI click the buttons**: the built-in agent "Xiaoman" reads the canvas, creates nodes, runs the storyboard and processes media. You can also hand the work to a locally signed-in Claude Code / Codex, or let Cursor and Claude Desktop drive the canvas over MCP.

## Features

### Canvas

- Infinite canvas rendered with PixiJS (WebGL) on a Yjs document model: undo / redo, survives refresh and restart, syncs across tabs
- Drag, paste or import whole folders of images, videos, audio and Markdown; custom video and audio players
- Minimap, layers panel, storyboard view, auto-arrange, multi-select toolbar, ⌘K command palette, light / dark themes

### Generation nodes

- Text, chat (LLM), image, video, voiceover and music nodes; forms are generated from the selected model, 9 aspect ratios
- You choose the video mode: text-to-video, first frame, first + last frame or multi-image reference, with candidate count and synced audio
- `@` references character / scene / prop / style cards in prompts, with disambiguation for duplicate names; `/` at line start applies presets such as three-view turnaround, expression grid, multi-angle and four-panel story
- Prompt enhancement and translation; every run keeps candidates and history, and downstream only uses the version you adopt

### Short drama pipeline

| Storyboard                                                                          | Sequence editor                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ![Storyboard: shot size, visuals, dialogue and prompts](docs/images/storyboard.png) | ![Sequence editor: ordering, in / out points, dialogue and subtitle preview](docs/images/sequence.png) |

- One-click short drama template: idea → script → character and scene extraction → setting cards → storyboard → shots → sequence
- Edit the storyboard as a table; once expanded into shot nodes, later table edits show a diff and only sync fields you have not changed by hand
- Shot images, videos and voiceover generate in stages and in batches; failures retry individually
- Sequence editor: ordering, in / out points, dialogue / music / SFX tracks, subtitle styles, fades and cross-dissolves, in-browser preview on the export timeline
- Server-side ffmpeg export to MP4 (9:16 / 16:9, 1080p / 720p) with burned-in Chinese subtitles, optionally aligned by speech recognition
- Export editing projects (OTIO / FCPXML / SRT) together with their assets

### Media processing

- Image: crop, rotate, mirror, grid split
- Video: trim, speed change, extract frames to the library, split audio and video
- Audio: trim, manual split, pitch-preserving speed change

Every result is a new asset with its source recorded; originals are never touched.

### Projects and asset library

- One project per film, each with multiple canvases
- The asset library holds characters, scenes, props, styles and effects, reusable across canvases and projects. Characters have full-body / half-body / turnaround / emotion-grid slots, tags and a voice; canvas cards and the library sync both ways

### Runs and jobs

- Run a single node, run up to here (with upstream), run downstream, or run a whole group; unchanged nodes hit the cache instead of spending again
- Jobs are queued in SQLite, keep running after the page closes, and resume polling remote tasks after a server restart
- The job panel shows progress, automatic retries and failure reasons; nodes whose parameters or upstream changed are marked "needs re-run"

### Agent "Xiaoman"

- Built-in agent: drives the canvas with any enabled chat model that supports tool calling, no extra software needed
- Local CLI: calls Claude Code or Codex already signed in on this machine, using your own account and quota
- MCP server: Claude Code, Claude Desktop, Cursor and others can connect to your local Plein
- Asks before spending money or deleting; supports plan mode; a whole turn of changes can be undone at once

See [Agent and MCP](docs/guide/agent.md) (Chinese).

### Model platforms

| Platform                   | Chat                     | Image           | Video              | Speech and audio                                  |
| -------------------------- | ------------------------ | --------------- | ------------------ | ------------------------------------------------- |
| Volcengine Ark             | Doubao Seed              | Seedream 5.0    | Seedance 2.0 / 2.5 | —                                                 |
| Doubao Speech              | —                        | —               | —                  | TTS 2.0, Seed Audio music & SFX, fast recognition |
| Alibaba Cloud Model Studio | Qwen (with tool calling) | Qwen Image, Wan | Wan 3.0            | Qwen TTS                                          |
| MiniMax                    | M3 / M2.7                | image-01        | H3 / H3-Max        | speech-2.8, Music 3.0                             |

Parameter mapping and capability limits per platform are in [Model platforms](docs/guide/providers.md) (Chinese). New platforms, nodes and templates can be added as plugins, see [Plugins](docs/dev/plugins.md) (Chinese).

## Quick start

### Desktop app (macOS, recommended)

Download `Plein-<version>-macOS-arm64.dmg` (Apple silicon) from [Releases](https://github.com/hoobnn/plein/releases/latest) and drag it into Applications. It is signed and notarized by Apple, ships with ffmpeg, checks for updates on launch, and can check manually from "Plein → Check for Updates…". Intel Macs and Windows have no prebuilt package yet; build from source with `pnpm install && pnpm dist:desktop`.

### Self-host with Docker

```bash
git clone https://github.com/hoobnn/plein.git && cd plein
docker compose up -d
```

There is no prebuilt image; `compose` builds from source. Open <http://localhost:8787>. The image includes ffmpeg and CJK fonts; canvases, assets and the database live in the `plein-data` volume, so back that up.

By default it binds to localhost only and needs no login. To allow other devices, change the port and remove `PLEIN_AUTH` as described in the comments of `compose.yaml`; the first visit will ask you to create the owner account.

### Run from source

Requires Node ≥ 24, pnpm 12 and a local ffmpeg (for video posters, audio waveforms and export; burning subtitles needs a build with libass).

```bash
pnpm install && pnpm build && pnpm start   # http://localhost:8787
```

### Connect models

1. Open Settings → "Model platforms", enter your keys, save and enable. All four real platforms are off by default, and keys do not need environment variables.
2. Create a project and double-click empty space to insert the "short drama template", or start from a blank canvas.
3. Pick a model in a node's generator and run it.

<details>
<summary><b>Environment variables</b></summary>

| Variable                                   | Default                                   | Description                                                  |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------ |
| `PLEIN_HOST` / `PLEIN_PORT`                | `127.0.0.1` / `8787`                      | Listen address                                               |
| `PLEIN_DATA_DIR`                           | `./data`                                  | Data directory                                               |
| `PLEIN_AUTH`                               | `none` on localhost, `password` otherwise | With `password`, login via Better Auth, single owner account |
| `PLEIN_PUBLIC_URL`                         | Inferred from the request                 | Public URL behind a reverse proxy                            |
| `PLEIN_ALLOWED_HOSTS`                      | Empty                                     | Extra host names allowed in no-login mode, comma separated   |
| `PLEIN_MAX_UPLOAD_MB`                      | `2048`                                    | Per-file upload limit                                        |
| `PLEIN_MAX_JOBS`                           | `4`                                       | Max node jobs running at once                                |
| `PLEIN_FFMPEG_PATH` / `PLEIN_FFPROBE_PATH` | Looked up in `PATH`                       | ffmpeg / ffprobe executables                                 |
| `PLEIN_SUBTITLE_FONT`                      | Noto Sans CJK SC from fontconfig          | Subtitle font file, shared by export and editor preview      |
| `PLEIN_AGENT`                              | On in no-login mode                       | Set to `0` to disable the local CLI agent                    |

</details>

<details>
<summary><b>Where data is stored</b></summary>

- Docker: the `plein-data` volume
- From source: `data/` in the repo, override with `PLEIN_DATA_DIR`
- Desktop: macOS `~/Library/Application Support/plein/data`, Windows `%APPDATA%\plein\data`, Linux `~/.config/plein/data`

The layout is identical across all three and can be copied between them: `plein.db` (SQLite), `assets/` (content-addressed media), `exports/` and the platform key file (mode 600).

</details>

## Roadmap

- [x] Infinite canvas, four media types, projects and asset library
- [x] Four model platforms, generation nodes, candidates and history
- [x] Job queue, caching, group runs, restart recovery
- [x] Short drama template, storyboard sync, staged batch generation, sequence export to MP4
- [x] Basic image / video / audio processing
- [x] Agent Xiaoman, local Claude Code / Codex, MCP server
- [x] macOS desktop installer, signing and notarization pipeline
- [x] 6-shot sample on real platforms, UI tests in CI, auto-update
- [x] **0.1.0**: macOS (Apple silicon) release (2026-10-13)
- [ ] **0.2.0**: actual-input preview, reference strategies, impact analysis and partial rework, batches and job recovery, project package migration, cache and reconnect acceptance; agent change plans evolve alongside
- [ ] **Extension candidates**: storyboard groups and collages, region editing, frame-to-next-shot, camera / style presets, third-party plugins; static 3D composition validated separately
- [ ] **Later**: panoramas, 3D director stage, depth references, native segment re-shoot, smart editing

Next-phase scope is in the [0.2.0 roadmap](docs/plan/roadmap-0.2.0.md); first-release planning and acceptance are in the [0.1.0 roadmap](docs/plan/roadmap-0.1.0.md) and [acceptance record](docs/plan/acceptance-0.1.0.md) (all Chinese).

## Docs

The full index is in [docs/](docs/README.md) (Chinese). Most used:

- [Model platforms](docs/guide/providers.md): capabilities, configuration and limits per platform
- [Agent and MCP](docs/guide/agent.md): Xiaoman, local CLI, MCP server
- [Architecture](docs/dev/architecture.md): document model, rendering, workflows, backend

## Contributing

Dev setup, commands, code layout, branch and commit conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Tech stack

React 19 · Vite+ · Tailwind v4 · PixiJS v8 · Yjs · Hono · SQLite (Drizzle) · Better Auth · ffmpeg · Electron

## License

[GNU AGPL v3.0](LICENSE): commercial use, modification and distribution are allowed, but derivative works (including services provided over a network) must be open-sourced under the same license.
