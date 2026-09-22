<div align="center">

[简体中文](./README.md) | **English**

<img src="./public/icon/128.png" alt="Smart Favorites icon" width="88" />

# Smart Favorites / 智能收藏

Let Chrome save the current page into the right folder based on your existing bookmark structure.

[![Release](https://img.shields.io/github/v/release/sunyifeng11111/Smart-Favorites?style=flat-square&label=Release)](https://github.com/sunyifeng11111/Smart-Favorites/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/sunyifeng11111/Smart-Favorites/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/sunyifeng11111/Smart-Favorites/actions/workflows/ci.yml)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-2558C9?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)

[Download](https://github.com/sunyifeng11111/Smart-Favorites/releases/latest) · [Install](#installation) · [Privacy](#privacy) · [Development](#local-development)

<br />

<img src="./docs/images/smart-favorites-preview.png" alt="Smart Favorites automatically choosing a bookmark folder" width="680" />

</div>

Smart Favorites is a local-first Chrome extension. When opened, it captures a bounded set of signals from the current page and compares them with your existing bookmark folders through JEV. A trustworthy result is saved automatically, an uncertain result asks for confirmation, and every change can be moved or undone.

> [!IMPORTANT]
> Smart classification requires your own JEV API key. This project does not include a shared key, account system, product backend, or remote telemetry.

## Features

- Classifies pages into your existing bookmark folders without creating a new taxonomy.
- Shows complete folder paths, including deeply nested and same-named folders.
- Offers folder candidates and a complete picker when the result is uncertain.
- Lets you change the destination or undo an automatic save.
- Detects duplicate URLs before creating or moving a bookmark.
- Preserves failed classifications in a Pending folder for an in-place retry.
- Supports excluding entire folder subtrees from classification.
- Keeps recent records locally with delete, clear, and explicit export controls.
- Follows Chrome's light and dark appearance automatically.

## Installation

1. Open the latest [Release](https://github.com/sunyifeng11111/Smart-Favorites/releases/latest) and download `smart-favorites-<version>-chrome.zip`.
2. Extract the ZIP archive.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Select **Load unpacked** and choose the extracted directory that contains `manifest.json`.
6. Pin Smart Favorites to the browser toolbar.

> [!NOTE]
> Chrome cannot install a regular ZIP directly. Extract and reload the extension directory when installing a new version.

## Usage

### 1. Connect JEV

Open the settings page on first use:

1. Review and allow the data sharing required for smart classification.
2. Enter and save your JEV API key.
3. Select **Test connection**.

The key field is locked after saving. Select **Edit key** to replace it; a failed connection test opens the field again.

### 2. Save the current page

Select the extension icon on a regular HTTP or HTTPS page:

- A high-confidence result is saved automatically and shows its final folder.
- An uncertain result presents folder candidates for confirmation.
- A page with no suitable folder or a failed request is placed in the Pending folder.
- An existing matching URL is reported before any historical bookmark is moved.

## Privacy

Smart classification sends only the following data to `https://api.typesafe.ai/*`:

- The page title, URL, domain, description, visible H1, and up to 4,000 visible characters.
- Complete paths for eligible bookmark folders.
- Up to three example bookmark titles and domains per folder.

The extension does not capture form contents, input values, password fields, scripts, styles, navigation, or hidden content. `file:`, `chrome:`, `data:`, and other restricted pages are never sent to JEV. Smart Save is disabled in Incognito and does not write recent records there.

Your API key, settings, and recent records are stored in `chrome.storage.local`. This storage is not encrypted, so use the extension only on a trusted device. Uninstalling the extension or clearing its data removes the local information.

## Local development

You need Node.js 22, pnpm 10.17.1, and Chromium or Google Chrome.

```bash
git clone https://github.com/sunyifeng11111/Smart-Favorites.git
cd Smart-Favorites
pnpm install --frozen-lockfile
pnpm dev
```

WXT creates a development build in `.output/chrome-mv3/`. Load it through Chrome's **Load unpacked** action.

Create a production build and versioned ZIP:

```bash
pnpm build
pnpm package
```

## Quality checks

```bash
pnpm compile
pnpm lint
pnpm test
pnpm test:browser
pnpm package
```

The browser suite builds and loads the real Manifest V3 extension, then verifies settings persistence, page capture, automatic saving, destination changes, undo, duplicate warnings, and failure recovery.

## Project structure

```text
entrypoints/          Chrome Service Worker, popup, and settings page
src/application/      Smart Save application service and domain logic
src/adapters/         Chrome APIs, page capture, and the JEV client
src/evaluation/       Classification evaluation and release gates
src/release/          Manifest and release artifact verification
e2e/                  Playwright extension integration tests
evaluation/           Evaluation schema and synthetic examples
```

See [`CONTEXT.md`](CONTEXT.md) and [`docs/adr/0001-local-first-byok-jev-integration.md`](docs/adr/0001-local-first-byok-jev-integration.md) for the complete architecture constraints.
