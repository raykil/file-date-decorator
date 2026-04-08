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
  enabled: boolean;
  showOnFolders: boolean;
}

function getConfig(): DecoratorConfig {
  const cfg = vscode.workspace.getConfiguration('fileDateDecorator');
  return {
    dateFormat: cfg.get<string>('dateFormat', 'MM/DD/YYYY'),
    dateSource: cfg.get<'modified' | 'created' | 'accessed'>('dateSource', 'modified'),
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
  isPlaceholder?: boolean;
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
    if (element.isPlaceholder) {
      const item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
      item.id = element.uri.toString(); // unique per placeholder row
      item.contextValue = 'placeholder';
      return item;
    }

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
        .filter((entry: import('fs').Dirent) => !ignoredNames.has(entry.name))
        .map((entry: import('fs').Dirent) => ({
          uri: vscode.Uri.file(path.join(dirPath, entry.name)),
          type: entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
        }))
        .sort((a: FileItem, b: FileItem) => {
          // Directories first, then alphabetical
          if (a.type !== b.type) {
            return a.type === vscode.FileType.Directory ? -1 : 1;
          }
          return path.basename(a.uri.fsPath).localeCompare(path.basename(b.uri.fsPath));
        });

      // Fill remaining space with invisible placeholder rows so right-clicking
      // anywhere in the blank area of the view triggers the context menu.
      // Each placeholder needs a unique URI (via fragment) so VS Code doesn't
      // deduplicate them.
      if (!element) {
        const root = this.workspaceRoot ?? '';
        for (let i = 0; i < 20; i++) {
          items.push({
            uri: vscode.Uri.file(root).with({ fragment: `placeholder-${i}` }),
            type: vscode.FileType.Unknown,
            isPlaceholder: true,
          });
        }
      }

      return items;
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.fileWatcher?.dispose();
  }
}

// ─── Drag and Drop Controller ─────────────────────────────────────

const TREE_MIME = 'application/vnd.code.tree.fileDateExplorer';

class FileDateDragAndDropController implements vscode.TreeDragAndDropController<FileItem> {
  readonly dragMimeTypes = [TREE_MIME, 'text/uri-list'];
  readonly dropMimeTypes = [TREE_MIME];

  private treeProvider: FileDateTreeProvider;

  constructor(treeProvider: FileDateTreeProvider) {
    this.treeProvider = treeProvider;
  }

  handleDrag(source: FileItem[], dataTransfer: vscode.DataTransfer): void {
    const files = source.filter(i => !i.isPlaceholder);
    dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(files));
    const uriList = files.map(i => i.uri.toString()).join('\r\n');
    dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uriList));
  }

  async handleDrop(target: FileItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const transferItem = dataTransfer.get(TREE_MIME);
    if (!transferItem) { return; }

    const sources: FileItem[] = transferItem.value;
    if (!sources.length) { return; }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    let targetDir: string;
    if (!target || target.isPlaceholder) {
      targetDir = root;
    } else if (target.type === vscode.FileType.Directory) {
      targetDir = target.uri.fsPath;
    } else {
      targetDir = path.dirname(target.uri.fsPath);
    }

    const moves = sources
      .map(source => ({ source, destUri: vscode.Uri.file(path.join(targetDir, path.basename(source.uri.fsPath))) }))
      .filter(({ source, destUri }) =>
        source.uri.fsPath !== destUri.fsPath &&
        !targetDir.startsWith(source.uri.fsPath + path.sep)
      );

    if (!moves.length) { return; }

    const names = moves.map(({ source }) => path.basename(source.uri.fsPath)).join(', ');
    const destName = path.basename(targetDir) || targetDir;
    const answer = await vscode.window.showWarningMessage(
      `Move ${names} to "${destName}"?`, { modal: true }, 'Move'
    );
    if (answer !== 'Move') { return; }

    for (const { source, destUri } of moves) {
      await vscode.workspace.fs.rename(source.uri, destUri, { overwrite: false });
    }

    this.treeProvider.refresh();
  }
}

