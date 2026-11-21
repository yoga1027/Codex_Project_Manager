import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findCodex, isThreadId } from './history';
import { Thread } from './model';

export const codexExtensionId = 'openai.chatgpt';

export function codexExecutable(): string {
    const configured = vscode.workspace.getConfiguration('codexProjectManager').get<string>('executable', '').trim();
    return findCodex(configured, vscode.extensions.getExtension(codexExtensionId)?.extensionPath);
}

export async function openInSidebar(thread: Thread): Promise<void> {
    verifyId(thread);
    if (!vscode.extensions.getExtension(codexExtensionId)) {
        await resumeInTerminal(thread);
        return;
    }
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    // The route belongs to the installed Codex extension. Keep its format isolated here.
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.from({
        scheme: vscode.env.uriScheme,
        authority: codexExtensionId,
        path: '/local/' + thread.id,
    }));
}

export async function openInEditor(thread: Thread): Promise<void> {
    verifyId(thread);
    const uri = vscode.Uri.from({
        scheme: 'openai-codex',
        authority: 'route',
        path: '/local/' + thread.id,
    });
    await vscode.commands.executeCommand('vscode.openWith', uri, 'chatgpt.conversationEditor');
}

export async function resumeInTerminal(thread: Thread): Promise<void> {
    verifyId(thread);
    const executable = codexExecutable();
    const available = path.isAbsolute(thread.cwd) &&
        await stat(thread.cwd).then(info => info.isDirectory(), () => false);
    let cwd = thread.cwd;
    if (!available) {
        const folder = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: '在此目录继续原对话',
            title: '原工作目录不可用，请选择继续对话的目录',
        });
        if (!folder?.length || folder[0].scheme !== 'file') {
            return;
        }
        cwd = folder[0].fsPath;
    }
    vscode.window.createTerminal({
        name: 'Codex · ' + thread.title.slice(0, 45),
        shellPath: executable,
        shellArgs: ['resume', thread.id],
        cwd: vscode.Uri.file(cwd),
        isTransient: true,
    }).show();
}

function verifyId(thread: Thread): void {
    if (!isThreadId(thread.id)) {
        throw new Error('这条会话的 ID 无效。');
    }
}
