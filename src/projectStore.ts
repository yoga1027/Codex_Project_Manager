import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compareThreadActivity, Project, ProjectSnapshot, Thread } from './model';

interface ThreadPosition {
    thread_id: string;
    position: number;
    activity_at: number;
}

export class ProjectStore {
    private readonly db: DatabaseSync;

    constructor(storagePath: string) {
        mkdirSync(storagePath, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path.join(storagePath, 'projects.sqlite'));
        this.db.exec(`
            PRAGMA busy_timeout = 2000;
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS roots (
                path TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id)
            );
            CREATE TABLE IF NOT EXISTS assignments (
                thread_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id)
            );
            CREATE TABLE IF NOT EXISTS thread_order (
                thread_id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                activity_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS thread_order_position ON thread_order (position);
        `);
    }

    snapshot(): ProjectSnapshot {
        this.db.exec('BEGIN');
        try {
            const projects = new Map<string, Project>();
            const rows = this.db.prepare(`
                SELECT p.id, p.name, r.path FROM projects p
                JOIN roots r ON r.project_id = p.id ORDER BY p.id, r.rowid
            `).all() as { id: string; name: string; path: string }[];
            for (const row of rows) {
                let project = projects.get(row.id);
                if (!project) {
                    project = { id: row.id, name: row.name, roots: [] };
                    projects.set(row.id, project);
                }
                project.roots.push(row.path);
            }
            const assignments = this.db.prepare('SELECT thread_id, project_id FROM assignments').all() as
                { thread_id: string; project_id: string }[];
            const order = this.threadOrder();
            this.db.exec('COMMIT');
            return {
                projects: [...projects.values()],
                assignments: new Map(assignments.map(row => [row.thread_id, row.project_id])),
                threadPositions: new Map(order.map(row => [row.thread_id, row.position])),
            };
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    addProject(root: string, name: string): string {
        return this.write(() => {
            const existing = this.ownerOf(root);
            if (existing) {
                return existing;
            }
            const id = randomUUID();
            this.db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
            this.db.prepare('INSERT INTO roots (path, project_id) VALUES (?, ?)').run(root, id);
            return id;
        });
    }

    addRoot(projectId: string, root: string): void {
        this.write(() => {
            const existing = this.ownerOf(root);
            if (existing === projectId) {
                return;
            }
            if (existing) {
                throw new Error('这个目录已登记到另一个项目。');
            }
            this.db.prepare('INSERT INTO roots (path, project_id) VALUES (?, ?)').run(root, projectId);
        });
    }

    assign(threadIds: readonly string[], projectId: string): void {
        this.write(() => {
            const statement = this.db.prepare(`
                INSERT INTO assignments (thread_id, project_id) VALUES (?, ?)
                ON CONFLICT (thread_id) DO UPDATE SET project_id = excluded.project_id
            `);
            for (const id of threadIds) {
                statement.run(id, projectId);
            }
        });
    }

    clearAssignments(threadIds: readonly string[]): void {
        this.write(() => {
            const statement = this.db.prepare('DELETE FROM assignments WHERE thread_id = ?');
            for (const id of threadIds) {
                statement.run(id);
            }
        });
    }

    observeThreads(threads: readonly Thread[]): void {
        if (!threads.length) {
            return;
        }
        this.write(() => {
            const order = this.threadOrder();
            const recorded = new Map(order.map(row => [row.thread_id, row.activity_at]));
            const promoted = threads.filter(thread =>
                thread.activityAt > (recorded.get(thread.id) ?? -1)).sort(compareThreadActivity);
            if (!promoted.length) {
                return;
            }
            const firstPosition = (order[0]?.position ?? 0) - promoted.length;
            const save = this.db.prepare(`
                INSERT INTO thread_order (thread_id, position, activity_at) VALUES (?, ?, ?)
                ON CONFLICT (thread_id) DO UPDATE SET position = excluded.position, activity_at = excluded.activity_at
            `);
            for (const [index, thread] of promoted.entries()) {
                save.run(thread.id, firstPosition + index, thread.activityAt);
            }
        });
    }

    moveThreads(ids: readonly string[], anchor: string, placement: 'before' | 'after'): boolean {
        return this.write(() => {
            const order = this.threadOrder();
            const selected = new Set(ids);
            const moving = order.filter(row => selected.has(row.thread_id));
            const remaining = order.filter(row => !selected.has(row.thread_id));
            const anchorIndex = remaining.findIndex(row => row.thread_id === anchor);
            if (!moving.length || anchorIndex === -1) {
                return false;
            }
            remaining.splice(anchorIndex + (placement === 'after' ? 1 : 0), 0, ...moving);
            if (remaining.every((row, index) => row === order[index])) {
                return false;
            }
            const save = this.db.prepare('UPDATE thread_order SET position = ? WHERE thread_id = ?');
            for (const [index, row] of remaining.entries()) {
                if (index !== row.position) {
                    save.run(index, row.thread_id);
                }
            }
            return true;
        });
    }

    dispose(): void {
        this.db.close();
    }

    private ownerOf(root: string): string | undefined {
        const row = this.db.prepare('SELECT project_id FROM roots WHERE path = ?').get(root);
        return row?.project_id as string | undefined;
    }

    private threadOrder(): ThreadPosition[] {
        return this.db.prepare('SELECT thread_id, position, activity_at FROM thread_order ORDER BY position').all() as
            unknown as ThreadPosition[];
    }

    private write<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = action();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