// ─── Extension Activation ──────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Initialize context keys
  const initialConfig = getConfig();
  vscode.commands.executeCommand('setContext', 'fileDateDecorator.dateSource', initialConfig.dateSource);
  vscode.commands.executeCommand('setContext', 'fileDateDecorator.showOnFolders', initialConfig.showOnFolders);
  vscode.commands.executeCommand('setContext', 'fileDateDecorator.enabled', initialConfig.enabled);

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
    canSelectMany: true,
    dragAndDropController: new FileDateDragAndDropController(treeProvider),
  });
  context.subscriptions.push(treeView);

  // 3. Commands
  const toggleFolders = async () => {
    const cfg = vscode.workspace.getConfiguration('fileDateDecorator');
    const next = !cfg.get<boolean>('showOnFolders', false);
    await cfg.update('showOnFolders', next, vscode.ConfigurationTarget.Global);
    vscode.commands.executeCommand('setContext', 'fileDateDecorator.showOnFolders', next);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.toggleFolders.on',  toggleFolders),
    vscode.commands.registerCommand('fileDateDecorator.toggleFolders.off', toggleFolders),
  );

  const toggleEnabled = async () => {
    const cfg = vscode.workspace.getConfiguration('fileDateDecorator');
    const current = cfg.get<boolean>('enabled', true);
    const next = !current;
    await cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
    vscode.commands.executeCommand('setContext', 'fileDateDecorator.enabled', next);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.toggle.on',  toggleEnabled),
    vscode.commands.registerCommand('fileDateDecorator.toggle.off', toggleEnabled),
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

  // 4. Context menu commands
  const revealInOS = (item: FileItem) =>
    vscode.commands.executeCommand('revealFileInOS', item.uri);

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.revealInFinder',   revealInOS),
    vscode.commands.registerCommand('fileDateDecorator.revealInExplorer', revealInOS),
    vscode.commands.registerCommand('fileDateDecorator.revealInOS',       revealInOS),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.openInTerminal', (item: FileItem) => {
      const cwd = item.type === vscode.FileType.Directory
        ? item.uri.fsPath
        : path.dirname(item.uri.fsPath);
      const terminal = vscode.window.createTerminal({ cwd });
      terminal.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.copyPath', (item: FileItem | undefined, selected?: FileItem[]) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      // Placeholder or no item: copy selected items' paths, or workspace root
      if (!item || item.isPlaceholder) {
        const sel = treeView.selection.filter(s => !s.isPlaceholder);
        vscode.env.clipboard.writeText(sel.length ? sel.map(s => s.uri.fsPath).join('\n') : root);
        return;
      }
      const targets = selected && selected.length > 1 ? selected : [item];
      vscode.env.clipboard.writeText(targets.map(t => t.uri.fsPath).join('\n'));
    }),
    vscode.commands.registerCommand('fileDateDecorator.copyRelativePath', (item: FileItem | undefined, selected?: FileItem[]) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      // Placeholder or no item: copy selected items' relative paths, or '.'
      if (!item || item.isPlaceholder) {
        const sel = treeView.selection.filter(s => !s.isPlaceholder);
        vscode.env.clipboard.writeText(sel.length ? sel.map(s => path.relative(root, s.uri.fsPath)).join('\n') : '.');
        return;
      }
      const targets = selected && selected.length > 1 ? selected : [item];
      vscode.env.clipboard.writeText(targets.map(t => path.relative(root, t.uri.fsPath)).join('\n'));
    }),
  );

  const resolveTargetDir = (item: FileItem | undefined): string => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!item || item.isPlaceholder) { return root; }
    return item.type === vscode.FileType.Directory
      ? item.uri.fsPath
      : path.dirname(item.uri.fsPath);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.newFile', async (item?: FileItem) => {
      const dir = resolveTargetDir(item);
      const name = await vscode.window.showInputBox({ prompt: 'File name', placeHolder: 'filename.txt' });
      if (!name) { return; }
      const newUri = vscode.Uri.file(path.join(dir, name));
      await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
      treeProvider.refresh();
      await vscode.window.showTextDocument(newUri);
    }),
    vscode.commands.registerCommand('fileDateDecorator.newFolder', async (item?: FileItem) => {
      const dir = resolveTargetDir(item);
      const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
      if (!name) { return; }
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(dir, name)));
      treeProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.rename', async (item: FileItem | undefined) => {
      const resolved = item ?? treeView.selection[0];
      if (!resolved || resolved.isPlaceholder) { return; }
      const oldName = path.basename(resolved.uri.fsPath);
      const newName = await vscode.window.showInputBox({ prompt: 'New name', value: oldName });
      if (!newName || newName === oldName) { return; }
      const newUri = vscode.Uri.file(path.join(path.dirname(resolved.uri.fsPath), newName));
      await vscode.workspace.fs.rename(resolved.uri, newUri);
    }),
    vscode.commands.registerCommand('fileDateDecorator.delete', async (item: FileItem | undefined, selected?: FileItem[]) => {
      // When triggered via keybinding, item is undefined — fall back to tree selection
      const resolvedItem = item ?? treeView.selection[0];
      if (!resolvedItem) { return; }
      const targets = selected && selected.length > 1 ? selected : (treeView.selection.length > 1 ? [...treeView.selection] : [resolvedItem]);
      const names = targets.map(t => path.basename(t.uri.fsPath)).join(', ');
      const answer = await vscode.window.showWarningMessage(
        `Delete ${names}?`, { modal: true }, 'Delete'
      );
      if (answer !== 'Delete') { return; }
      for (const target of targets) {
        try {
          await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash: true });
        } catch {
          await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash: false });
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.findInFolder', (item: FileItem) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const relative = path.relative(root, item.uri.fsPath);
      vscode.commands.executeCommand('workbench.action.findInFiles', {
        filesToInclude: relative + '/**',
      });
    }),
  );

  // Compare commands
  let compareUri: vscode.Uri | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('fileDateDecorator.selectForCompare', (item: FileItem | undefined) => {
      const resolved = item ?? treeView.selection[0];
      if (!resolved || resolved.isPlaceholder) { return; }
      compareUri = resolved.uri;
      vscode.commands.executeCommand('setContext', 'fileDateDecorator.compareFile', resolved.uri.fsPath);
      vscode.window.setStatusBarMessage(`Selected '${path.basename(resolved.uri.fsPath)}' for compare`, 3000);
    }),
    vscode.commands.registerCommand('fileDateDecorator.compareWithSelected', (item: FileItem | undefined) => {
      if (!compareUri) { return; }
      const resolved = item ?? treeView.selection[0];
      if (!resolved || resolved.isPlaceholder) { return; }
      const title = `${path.basename(compareUri.fsPath)} ↔ ${path.basename(resolved.uri.fsPath)}`;
      vscode.commands.executeCommand('vscode.diff', compareUri, resolved.uri, title);
    }),
  );

  // 5. React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('fileDateDecorator')) {
        decorationProvider.refresh();
        treeProvider.refresh();
        const cfg = getConfig();
        if (e.affectsConfiguration('fileDateDecorator.dateSource')) {
          vscode.commands.executeCommand('setContext', 'fileDateDecorator.dateSource', cfg.dateSource);
        }
        if (e.affectsConfiguration('fileDateDecorator.showOnFolders')) {
          vscode.commands.executeCommand('setContext', 'fileDateDecorator.showOnFolders', cfg.showOnFolders);
        }
        if (e.affectsConfiguration('fileDateDecorator.enabled')) {
          vscode.commands.executeCommand('setContext', 'fileDateDecorator.enabled', cfg.enabled);
        }
      }
    })
  );
}

export function deactivate() {}
