import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createInterface, Interface } from 'node:readline';
import { compareThreadActivity, Thread } from './model';

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface Response {
    id?: number;
    result?: unknown;
    error?: { code?: number };
}

const sourceKinds = ['vscode', 'cli', 'appServer', 'exec', 'unknown'];

export function isThreadId(id: unknown): id is string {
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

export function findCodex(configured: string, extensionDirectory?: string): string {
    if (configured) {
        if (path.isAbsolute(configured) && isExecutable(configured)) {
            return configured;
        }
        throw new Error('请在 codexProjectManager.executable 中填写可执行的 Codex 绝对路径。');
    }
    const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const candidates = [
        ...(process.env.PATH ?? '').split(path.delimiter)
            .map(directory => directory.replace(/^"(.*)"$/, '$1'))
            .filter(path.isAbsolute)
            .map(directory => path.join(directory, executable)),
        path.join(homedir(), '.local', 'bin', executable),
        path.join(homedir(), '.codex', 'packages', 'standalone', 'current', 'bin', executable),
    ];
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
    if (extensionDirectory) {
        candidates.push(path.join(extensionDirectory, 'bin', platform + '-' + arch, executable));
    }
    const found = candidates.find(isExecutable);
    if (!found) {
        throw new Error('找不到 Codex。请安装 Codex CLI，或设置 codexProjectManager.executable。');
    }
    return found;
}

function isExecutable(file: string): boolean {
    try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
    } catch {
        return false;
    }
}

class AppServer {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly lines: Interface;
    private readonly pending = new Map<number, PendingRequest>();
    private nextId = 0;
    closed = false;

    constructor(readonly executable: string) {
        this.child = spawn(executable, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'], {
            cwd: homedir(),
            stdio: 'pipe',
            windowsHide: true,
        });
        this.lines = createInterface({ input: this.child.stdout });
        this.lines.on('line', line => this.receive(line));
        this.child.stderr.resume();
        this.child.once('error', error => this.dispose(new Error('无法启动 Codex App Server（' + (error as NodeJS.ErrnoException).code + '）。')));
        this.child.once('exit', code => this.dispose(new Error('Codex App Server 已退出（' + code + '）。')));
        this.child.stdin.on('error', () => this.dispose(new Error('Codex App Server 连接已断开。')));
    }

    async initialize(version: string): Promise<void> {
        await this.request('initialize', {
            clientInfo: { name: 'codex_project_manager', title: 'Codex Project Manager', version },
        });
        this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    }

    request(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new Error('Codex App Server 连接已关闭。'));
        }
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.dispose(new Error('Codex App Server 请求 ' + method + ' 超时。'));
            }, 12_000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }

    dispose(error = new Error('Codex App Server 连接已关闭。')): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.lines.close();
        this.child.stdin.destroy();
        this.child.kill();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private receive(line: string): void {
        let response: Response | null;
        try {
            response = JSON.parse(line) as Response | null;
        } catch {
            return;
        }
        if (typeof response?.id !== 'number') {
            return;
        }
        const request = this.pending.get(response.id);
        if (!request) {
            return;
        }
        this.pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.error) {
            request.reject(new Error('Codex App Server 拒绝了请求（' + response.error.code + '）。'));
        } else {
            request.resolve(response.result);
        }
    }
}

interface ThreadPage {
    data: unknown[];
    nextCursor?: string | null;
}

function timestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;
}

function toThread(value: unknown, archived: boolean): Thread | undefined {
    const row = value as Record<string, unknown> | null;
    if (!isThreadId(row?.id) || row.ephemeral === true) {
        return undefined;
    }
    const title = [row.name, row.title, row.preview]
        .filter((text): text is string => typeof text === 'string')
        .map(text => text.replace(/[\s\p{Cc}]+/gu, ' ').trim())
        .find(Boolean);
    const createdAt = timestamp(row.createdAt) ?? 0;
    return {
        id: row.id,
        title: title?.slice(0, 140) ?? '未命名对话',
        cwd: typeof row.cwd === 'string' ? row.cwd : '',
        updatedAt: timestamp(row.updatedAt) ?? createdAt,
        activityAt: Math.max(timestamp(row.recencyAt) ?? 0, createdAt),
        archived,
    };
}

async function listThreads(server: AppServer, archived: boolean): Promise<Thread[]> {
    const threads: Thread[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
        const page = await server.request('thread/list', {
            cursor, limit: 100, sortKey: 'created_at', archived, sourceKinds,
            modelProviders: [], useStateDbOnly: true,
        }) as ThreadPage | undefined;
        if (!Array.isArray(page?.data)) {
            throw new Error('Codex App Server 返回了无法识别的会话列表。');
        }
        for (const row of page.data) {
            const thread = toThread(row, archived);
            if (thread) {
                threads.push(thread);
            }
        }
        cursor = page.nextCursor ?? null;
        if (cursor !== null) {
            if (typeof cursor !== 'string' || cursors.has(cursor)) {
                throw new Error('Codex App Server 返回了无效的分页游标。');
            }
            cursors.add(cursor);
        }
    } while (cursor !== null);
    return threads;
}

export class CodexHistory {
    private server?: AppServer;

    constructor(private readonly version: string) {}

    async list(executable: string): Promise<Thread[]> {
        if (this.server?.executable !== executable || this.server.closed) {
            this.dispose();
            this.server = new AppServer(executable);
            try {
                await this.server.initialize(this.version);
            } catch (error) {
                this.dispose();
                throw error;
            }
        }
        const [active, archived] = await Promise.all([
            listThreads(this.server, false),
            listThreads(this.server, true),
        ]);
        const threads = new Map(archived.map(thread => [thread.id, thread]));
        for (const thread of active) {
            // A thread may move between the two lists while they are being read.
            const previous = threads.get(thread.id);
            if (!previous || thread.updatedAt >= previous.updatedAt) {
                threads.set(thread.id, thread);
            }
        }
        return [...threads.values()].sort(compareThreadActivity);
    }

    dispose(): void {
        this.server?.dispose();
        this.server = undefined;
    }
}
