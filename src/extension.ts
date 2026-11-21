import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChatNode, ChatTree, ProjectNode, ThreadNode } from './chatTree';
import { CodexHistory, isThreadId } from './history';
import { directoryKey, matchProject, Thread } from './model';
import { foldView } from './nativeFold';
import { ProjectStore } from './projectStore';
import { codexExecutable, codexExtensionId, openInEditor, openInSidebar, resumeInTerminal } from './threadActions';
import { threadDragController } from './threadDrag';

const embeddedViewId = 'codexProjectManager.chats';
const standaloneViewId = 'codexProjectManager.standaloneChats';
const refreshInterval = 20_000;

export function activate(context: vscode.ExtensionContext): void {
    const tree = new ChatTree();
    const options = { treeDataProvider: tree, canSelectMany: true, showCollapseAll: true };
    const embedded = vscode.window.createTreeView(embeddedViewId, {
        ...options, dragAndDropController: threadDragController(embeddedViewId, tree, moveThreads),
    });
    const standalone = vscode.window.createTreeView(standaloneViewId, {
        ...options, dragAndDropController: threadDragController(standaloneViewId, tree, moveThreads),
    });
    const views = [embedded, standalone];
    const history = new CodexHistory(context.extension.packageJSON.version as string);
    let store: ProjectStore | undefined;
    let threads: Thread[] = [];
    let useEmbeddedView = false;
    let didLoad = false;
    let inFlight: Promise<void> | undefined;
    let disposed = false;
    let lastError: string | undefined;

    function getStore(): ProjectStore {
        return store ??= new ProjectStore(context.globalStorageUri.fsPath);
    }

    function moveThreads(ids: string[], anchor: string, placement: 'before' | 'after'): void {
        try {
            if (getStore().moveThreads(ids, anchor, placement)) {
                render();
            }
        } catch (error) {
            void vscode.window.showErrorMessage(errorMessage(error));
        }
    }

    function render(): void {
        const db = getStore();
        let snapshot = db.snapshot();
        const activeProjects = new Set<string>();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme !== 'file') {
                continue;
            }
            const root = directoryKey(folder.uri.fsPath);
            if (!root) {
                continue;
            }
            const existing = matchProject(snapshot.projects, root);
            if (existing) {
                activeProjects.add(existing.id);
            } else {
                activeProjects.add(db.addProject(root, folder.name));
                snapshot = db.snapshot();
            }
        }
        const hideArchived = vscode.workspace.getConfiguration('codexProjectManager').get<boolean>('hideArchived', false);
        tree.update(snapshot, hideArchived ? threads.filter(thread => !thread.archived) : threads, activeProjects);
    }

    function setMessage(message?: string): void {
        for (const view of views) {
            view.message = message;
        }
    }

    function showEmptyState(): void {
        if (tree.threads.length) {
            setMessage();
        } else if (threads.length) {
            setMessage('没有未归档的对话。可在视图工具栏选择「显示已归档对话」。');
        } else {
            setMessage('当前 Codex 数据目录里没有可显示的会话。');
        }
    }

    function refresh(): Promise<void> {
        if (inFlight || disposed) {
            return inFlight ?? Promise.resolve();
        }
        inFlight = (async () => {
            try {
                if (!didLoad) {
                    render();
                    setMessage('正在读取本机 Codex 会话…');
                }
                const loaded = await history.list(codexExecutable());
                if (disposed) {
                    return;
                }
                getStore().observeThreads(loaded);
                threads = loaded;
                render();
                didLoad = true;
                lastError = undefined;
                showEmptyState();
            } catch (error) {
                history.dispose();
                if (!disposed) {
                    lastError = errorMessage(error);
                    const prefix = didLoad ? '刷新失败，正在显示上次读取的列表。' : '读取会话失败。';
                    setMessage(prefix + lastError);
                }
            }
        })().finally(() => {
            inFlight = undefined;
        });
        return inFlight;
    }

    async function placeViews(): Promise<void> {
        const codex = vscode.extensions.getExtension(codexExtensionId);
        const container = codex?.packageJSON.contributes?.viewsContainers?.secondarySidebar as { id: string }[] | undefined;
        useEmbeddedView = Boolean(container?.some(entry => entry.id === 'codexSecondaryViewContainer')) &&
            !vscode.workspace.getConfiguration('codexProjectManager').get<boolean>('separateSidebar', false);
        await Promise.all([
            vscode.commands.executeCommand('setContext', 'codexProjectManager.hasCodex', Boolean(codex)),
            vscode.commands.executeCommand('setContext', 'codexProjectManager.inCodex', useEmbeddedView),
            vscode.commands.executeCommand('setContext', 'codexProjectManager.separateView', !useEmbeddedView),
        ]);
    }

    async function pickFolder(title: string): Promise<string | undefined> {
        const selected = (await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: '选择目录',
            title,
        }))?.[0];
        if (selected?.scheme === 'file') {
            return directoryKey(selected.fsPath);
        }
        if (selected) {
            throw new Error('请选择本机目录。');
        }
        return undefined;
    }

    async function addProject(): Promise<string | undefined> {
        const root = await pickFolder('选择项目根目录');
        if (!root) {
            return undefined;
        }
        const db = getStore();
        const existing = db.snapshot().projects.find(project => project.roots.includes(root));
        if (existing) {
            return existing.id;
        }
        const name = await vscode.window.showInputBox({
            title: '项目名称',
            value: path.basename(root) || root,
            validateInput: value => value.trim() ? undefined : '请输入项目名称。',
        });
        return name?.trim() ? db.addProject(root, name.trim()) : undefined;
    }

    async function chooseProject(): Promise<string | undefined> {
        const { projects } = getStore().snapshot();
        const items: (vscode.QuickPickItem & { projectId?: string })[] = projects
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(project => ({ label: project.name, detail: project.roots.join(' · '), projectId: project.id }));
        items.push({ label: '$(add) 新建项目…' });
        const choice = await vscode.window.showQuickPick(items, { placeHolder: '选择对话所属项目', matchOnDetail: true });
        return choice ? choice.projectId ?? await addProject() : undefined;
    }

    function threadIds(node?: ChatNode, selection?: readonly ChatNode[]): string[] {
        const items = selection?.length ? selection : node ? [node] : [];
        return [...new Set(items.filter(isThreadNode).map(item => item.thread.id))];
    }

    function register<Args extends unknown[]>(name: string, action: (...args: Args) => unknown): void {
        context.subscriptions.push(vscode.commands.registerCommand('codexProjectManager.' + name, async (...args: Args) => {
            try {
                return await action(...args);
            } catch (error) {
                void vscode.window.showErrorMessage(errorMessage(error));
            }
        }));
    }

    async function openProjectView(): Promise<void> {
        await vscode.commands.executeCommand((useEmbeddedView ? embeddedViewId : standaloneViewId) + '.focus');
    }

    async function openProjectThread(thread: Thread, open = openInSidebar): Promise<void> {
        const folded = useEmbeddedView && await foldView(embedded);
        try {
            await open(thread);
        } catch (error) {
            if (folded) {
                await openProjectView();
            }
            throw error;
        }
    }

    register('open', openProjectView);
    register('refresh', async () => {
        await refresh();
        if (lastError) {
            void vscode.window.showErrorMessage(lastError);
        }
    });
    const setArchiveFilter = (hide: boolean) => vscode.workspace.getConfiguration('codexProjectManager')
        .update('hideArchived', hide, vscode.ConfigurationTarget.Global);
    register('hideArchived', () => setArchiveFilter(true));
    register('showArchived', () => setArchiveFilter(false));
    register('search', async () => {
        if (!didLoad || inFlight) {
            await refresh();
        }
        if (lastError && !didLoad) {
            throw new Error(lastError);
        }
        if (!tree.threads.length) {
            return;
        }
        const items = tree.threads.map(thread => ({
            label: thread.title,
            description: [tree.projectOf(thread)?.name ?? '未归类', thread.archived ? '已归档' : ''].filter(Boolean).join(' · '),
            detail: thread.cwd,
            thread,
        }));
        const choice = await vscode.window.showQuickPick(items, {
            placeHolder: '搜索所有本机对话',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (choice) {
            await openProjectThread(choice.thread);
        }
    });
    register('addProject', async () => {
        if (await addProject()) {
            render();
        }
    });
    register('addRoot', async (node?: ProjectNode) => {
        if (node?.kind !== 'project') {
            return;
        }
        const root = await pickFolder('给「' + node.project.name + '」添加关联目录');
        if (root) {
            getStore().addRoot(node.project.id, root);
            render();
        }
    });
    register('assign', async (node?: ChatNode, selection?: ChatNode[]) => {
        const ids = threadIds(node, selection);
        if (!ids.length) {
            return;
        }
        const project = await chooseProject();
        if (project) {
            getStore().assign(ids, project);
            render();
        }
    });
    register('clearAssignment', (node?: ChatNode, selection?: ChatNode[]) => {
        const ids = threadIds(node, selection);
        if (ids.length) {
            getStore().clearAssignments(ids);
            render();
        }
    });
    register('openThread', (node?: ChatNode) => isThreadNode(node) ? openProjectThread(node.thread) : undefined);
    register('openEditor', (node?: ChatNode) => isThreadNode(node) ? openProjectThread(node.thread, openInEditor) : undefined);
    register('resume', (node?: ChatNode) => isThreadNode(node) ? resumeInTerminal(node.thread) : undefined);

    const updatePlacement = () => void placeViews().catch(error => void vscode.window.showErrorMessage(errorMessage(error)));
    updatePlacement();
    context.subscriptions.push(tree, ...views,
        vscode.extensions.onDidChange(updatePlacement),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (views.some(view => view.visible)) {
                void refresh();
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('codexProjectManager.separateSidebar')) {
                updatePlacement();
            }
            if (event.affectsConfiguration('codexProjectManager.executable') && views.some(view => view.visible)) {
                if (inFlight) {
                    void inFlight.then(() => refresh());
                } else {
                    void refresh();
                }
            }
            if (event.affectsConfiguration('codexProjectManager.hideArchived') && didLoad) {
                try {
                    render();
                    if (!lastError) {
                        showEmptyState();
                    }
                } catch (error) {
                    void vscode.window.showErrorMessage(errorMessage(error));
                }
            }
        }),
        ...views.map(view => view.onDidChangeVisibility(event => {
            if (event.visible) {
                void refresh();
            }
        })),
    );
    const timer = setInterval(() => {
        if (views.some(view => view.visible)) {
            void refresh();
        }
    }, refreshInterval);
    context.subscriptions.push({ dispose() {
        disposed = true;
        clearInterval(timer);
        history.dispose();
        store?.dispose();
    } });
    if (views.some(view => view.visible)) {
        void refresh();
    }
}

function isThreadNode(node?: ChatNode): node is ThreadNode {
    return node?.kind === 'thread' && isThreadId(node.thread?.id);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
