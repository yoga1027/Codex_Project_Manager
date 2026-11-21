import * as vscode from 'vscode';
import { directoryKey, matchProject, Project, ProjectSnapshot, Thread } from './model';

interface SectionNode {
    kind: 'projects' | 'all' | 'unassigned';
}

export interface ProjectNode {
    kind: 'project';
    project: Project;
}

export interface ThreadNode {
    kind: 'thread';
    thread: Thread;
    section: string;
}

export type ChatNode = SectionNode | ProjectNode | ThreadNode;

export class ChatTree implements vscode.TreeDataProvider<ChatNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private snapshot: ProjectSnapshot = { projects: [], assignments: new Map(), threadPositions: new Map() };
    private visibleThreads: Thread[] = [];
    private readonly projectByThread = new Map<string, Project>();
    private readonly threadsByProject = new Map<string, Thread[]>();
    private activeProjects = new Set<string>();
    private unassigned: Thread[] = [];
    private renderedState?: string;

    update(snapshot: ProjectSnapshot, threads: Thread[], activeProjects: Set<string>): void {
        const { threadPositions } = snapshot;
        const ordered = [...threads].sort((a, b) =>
            (threadPositions.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (threadPositions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
        // Metadata-only updates do not change these rows or the user's scroll position.
        const state = JSON.stringify([
            snapshot.projects, [...snapshot.assignments], [...activeProjects],
            ordered.map(({ id, title, cwd, activityAt, archived }) => [id, title, cwd, activityAt, archived]),
        ]);
        if (state === this.renderedState) {
            return;
        }
        this.renderedState = state;
        this.snapshot = snapshot;
        this.visibleThreads = ordered;
        this.activeProjects = activeProjects;
        this.projectByThread.clear();
        this.threadsByProject.clear();
        this.unassigned = [];
        const projectsById = new Map(snapshot.projects.map(project => [project.id, project]));
        const projectsByDirectory = new Map<string, Project | undefined>();
        for (const thread of ordered) {
            const manuallyAssigned = snapshot.assignments.get(thread.id);
            let project = manuallyAssigned ? projectsById.get(manuallyAssigned) : undefined;
            if (!project) {
                if (!projectsByDirectory.has(thread.cwd)) {
                    const directory = directoryKey(thread.cwd);
                    projectsByDirectory.set(thread.cwd, directory ? matchProject(snapshot.projects, directory) : undefined);
                }
                project = projectsByDirectory.get(thread.cwd);
            }
            if (!project) {
                this.unassigned.push(thread);
                continue;
            }
            this.projectByThread.set(thread.id, project);
            const list = this.threadsByProject.get(project.id) ?? [];
            list.push(thread);
            this.threadsByProject.set(project.id, list);
        }
        this.changed.fire();
    }

    get threads(): readonly Thread[] {
        return this.visibleThreads;
    }

    projectOf(thread: Thread): Project | undefined {
        return this.projectByThread.get(thread.id);
    }

    threadsInSection(section: string): readonly Thread[] {
        if (section === 'all') {
            return this.visibleThreads;
        }
        if (section === 'unassigned') {
            return this.unassigned;
        }
        return this.threadsByProject.get(section) ?? [];
    }

    getChildren(node?: ChatNode): ChatNode[] {
        switch (node?.kind) {
            case undefined:
                return [{ kind: 'projects' }, { kind: 'all' }];
            case 'projects': {
                const projects = [...this.snapshot.projects].sort((a, b) =>
                    Number(this.activeProjects.has(b.id)) - Number(this.activeProjects.has(a.id)) ||
                    a.name.localeCompare(b.name) || a.roots[0].localeCompare(b.roots[0]));
                return [...projects.map((project): ProjectNode => ({ kind: 'project', project })), { kind: 'unassigned' }];
            }
            case 'all':
            case 'unassigned':
                return this.threadNodes(this.threadsInSection(node.kind), node.kind);
            case 'project':
                return this.threadNodes(this.threadsInSection(node.project.id), node.project.id);
            case 'thread':
                return [];
        }
    }

    getTreeItem(node: ChatNode): vscode.TreeItem {
        const state = vscode.TreeItemCollapsibleState;
        switch (node.kind) {
            case 'projects':
                return this.section('projects', '按项目', this.snapshot.projects.length, 'folder-library', state.Expanded);
            case 'all':
                return this.section('all', '全部对话', this.visibleThreads.length, 'history', state.Expanded);
            case 'unassigned':
                return this.section('unassigned', '未归类', this.unassigned.length, 'inbox',
                    this.unassigned.length ? state.Collapsed : state.None);
            case 'project': {
                const project = node.project;
                const count = this.threadsByProject.get(project.id)?.length ?? 0;
                const active = this.activeProjects.has(project.id);
                const item = this.section('project:' + project.id, project.name, count, 'folder',
                    count ? (active ? state.Expanded : state.Collapsed) : state.None);
                item.contextValue = 'codexProjectManager.project';
                item.tooltip = project.roots.join('\n');
                if (active) {
                    item.description = count + ' · 当前工作区';
                }
                return item;
            }
            case 'thread': {
                const thread = node.thread;
                const project = this.projectOf(thread);
                const item = new vscode.TreeItem(thread.title, state.None);
                item.id = `thread:${node.section}:${thread.id}`;
                item.contextValue = this.snapshot.assignments.has(thread.id)
                    ? 'codexProjectManager.thread.assigned' : 'codexProjectManager.thread';
                item.iconPath = new vscode.ThemeIcon(thread.archived ? 'archive' : 'comment');
                item.description = [
                    node.section === 'all' ? project?.name ?? '未归类' : '',
                    thread.archived ? '已归档' : '',
                ].filter(Boolean).join(' · ');
                item.tooltip = [
                    thread.title,
                    thread.cwd,
                    thread.activityAt ? new Date(thread.activityAt).toLocaleString() : '',
                ].filter(Boolean).join('\n');
                item.command = {
                    title: '打开原对话',
                    command: 'codexProjectManager.openThread',
                    arguments: [node],
                };
                return item;
            }
        }
    }

    dispose(): void {
        this.changed.dispose();
    }

    private section(id: string, label: string, count: number, icon: string, state: vscode.TreeItemCollapsibleState): vscode.TreeItem {
        const item = new vscode.TreeItem(label, state);
        item.id = id;
        item.description = String(count);
        item.iconPath = new vscode.ThemeIcon(icon);
        return item;
    }

    private threadNodes(threads: readonly Thread[], section: string): ThreadNode[] {
        return threads.map(thread => ({ kind: 'thread', thread, section }));
    }
}
