<div align="center">
 <img src="public/logo.svg" alt="CloudCLI UI" width="64" height="64">
 <h1>Cloud CLI (aka Claude Code UI)</h1>
 <p>A desktop and mobile UI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, and <a href="https://developers.openai.com/codex">Codex</a>.<br>Use it locally or remotely to view your active projects and sessions from everywhere.</p>
</div>

> **This repository is a fork of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui).**
> It is published to npm as [`@yalehwang/cloudcli`](https://www.npmjs.com/package/@yalehwang/cloudcli).
> Every install command below pulls this fork — the upstream CloudCLI package under the `@cloudcli-ai`
> scope is maintained elsewhere and is **not** built from this repository.

<p align="center">
 <a href="https://github.com/yaleh/claudecodeui/releases">Releases</a> · <a href="https://github.com/yaleh/claudecodeui/issues">Bug Reports</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

<div align="right"><i><b>English</b> · <a href="./docs/README.ru.md">Русский</a> · <a href="./docs/README.de.md">Deutsch</a> · <a href="./docs/README.ko.md">한국어</a> · <a href="./docs/README.zh-CN.md">简体中文</a> · <a href="./docs/README.zh-TW.md">繁體中文</a> · <a href="./docs/README.ja.md">日本語</a> · <a href="./docs/README.tr.md">Türkçe</a></i><br><sub>The translations follow the upstream README and do not cover the fork-specific sections below.</sub></div>

---

## What this fork adds

The fork diverged from upstream at `v1.37.3` (commit `fd424f3f`). Since then it has taken about 2,200 non-merge commits and roughly 930 changed files (about +208k / −2k lines). Around 350 of those commits are product code; the rest is the task ledger, tests, experiments and documentation that drive the fork's development loop. Upstream's 20 commits made after the split — for example multi-select session deletion, theme-follows-system, a Czech translation and the GPT-6 model entries — are **not** merged.

**Resident sessions.** A session can be kept running as a long-lived Claude process instead of starting one per message. Turn the *Keep this session running (resident)* switch on under the model card of a new chat, or convert an existing session from its menu; the trade-offs are shown in a tooltip and do not block sending. Around it:
- a status bar with per-session marks, a configurable idle ceiling, and a sidebar view that separates turns in flight from held-open residents;
- input sent to a busy resident session goes to the process (and can be withdrawn until it starts) instead of a local queue, and the process has a stable `SendMessage` address;
- the three human-facing permission prompts are intercepted, held-work reasons are reconciled from the Stop hook and the stream, and a bypass launch is refused when your user settings enable Remote Control;
- turns nobody typed (unattended turns of a resident process) are recorded as runs, and the Shell tab is closed for resident sessions.

**Session-host layer.** Session lifecycle now runs through a host layer with lease-driven policies (`GET /api/session-hosts`), 1:N session binding, restart-residue sweeping, resident caps read from config, and an out-of-memory fact a host can read. Each Claude session can be capped inside its own systemd scope, and the session watcher picks its mechanism per root and backs off when polling.

**Voice input.** Server-stored per-user voice settings, a pluggable recogniser registry (an inline-only multimodal adapter is the second recogniser), silence trimming, capture failures isolated from transcription, and health checks that read the user's effective config.

**Chat and composer.** The composer footer decides its layout from the box's own width; the send key is scoped to the device's input capabilities; the running turn is drawn inline on narrow screens; the live session name is shown everywhere, taking Claude's `ai-title` into account (also shown in `/cost`); the permission mode is stored with each send instead of in the browser.

**Sidebar and projects.** A draggable sidebar width, forked sessions grouped by lineage with branch marks, and a per-project session-name filter.

**Launch profiles and models.** A Profiles settings tab and a composer profile select; the model list explains every environment row kind, including unset ones.

**Performance.** The `dist` bundle and SPA entry are served gzip/brotli-compressed.

**Debug agent.** A gated scenario-driven debug agent for resident host states, turn origins and the run seam. When it is off it is structurally absent.

**Engineering.** Playwright end-to-end specs, strict-TypeScript-checked `scripts/` with tests, and a test runner with liveness watchdogs. Work is tracked as task and goal records under `tasks/`, `goals/` and `adr/`.

**Releases.** GitHub Releases plus an npm package, built by the workflows in `.github/workflows/` (see [Releasing](#releasing)).

## Screenshots

<div align="center">

<table>
<tr>
<td align="center">
<h3>Desktop View</h3>
<img src="public/screenshots/desktop-main.png" alt="Desktop Interface" width="400">
<br>
<em>Main interface showing project overview and chat</em>
</td>
<td align="center">
<h3>Mobile Experience</h3>
<img src="public/screenshots/mobile-chat.png" alt="Mobile Interface" width="250">
<br>
<em>Responsive mobile design with touch navigation</em>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<h3>CLI Selection</h3>
<img src="public/screenshots/cli-selection.png" alt="CLI Selection" width="400">
<br>
<em>Select between Claude Code, Cursor CLI and Codex</em>
</td>
</tr>
</table>

</div>

## Features

- **Responsive Design** - Works seamlessly across desktop, tablet, and mobile so you can also use Agents from mobile
- **Interactive Chat Interface** - Built-in chat interface for seamless communication with the Agents
- **Resident Sessions** - Keep a Claude session running across turns, with a status bar and idle ceiling
- **Integrated Shell Terminal** - Direct access to the Agents CLI through built-in shell functionality
- **File Explorer** - Interactive file tree with syntax highlighting and live editing
- **Git Explorer** - View, stage and commit your changes. You can also switch branches
- **Voice Input** - Dictate prompts through a configurable speech recogniser
- **Browser Use** - Open browser sessions for web research, testing, and agent-driven browser tasks
- **Session Management** - Resume conversations, manage multiple sessions, group forks by lineage, and filter by name per project
- **Launch Profiles** - Save and pick launch configurations from the composer
- **Plugin System** - Extend the app with custom plugins — add new tabs, backend services, and integrations. [Build your own →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)
- **TaskMaster AI Integration** *(Optional)* - Advanced project management with AI-powered task planning, PRD parsing, and workflow automation
- **Model Compatibility** - Works with Claude and GPT model families (the full list of supported models is available at runtime via `GET /api/providers/:provider/models`)

## Quick Start

### npm

Try it instantly with **npx** (requires **Node.js** v22+):

```
npx @yalehwang/cloudcli
```

Or install **globally** for regular use:

```
npm install -g @yalehwang/cloudcli
cloudcli
```

Open `http://localhost:3001` — all your existing sessions are discovered automatically.

For general configuration, PM2 and remote-server setup, the [upstream documentation](https://cloudcli.ai/docs) is a useful reference; where it differs from this README, this README wins for the fork.

### Docker Sandboxes (Experimental)

Run agents in isolated sandboxes with hypervisor-level isolation. Starts Claude Code by default. Requires the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/get-started/).

```
npx @yalehwang/cloudcli@latest sandbox ~/my-project
```

Supports Claude Code and Codex. See the [sandbox docs](docker/) for setup and advanced options.

> **Note:** the sandbox images (`docker.io/cloudcliai/sandbox:*`) are upstream's and install upstream’s published CloudCLI package, so what runs *inside* the sandbox is upstream's build, not this fork. This fork does not publish its own images yet.

### Desktop App

CloudCLI Desktop is an optional native app that keeps the UI available from your tray. It ships from this repository's [GitHub Releases](https://github.com/yaleh/claudecodeui/releases) together with checksums. **Only a Windows installer is published; there is no macOS or Linux build.**

Choose **Local CloudCLI** in the desktop app to use your running local server or have it start one for you. The first time, it downloads a matching local-server runtime from this repository's `cloudcli-local-server-<version>` pre-release.

## Releasing

Releases are cut from the `develop` branch by two manually triggered workflows in `.github/workflows/`:

1. **Release** — bumps the version with release-it, updates `CHANGELOG.md`, tags `vX.Y.Z`, creates the GitHub Release, and publishes `@yalehwang/cloudcli` to npm (needs the `RELEASE_PAT` and `NPM_TOKEN` repository secrets).
2. **Desktop Release** — run with the new tag to build the Windows installer and the local-server runtime and attach them to that release.

`docker.yml` and the branch-build workflows are inherited from upstream; `docker.yml` targets upstream's Docker Hub account and should not be run from this fork.

---

## Security & Tools Configuration

**🔒 Important Notice**: All Claude Code tools are **disabled by default**. This prevents potentially harmful operations from running automatically.

### Enabling Tools

To use Claude Code's full functionality, you'll need to manually enable tools:

1. **Open Tools Settings** - Click the gear icon in the sidebar
2. **Enable Selectively** - Turn on only the tools you need
3. **Apply Settings** - Your preferences are saved locally

<div align="center">

![Tools Settings Modal](public/screenshots/tools-modal.png)
*Tools Settings interface - enable only what you need*

</div>

**Recommended approach**: Start with basic tools enabled and add more as needed. You can always adjust these settings later.

### Resident sessions and permissions

A resident session runs one long-lived Claude process that can hold work between your messages. It runs with the same operating-system user and trust boundary as the server, and the permission prompts it would otherwise show are intercepted by the UI. Only enable it for projects and machines you trust.

---

## Plugins

The plugin system lets you add custom tabs with their own frontend UI and optional Node.js backend. Install plugins from git repos directly in **Settings > Plugins**, or build your own. The plugins below are third-party projects from the wider ecosystem.

### Available Plugins

| Plugin | Description |
|---|---|
| **[Project Stats](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** | Shows file counts, lines of code, file-type breakdown, largest files, and recently modified files for your current project |
| **[Web Terminal](https://github.com/cloudcli-ai/cloudcli-plugin-terminal)** | Full xterm.js terminal with multi-tab support |
| **[Claude Watch](https://github.com/satsuki19980613/cloudcli-claude-watch)** | Watches long-running Claude Code sessions for hangs and exposes process controls |
| **[CloudCLI Scheduler](https://github.com/grostim/cloudcli-cron)** | Create workspace-scoped scheduled prompts and execute them through a local CLI such as Codex or Claude Code |
| **[PRISM CloudCLI](https://github.com/jakeefr/cloudcli-plugin-prism)** | Session intelligence for Claude Code inside CloudCLI, including token burn visibility |
| **[Sessions](https://github.com/strykereye2/cloudcli-plugin-session-manager)** | View, manage, and kill active Claude Code sessions |
| **[Token Cost Calculator](https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator)** | Calculate API costs from model prices and token usage, with preset model pricing support |
| **[Task Queue](https://github.com/TadMSTR/cloudcli-plugin-task-queue)** | Task queue dashboard to view, filter, and launch agent tasks |
| **[GitHub Issues Board](https://github.com/szmidtpiotr/claude-github-issue)** | Kanban board for GitHub Issues with bidirectional TaskMaster sync and /github-task CLI skill auto-install |

### Build Your Own

**[Plugin Starter Template →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** — fork this repo to create your own plugin. It includes a working example with frontend rendering, live context updates, and RPC communication to a backend server.

---

## FAQ

<details>
<summary>How is this different from Claude Code Remote Control?</summary>

Claude Code Remote Control lets you send messages to a session already running in your local terminal. Your machine has to stay on, your terminal has to stay open, and sessions time out after roughly 10 minutes without a network connection.

This UI extends Claude Code rather than sitting alongside it — your MCP servers, permissions, settings, and sessions are the exact same ones Claude Code uses natively. Nothing is duplicated or managed separately.

In practice:

- **All your sessions, not just one** — every session from your `~/.claude` folder is discovered automatically. Remote Control only exposes the single active session to the Claude mobile app.
- **Your settings are your settings** — MCP servers, tool permissions, and project config you change here are written directly to your Claude Code config and take effect immediately, and vice versa.
- **Works with more agents** — Claude Code, Cursor CLI and Codex, not just Claude Code.
- **Full UI, not just a chat window** — file explorer, Git integration, MCP management, and a shell terminal are all built in.

</details>

<details>
<summary>Do I need to pay for an AI subscription separately?</summary>

Yes. This project provides the environment, not the AI. You bring your own Claude, Cursor, or Codex subscription.

</details>

<details>
<summary>Can I use it on my phone?</summary>

Yes. Run the server on your machine and open `[yourip]:port` in any browser on your network.

</details>

<details>
<summary>Will changes I make in the UI affect my local Claude Code setup?</summary>

Yes. The UI reads from and writes to the same `~/.claude` config that Claude Code uses natively. MCP servers you add via the UI show up in Claude Code immediately and vice versa.

</details>

---

## Community & Support

- **[GitHub Issues](https://github.com/yaleh/claudecodeui/issues)** — bug reports and feature requests
- **[Contributing Guide](CONTRIBUTING.md)** — how to contribute to the project

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text, including additional terms under Section 7.

This project is open source and free to use, modify, and distribute under the AGPL-3.0-or-later license. If you modify this software and run it as a network service, you must make your modified source code available to users of that service.

## Acknowledgments

### Built With
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** - Anthropic's official CLI
- **[Cursor CLI](https://docs.cursor.com/en/cli/overview)** - Cursor's official CLI
- **[Codex](https://developers.openai.com/codex)** - OpenAI Codex
- **[React](https://react.dev/)** - User interface library
- **[Vite](https://vitejs.dev/)** - Fast build tool and dev server
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[CodeMirror](https://codemirror.net/)** - Advanced code editor
- **[TaskMaster AI](https://github.com/eyaltoledano/claude-task-master)** *(Optional)* - AI-powered project management and task planning

---

<div align="center">
 <strong>Made with care for the Claude Code, Cursor and Codex community.</strong>
</div>
