import * as vscode from 'vscode';
import { ChatNode, ChatTree, ThreadNode } from './chatTree';

interface DraggedThreads {
    section: string;
    ids: string[];
}

export function threadDragController(
    viewId: string,
    tree: ChatTree,
    move: (ids: string[], anchor: string, placement: 'before' | 'after') => void,
): vscode.TreeDragAndDropController<ChatNode> {
    const mime = 'application/vnd.code.tree.' + viewId.toLowerCase();
    return {
        dragMimeTypes: [mime],
        dropMimeTypes: [mime],
        handleDrag(source, dataTransfer, token) {
            if (token.isCancellationRequested) {
                return;
            }
            const threads = source.filter((node): node is ThreadNode => node.kind === 'thread');
            const section = threads[0]?.section;
            if (!section || threads.length !== source.length || threads.some(node => node.section !== section)) {
                return;
            }
            const payload: DraggedThreads = { section, ids: threads.map(node => node.thread.id) };
            dataTransfer.set(mime, new vscode.DataTransferItem(payload));
        },
        handleDrop(target, dataTransfer, token) {
            const payload = dataTransfer.get(mime)?.value as DraggedThreads | undefined;
            if (token.isCancellationRequested || !Array.isArray(payload?.ids) || !payload.ids.length) {
                return;
            }
            const section = target?.kind === 'thread' ? target.section
                : target?.kind === 'project' ? target.project.id : target?.kind;
            if (target && section !== payload.section) {
                return;
            }
            const visible = tree.threadsInSection(payload.section);
            const visibleIds = new Set(visible.map(thread => thread.id));
            const moving = new Set(payload.ids);
            if (payload.ids.some(id => !visibleIds.has(id))) {
                return;
            }
            if (target?.kind === 'thread') {
                const anchor = target.thread.id;
                if (visibleIds.has(anchor) && !moving.has(anchor)) {
                    const sourceIndex = visible.findIndex(thread => moving.has(thread.id));
                    const targetIndex = visible.findIndex(thread => thread.id === anchor);
                    move(payload.ids, anchor, sourceIndex < targetIndex ? 'after' : 'before');
                }
            } else {
                const last = visible.filter(thread => !moving.has(thread.id)).at(-1);
                if (last) {
                    move(payload.ids, last.id, 'after');
                }
            }
        },
    };
}
