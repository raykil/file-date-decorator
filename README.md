# File Date Decorator

A VS Code extension that displays file dates (creation, modified, accessed) next to filenames in a custom Explorer panel.

## Features

- **Date display** — Shows dates as suffix text next to each filename in a dedicated "File Dates" panel within the Explorer sidebar.
- **Configurable format** — Use tokens like `MM/DD/YYYY`, `DD/MM/YY`, `DD/MM hh:mm:ss`, `YYYY-MM-DD hh:mm`, etc.
- **Multiple date sources** — Switch between last modified (default, matches `ls -l`), creation date, or last accessed time.
- **Tooltip details** — Hover over any file to see all three timestamps at once.
- **Quick commands** — Toggle on/off, cycle date sources, or refresh via the Command Palette.

## Format Tokens

| Token  | Output       | Example |
|--------|-------------|---------|
| `YYYY` | 4-digit year | 2026   |
| `YY`   | 2-digit year | 26     |
| `MM`   | Month (01-12)| 04     |
| `DD`   | Day (01-31)  | 06     |
| `hh`   | Hours (24h)  | 15     |
| `HH`   | Hours (12h)  | 03     |
| `mm`   | Minutes      | 25     |
| `ss`   | Seconds      | 52     |
| `A`    | AM/PM        | PM     |

### Example formats

- `MM/DD/YYYY` → 04/06/2026
- `DD/MM/YY` → 06/04/26
- `DD/MM hh:mm:ss` → 06/04 15:25:52
- `YYYY-MM-DD` → 2026-04-06

## Settings

Open **Settings → Extensions → File Date Decorator** or search for `fileDateDecorator` in settings.

| Setting | Default | Description |
|---------|---------|-------------|
| `dateFormat` | `MM/DD/YYYY` | Date/time format string |
| `dateSource` | `modified` | `modified`, `created`, or `accessed` |
| `enabled` | `true` | Toggle the decorator |
| `showOnFolders` | `false` | Show dates on folders too |

## Commands

- **File Date Decorator: Toggle On/Off** — Enable/disable display
- **File Date Decorator: Cycle Date Source** — Rotate through modified → created → accessed
- **File Date Decorator: Refresh Dates** — Force-refresh all dates

## Installation (Development)

```bash
cd file-date-decorator
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host.

## Packaging

```bash
npm install -g @vscode/vsce
vsce package
```

This produces a `.vsix` file you can install via `code --install-extension file-date-decorator-1.0.0.vsix`.
