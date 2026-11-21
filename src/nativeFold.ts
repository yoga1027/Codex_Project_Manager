import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const xdotool = '/usr/bin/xdotool';
const run = promisify(execFile);

async function focusedCodeWindow(): Promise<string | undefined> {
    if (!vscode.window.state.focused) {
        return undefined;
    }
    const { stdout: windowId } = await run(xdotool, ['getwindowfocus'], { timeout: 500 });
    const { stdout: pid } = await run(xdotool, ['getwindowpid', windowId.trim()], { timeout: 500 });
    return pid.trim() === process.env.VSCODE_PID ? windowId.trim() : undefined;
}

export async function foldView(view: vscode.TreeView<unknown>): Promise<boolean> {
    if (!view.visible || process.platform !== 'linux' || !process.env.DISPLAY ||
        process.env.XDG_SESSION_TYPE === 'wayland' || !process.env.VSCODE_PID) {
        return false;
    }
    try {
        const windowId = await focusedCodeWindow();
        if (!windowId) {
            return false;
        }
        await vscode.commands.executeCommand('codexProjectManager.chats.focus');
        if (await focusedCodeWindow() !== windowId) {
            return false;
        }
        // The tree toolbar is a single tab stop between the tree and its native header.
        await run(xdotool, ['key', '--clearmodifiers', 'Shift+Tab', 'Shift+Tab', 'Left'], { timeout: 500 });
        return !view.visible;
    } catch {
        // Missing X11 support leaves the native view available for manual folding.
        return false;
    }
}
