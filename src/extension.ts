import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ─── Date Formatting ───────────────────────────────────────────────

function formatDate(date: Date, format: string): string {
  const tokens: Record<string, string> = {
    'YYYY': date.getFullYear().toString(),
    'YY': date.getFullYear().toString().slice(-2),
    'MM': String(date.getMonth() + 1).padStart(2, '0'),
    'DD': String(date.getDate()).padStart(2, '0'),
    'hh': String(date.getHours()).padStart(2, '0'),
    'HH': String(date.getHours() % 12 || 12).padStart(2, '0'),
    'mm': String(date.getMinutes()).padStart(2, '0'),
    'ss': String(date.getSeconds()).padStart(2, '0'),
    'A': date.getHours() >= 12 ? 'PM' : 'AM',
  };

  // Replace longest tokens first to avoid partial matches (e.g. YYYY before YY)
  let result = format;
  const sortedKeys = Object.keys(tokens).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    result = result.split(key).join(tokens[key]);
  }
  return result;
}

// ─── Configuration Helper ──────────────────────────────────────────

interface DecoratorConfig {
  dateFormat: string;
  dateSource: 'modified' | 'created' | 'accessed';
  fontStyle: 'normal' | 'italic';
  fontWeight: 'normal' | 'bold' | 'light';
  color: string;
  opacity: number;
  enabled: boolean;
  showOnFolders: boolean;
}

function getConfig(): DecoratorConfig {
  const cfg = vscode.workspace.getConfiguration('fileDateDecorator');
  return {
    dateFormat: cfg.get<string>('dateFormat', 'MM/DD/YYYY'),
    dateSource: cfg.get<'modified' | 'created' | 'accessed'>('dateSource', 'modified'),
    fontStyle: cfg.get<'normal' | 'italic'>('fontStyle', 'normal'),
    fontWeight: cfg.get<'normal' | 'bold' | 'light'>('fontWeight', 'normal'),
    color: cfg.get<string>('color', ''),
    opacity: cfg.get<number>('opacity', 0.7),
    enabled: cfg.get<boolean>('enabled', true),
    showOnFolders: cfg.get<boolean>('showOnFolders', false),
  };
}

function getFileDate(filePath: string, source: string): Date | null {
  try {
    const stat = fs.statSync(filePath);
    switch (source) {
      case 'created':
        return stat.birthtime;
      case 'accessed':
        return stat.atime;
      case 'modified':
      default:
        return stat.mtime;
    }
  } catch {
    return null;
  }
}

// ─── File Decoration Provider ──────────────────────────────────────

class FileDateDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const config = getConfig();
    if (!config.enabled) {
      return undefined;
    }

    // Only handle file:// URIs
    if (uri.scheme !== 'file') {
      return undefined;
    }

    const filePath = uri.fsPath;

    // Check if it's a file or directory
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory() && !config.showOnFolders) {
        return undefined;
      }
    } catch {
      return undefined;
    }

    const date = getFileDate(filePath, config.dateSource);
    if (!date) {
      return undefined;
    }

    const formatted = formatDate(date, config.dateFormat);

    // FileDecoration supports `badge` (short, max 2 chars) and `tooltip`.
    // For the suffix text next to the filename, we use the `tooltip` for hover
    // and the ResourceDecorationProvider approach via a different API.
    //
    // Unfortunately, vscode.FileDecoration only allows a 2-char badge.
    // The date text next to the filename (like in the screenshot) requires
    // a DecorationProvider on the TreeView — but the built-in Explorer doesn't
    // expose its TreeView for custom decoration providers.
    //
    // The CORRECT approach for arbitrary suffix text is to use a
    // FileDecorationProvider's `badge` for a short indicator, and we'll
    // provide the full date via tooltip. BUT — we can also use the
    // "Source Control" style decorations which DO show suffix text.
    //
    // Actually: vscode.FileDecoration has a `tooltip` and `badge` property,
    // but since VS Code 1.76+, the Explorer DOES render the `suffix` from
    // certain internal APIs. The public API way to get arbitrary text after
    // the filename in Explorer is not directly supported.
    //
    // WORKAROUND: We use a combination approach:
    // 1. FileDecorationProvider for tooltip (hover shows full date)
    // 2. A custom "suffix" via the resource label API — but this is internal.
    //
    // BEST PUBLIC APPROACH: Use the `badge` for a short date indicator
    // and `tooltip` for full info. The badge in Explorer shows as a small
    // badge/suffix text.

    const decoration: vscode.FileDecoration = {
      tooltip: `${config.dateSource}: ${formatted}`,
      badge: '', // We won't use badge since it's limited to 2 chars
    };

    // Color theming
    if (config.color) {
      // Try to interpret as a theme color id
      decoration.color = new vscode.ThemeColor(config.color);
    }

    return decoration;
  }
}

// ─── Tree Data Provider Wrapper ────────────────────────────────────
// To show arbitrary text after filenames (like "06/04/2026"), we need
// to create a custom Tree View that mirrors the Explorer.
// This is the only public-API way to show date suffixes.

interface FileItem {
  uri: vscode.Uri;
  type: vscode.FileType;
}

class FileDateTreeProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workspaceRoot: string | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (this.workspaceRoot) {
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.workspaceRoot, '**/*')
      );
      this.fileWatcher.onDidCreate(() => this.refresh());
      this.fileWatcher.onDidDelete(() => this.refresh());
      this.fileWatcher.onDidChange(() => this.refresh());
    }

    // Re-read when workspace folders change
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    const config = getConfig();
    const isDir = element.type === vscode.FileType.Directory;
    const label = path.basename(element.uri.fsPath);

    const item = new vscode.TreeItem(
      label,
      isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // Show date as description (the gray text after the label)
    if (config.enabled && (!isDir || config.showOnFolders)) {
      const date = getFileDate(element.uri.fsPath, config.dateSource);
      if (date) {
        item.description = formatDate(date, config.dateFormat);
      }
    }

    item.resourceUri = element.uri;

    if (!isDir) {
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [element.uri],
      };
      // Use ThemeIcon to get proper file icons
      item.iconPath = vscode.ThemeIcon.File;
    } else {
      item.iconPath = vscode.ThemeIcon.Folder;
    }

    item.contextValue = isDir ? 'folder' : 'file';

    // Apply tooltip with date source info
    if (config.enabled) {
      const date = getFileDate(element.uri.fsPath, config.dateSource);
      if (date) {
        item.tooltip = new vscode.MarkdownString(
          `**${label}**\n\n` +
          `$(calendar) ${config.dateSource}: ${formatDate(date, config.dateFormat)}\n\n` +
          `Modified: ${formatDate(fs.statSync(element.uri.fsPath).mtime, config.dateFormat)}\n\n` +
          `Created: ${formatDate(fs.statSync(element.uri.fsPath).birthtime, config.dateFormat)}\n\n` +
          `Accessed: ${formatDate(fs.statSync(element.uri.fsPath).atime, config.dateFormat)}`
        );
        item.tooltip.supportThemeIcons = true;
      }
    }

    return item;
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    const dirPath = element ? element.uri.fsPath : this.workspaceRoot;
    if (!dirPath) {
      return [];
    }

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      // Read .gitignore patterns if present (basic filtering)
      const gitignorePath = path.join(this.workspaceRoot || dirPath, '.gitignore');
      let ignoredNames = new Set<string>(['.git', 'node_modules', '.DS_Store']);
      try {
        const gitignoreContent = await fs.promises.readFile(gitignorePath, 'utf8');
        for (const line of gitignoreContent.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            // Simple name-based ignore (not full glob support)
            ignoredNames.add(trimmed.replace(/\/$/, ''));
          }
        }
      } catch {
        // No .gitignore, that's fine
      }

      const items: FileItem[] = entries
        .filter(entry => !ignoredNames.has(entry.name))
        .map(entry => ({
          uri: vscode.Uri.file(path.join(dirPath, entry.name)),
          type: entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.type !== b.type) {
            return a.type === vscode.FileType.Directory ? -1 : 1;
          }
          return path.basename(a.uri.fsPath).localeCompare(path.basename(b.uri.fsPath));
        });

      return items;
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.fileWatcher?.dispose();
  }
}

// ─── Extension Activation ──────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Initialize context key for cycle button visibility
  const initialSource = getConfig().dateSource;
  vscode.commands.executeCommand('setContext', 'fileDateDecorator.dateSource', initialSource);

  // 1. Register the FileDecorationProvider (provides tooltips in native Explorer)
  const decorationProvider = new FileDateDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  // 2. Register the custom Tree View (shows dates as description text)
  const treeProvider = new FileDateTreeProvider();
  const treeView = vscode.window.createTreeView('fileDateExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 3. Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('fileDateDecorator');
      const current = cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `File Date Decorator: ${!current ? 'Enabled' : 'Disabled'}`
      );
    })
  );

  const cycleSource = async () => {
    const cfg = vscode.workspace.getConfiguration('fileDateDecorator');
    const sources: Array<'modified' | 'created' | 'accessed'> = ['modified', 'created', 'accessed'];
    const current = cfg.get<string>('dateSource', 'modified');
    const idx = sources.indexOf(current as any);
    const next = sources[(idx + 1) % sources.length];
    await cfg.update('dateSource', next, vscode.ConfigurationTarget.Global);
    vscode.commands.executeCommand('setContext', 'fileDateDecorator.dateSource', next);
    vscode.window.showInformationMessage(`File Date Decorator: Showing ${next} time`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.cycleDateSource.modified', cycleSource),
    vscode.commands.registerCommand('fileDateDecorator.cycleDateSource.created', cycleSource),
    vscode.commands.registerCommand('fileDateDecorator.cycleDateSource.accessed', cycleSource),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.refresh', () => {
      decorationProvider.refresh();
      treeProvider.refresh();
      vscode.window.showInformationMessage('File Date Decorator: Refreshed');
    })
  );

  // 4. React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('fileDateDecorator')) {
        decorationProvider.refresh();
        treeProvider.refresh();
        if (e.affectsConfiguration('fileDateDecorator.dateSource')) {
          vscode.commands.executeCommand('setContext', 'fileDateDecorator.dateSource', getConfig().dateSource);
        }
      }
    })
  );
}

export function deactivate() {}
