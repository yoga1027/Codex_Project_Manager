const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { directoryKey, matchProject } = require('../dist/model');
const { ProjectStore } = require('../dist/projectStore');
const { CodexHistory } = require('../dist/history');

test('longest directory match, path boundaries and linked worktrees', t => {
    const base = mkdtempSync(path.join(tmpdir(), 'codex-project-match-'));
    t.after(() => rmSync(base, { force: true, recursive: true }));
    const root = path.join(base, 'robot');
    const nested = path.join(root, 'recovery');
    const worktree = path.join(base, 'recovery-experiment');
    mkdirSync(nested, { recursive: true });
    mkdirSync(worktree);
    const projects = [
        { id: 'robot', name: 'Robot', roots: [directoryKey(root)] },
        { id: 'recovery', name: 'Recovery', roots: [directoryKey(nested), directoryKey(worktree)] },
    ];
    assert.equal(matchProject(projects, directoryKey(path.join(nested, 'old-notes'))).id, 'recovery');
    assert.equal(matchProject(projects, directoryKey(path.join(base, 'robot-v2'))), undefined);
    assert.equal(matchProject(projects, directoryKey(worktree)).id, 'recovery');
    if (process.platform !== 'win32') {
        const alias = path.join(base, 'alias');
        symlinkSync(nested, alias);
        assert.equal(matchProject(projects, directoryKey(alias)).id, 'recovery');
    }
});

test('manual moves persist and separate windows preserve each other’s assignments', t => {
    const base = mkdtempSync(path.join(tmpdir(), 'codex-project-store-'));
    const first = new ProjectStore(base);
    const second = new ProjectStore(base);
    t.after(() => {
        first.dispose();
        second.dispose();
        rmSync(base, { force: true, recursive: true });
    });
    const rootA = path.join(base, 'alpha');
    const rootB = path.join(base, 'beta');
    const a = first.addProject(rootA, 'Alpha');
    const b = second.addProject(rootB, 'Beta');
    assert.equal(second.addProject(rootA, 'Duplicate Alpha'), a);
    first.assign(['old', 'older'], a);
    second.assign(['new'], b);
    second.assign(['old'], b);
    assert.throws(() => first.addRoot(a, rootB), /已登记/);
    assert.throws(() => first.assign(['old', 'older'], 'missing'), /FOREIGN KEY/);
    assert.deepEqual(first.snapshot().assignments, new Map([['old', b], ['older', a], ['new', b]]));
    first.clearAssignments(['older']);
    assert.deepEqual(second.snapshot().assignments, new Map([['old', b], ['new', b]]));
    const reopened = new ProjectStore(base);
    try {
        assert.equal(reopened.snapshot().assignments.get('old'), b);
    } finally {
        reopened.dispose();
    }
});

test('manual order survives metadata updates and new activity alone moves threads to the top', t => {
    const base = mkdtempSync(path.join(tmpdir(), 'codex-project-order-'));
    const first = new ProjectStore(base);
    const second = new ProjectStore(base);
    t.after(() => {
        first.dispose();
        second.dispose();
        rmSync(base, { force: true, recursive: true });
    });
    const thread = (id, activityAt) => ({ id, title: id, cwd: base, activityAt, updatedAt: activityAt, archived: false });
    const oldest = thread('oldest', 10);
    const newer = thread('newer', 20);
    const newest = thread('newest', 30);
    const order = store => [...store.snapshot().threadPositions.keys()];

    first.observeThreads([oldest, newest, newer]);
    assert.deepEqual(order(first), ['newest', 'newer', 'oldest']);
    assert.equal(first.moveThreads(['oldest'], 'newest', 'before'), true);
    second.observeThreads([{ ...newer, updatedAt: 90 }, { ...oldest, archived: true }, newest]);
    assert.deepEqual(order(second), ['oldest', 'newest', 'newer']);

    const fresh = thread('fresh', 40);
    second.observeThreads([fresh, oldest, newer, newest]);
    assert.deepEqual(order(first), ['fresh', 'oldest', 'newest', 'newer']);
    first.moveThreads(['fresh', 'oldest'], 'newer', 'after');
    assert.equal(first.moveThreads(['fresh'], 'fresh', 'before'), false);
    assert.deepEqual(order(second), ['newest', 'newer', 'fresh', 'oldest']);

    second.observeThreads([{ ...oldest, activityAt: 50 }]);
    first.observeThreads([oldest, newer, newest, fresh]);
    const reopened = new ProjectStore(base);
    try {
        assert.deepEqual(order(reopened), ['oldest', 'newest', 'newer', 'fresh']);
    } finally {
        reopened.dispose();
    }
});

test('App Server pagination combines archived and active records by ID', { skip: process.platform === 'win32' }, async t => {
    const base = mkdtempSync(path.join(tmpdir(), 'codex-project-history-'));
    const executable = path.join(base, 'codex');
    const history = new CodexHistory('0.1.0');
    t.after(() => {
        history.dispose();
        rmSync(base, { force: true, recursive: true });
    });
    writeFileSync(executable, `#!${process.execPath}
const { createInterface } = require('node:readline');
const row = (id, updatedAt, recencyAt = updatedAt) => ({
    id, updatedAt, recencyAt, createdAt: Math.min(recencyAt, 10), preview: '  First\\nline  ', cwd: '/work'
});
let initialized = false;
createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialized') {
        initialized = true;
        return;
    }
    let result = {};
    if (method === 'thread/list') {
        if (!initialized || params.useStateDbOnly !== true || params.cwd != null || params.modelProviders.length ||
            params.sortKey !== 'created_at') {
            return console.log(JSON.stringify({ id, error: { code: 1 } }));
        }
        if (params.archived) {
            result = { data: [row('archive', 20), row('moved', 30)] };
        } else if (params.cursor === 'next') {
            result = { data: [row('older', 99, 10), { ...row('legacy', 120, 5), recencyAt: undefined }] };
        } else {
            result = { data: [row('moved', 40)], nextCursor: 'next' };
        }
    }
    console.log(JSON.stringify({ id, result }));
});
`, { mode: 0o700 });
    const threads = await history.list(executable);
    assert.deepEqual(threads.map(thread => [thread.id, thread.activityAt, thread.archived]), [
        ['moved', 40000, false], ['archive', 20000, true], ['older', 10000, false], ['legacy', 5000, false],
    ]);
    assert.equal(threads[0].title, 'First line');
});
