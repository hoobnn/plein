<div align="center">

<img src="apps/web/public/plein-icon.png" width="112" alt="Plein" />

# Plein

**Open-source AI infinite canvas where stories unfold.**<br/>
Start from a single idea, lay out the script, storyboard, shots and voiceover on the canvas, and finish your work together with an AI agent.

[![CI](https://github.com/hoobnn/plein/actions/workflows/ci.yml/badge.svg)](https://github.com/hoobnn/plein/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hoobnn/plein)](https://github.com/hoobnn/plein/releases)
![Platform](<https://img.shields.io/badge/platform-macOS%20(Apple%20silicon)%20%7C%20self--hosted-lightgrey>)

[简体中文](README.md) · **English**

[Website](https://plein.ikuyu.com/en/) · [Quick start](#quick-start) · [Features](#features) · [Docs](#docs) · [Contributing](CONTRIBUTING.md)

</div>

> [!NOTE]
> Plein is in a **testing and iteration phase**; the latest release for macOS (Apple silicon) is on [Releases](https://github.com/hoobnn/plein/releases/latest). The full pipeline has been verified end to end on real platforms (Alibaba Cloud Model Studio, Doubao Speech, MiniMax), but the data format and interactions may still change between versions, so export project packages regularly for important work.
>
> The app identifier changed in 0.2.0. The earlier 0.1.x builds have been withdrawn and may not auto-update to the new version: if you installed one, download the latest release manually and install over it. The data directory stays the same.
>
> The app UI and most docs are currently in Simplified Chinese only.

![Canvas: storyboard frames, videos and line-by-line voiceover for each shot](docs/images/canvas.png)

## Why Plein

- **The pipeline is on the canvas**: script, character cards, storyboard, shot images, videos, voiceover and the sequence are all wired-up nodes on the canvas. No black boxes. Change one step and you can see exactly what downstream needs a re-run.
- **Change one thing, redo only that**: after editing the script, a line or a character, "View impact" lists the affected shots with suggestions, redoes only what you tick and leaves everything else as is. Before generating you can see the exact prompt and reference images sent to the model.
- **Review before you spend**: inserting a template only builds the skeleton and never calls a model on its own. Review the storyboard and shot images first, then generate videos and voiceover in batches. Any shot can switch candidates, regenerate, or be replaced by hand.
- **Your data stays yours**: one Node process, one SQLite file, one asset folder. API keys live only on the local server, never in the canvas or the browser.
- **Built for Chinese model platforms**: Volcengine Ark, Doubao Speech, Alibaba Cloud Model Studio (Bailian) and MiniMax work out of the box; node parameters adapt to the selected model.
- **Let AI operate the canvas**: the built-in agent "Xiaoman" reads the canvas, creates nodes, batch-generates the storyboard and processes media. You can also hand the work to a locally signed-in Claude Code / Codex, or let Cursor and Claude Desktop drive the canvas over MCP.

## Features

### Canvas

- Infinite canvas rendered with PixiJS (WebGL) on a Yjs document model: undo / redo, survives refresh and restart, syncs across tabs
- Drag, paste or import whole folders of images, videos, audio and Markdown; custom video and audio players
- Minimap, layers panel, storyboard view, auto-arrange, multi-select toolbar, ⌘K command palette, light / dark themes

### Generation nodes

- Text, chat (LLM), image, video, voiceover and music nodes; forms are generated from the selected model, 9 aspect ratios
- You choose the video mode: text-to-video, first frame, first + last frame or multimodal reference, with candidate count and synced audio
- Region edit: box-select or paint the area to change and only that area is repainted, the rest stays as is (Bailian Wanx image edit with a native mask)
- Continue a shot: take the last frame (or any second) of a video and branch the next shot from it, keeping model and aspect ratio and remembering the parent video; if the parent is regenerated you get a one-click refresh
- Storyboard groups: number the images in a frame in order, reorder them, lay them out in one click and stitch them into one collage labelled with its real pixel size; grid splits become a group automatically and can jump back to the source (local stitching, no model call)
- Shot and style bar: pick a camera move (with speed), shot size, angle, lighting and style; they become one or two visible, editable lines at the end of the prompt, obvious conflicts are flagged, and a style can be saved as a style card. These are prompt presets only, results vary by model
- `@` references character / scene / prop / style cards in prompts, with disambiguation for duplicate names; `/` at line start applies presets such as three-view turnaround, expression grid, multi-angle and four-panel story
- You choose the model: Settings sets a default model per capability, new nodes start with it and each node can pick another; enabling a new platform never switches models behind your back
- Prompt enhancement and translation; every run keeps candidates and history, and downstream only uses the version you adopt
- AI image refinement: native upscaling / outpainting with Bailian and transparent subject layers with Seedream; video nodes accept image, video and audio references according to the selected model's capabilities

### Short drama pipeline

| Storyboard                                                                          | Sequence editor                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ![Storyboard: shot size, visuals, dialogue and prompts](docs/images/storyboard.png) | ![Sequence editor: ordering, in / out points, dialogue and subtitle preview](docs/images/sequence.png) |

- One-click short drama template: idea → script → character and scene extraction → setting cards → storyboard → shots → sequence
- Edit the storyboard as a table; after it is expanded into shot nodes, further table edits show up as a diff, and you can sync only the fields you have not changed by hand
- Shot images, videos and voiceover generate in stages and in batches; retry just the ones that failed
- Sequence editor: ordering, in / out points, a five-track timeline (picture, dialogue, SFX, music, subtitles), per-clip transitions and speed, music ducking, loudness normalization, subtitle styles, in-browser preview on the export timeline
- Server-side ffmpeg export to MP4 (9:16 / 16:9, 1080p / 720p) with burned-in Chinese subtitles, optionally aligned by speech recognition
- Export editing projects (OTIO / FCPXML / SRT) together with their assets
- Edit subtitle text, timing and visibility sentence by sentence; recognition covers all dialogue, and preview and exports share the saved track. Stable dialogue IDs, speaker bindings and SFX nodes carry through storyboard edits
- Build a separate animatic from storyboard images and existing dialogue, then export a local draft. Guided next steps, candidate-specific creative reviews, batch checklists, adjacent-shot continuity and rendered-file delivery records are covered in [From animatic to delivery](docs/guide/creation-workflow.md) (Chinese)

### Media processing

- Image: crop, rotate, mirror, grid split
- Video: trim, speed change, extract frames to the library, split audio and video
- Audio: trim, manual split, pitch-preserving speed change

Every result is a new asset with its source recorded; originals are never touched.

### Projects and asset library

- One project is one film, and it can hold several canvases
- Review asset updates by canvas and field, or pin a card to its current version; local automatic backups, storage usage, restore copies and unused-asset recycling are described in [Local data maintenance](docs/guide/data-maintenance.md) (Chinese)
- The asset library holds characters, scenes, props, styles and effects, reusable across canvases and projects. Characters have full-body / half-body / turnaround / emotion-grid slots, tags and a voice; canvas cards and the library sync both ways
- The Voices tab in the asset library manages your own voices: upload a voice sample to clone it on MiniMax or Doubao, or register a voice that already exists on the platform; cloned voices can be picked directly on character cards and voiceover nodes
- Project packages (.plein): export a whole project from the home page (canvases, the assets they use, library items, adopted results and run history, optionally all past candidates) and import it on another machine or data directory; imports check the format version and file hashes first and list missing models, voices and plugins. Platform keys and sign-in data are never included

### Runs and jobs

- Run a single node, run up to here (with upstream), run downstream, or run a whole group; unchanged nodes hit the cache instead of spending again
- Jobs are queued in SQLite, keep running after the page closes, and resume polling remote tasks after a server restart
- The job panel shows progress, automatic retries and failure reasons; nodes whose parameters or upstream changed are marked "needs re-run"
- Actual-input preview: before generating, see the model, the prompt with `@` expanded, and which reference images are sent or dropped by the model's limit
- View impact: after a change, list the affected nodes with causes and suggestions (redo / review / keep), redo only the ticked ones in dependency order, and reuse matching candidates
- Failure recovery: when a submission's outcome is unknown or polling / download fails, Plein never resubmits on its own (to avoid double billing); the job panel offers re-fetch, attaching a platform task ID, or resubmitting after you confirm it was not accepted

### Agent "Xiaoman"

- Built-in agent: drives the canvas with the default chat model (it must support tool calling), no extra software needed
- Local CLI: calls Claude Code or Codex already signed in on this machine, using your own account and quota
- MCP server: Claude Code, Claude Desktop, Cursor and others can connect to your local Plein
- Asks before spending money or deleting; supports plan mode; a whole turn of changes can be undone at once
- Change plans: the fields to edit, nodes to redo and estimated calls are listed first, then approved by scope (text only / candidate images / everything); if the canvas changed before approval, the plan must be checked again

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
3. Check "Default models" at the top of "Model platforms" (enabling a platform fills in its first model). New nodes start with the default model; you can pick another in a node's generator, then run it.

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
