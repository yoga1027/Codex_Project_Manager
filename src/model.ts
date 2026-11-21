import { realpathSync } from 'node:fs';
import * as path from 'node:path';

export interface Thread {
    id: string;
    title: string;
    cwd: string;
    updatedAt: number;
    activityAt: number;
    archived: boolean;
}

export interface Project {
    id: string;
    name: string;
    roots: string[];
}

export interface ProjectSnapshot {
    projects: Project[];
    assignments: Map<string, string>;
    threadPositions: Map<string, number>;
}

export function compareThreadActivity(a: Thread, b: Thread): number {
    return b.activityAt - a.activityAt || b.id.localeCompare(a.id);
}

export function directoryKey(directory: string): string | undefined {
    if (!path.isAbsolute(directory)) {
        return undefined;
    }
    let absolute = path.resolve(directory);
    try {
        absolute = realpathSync.native(absolute);
    } catch {
        // Historical folders may have been renamed or removed.
    }
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function matchProject(projects: readonly Project[], directory: string): Project | undefined {
    let best: Project | undefined;
    let bestLength = -1;
    for (const project of projects) {
        for (const root of project.roots) {
            const relative = path.relative(root, directory);
            const isInside = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
            if (isInside && root.length > bestLength) {
                best = project;
                bestLength = root.length;
            }
        }
    }
    return best;
}
