const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const harnessSource = shared.slice(0, shared.indexOf('async function run()'))
    .replace('doAquaticFeed, doSailing,', `getPageApp, getPagePinia, getPageStore, pageBridgeDiagnostic, validateClientEnvironment,
        detectedGameBuild, refreshGameUI, currentViewState, emitOfficialStoryCue, officialStoryBusy,
        ensureStoryIdle, mutate, statusLine, doAquaticFeed, doSailing,`)
    .replace('vm.runInNewContext(source, context,', 'options.prepareContext?.(context); vm.runInNewContext(source, context,');
const { harness, fixture, sourcePath } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture, sourcePath };`)(require, __dirname);

function pinia(story = { cue() {}, active: false, queue: [] }, game = { state: fixture(), refresh() {} }) {
    return { _s: new Map([['story', story], ['game', game]]) };
}
function mounted(store, via = 'global') {
    const context = { config: { globalProperties: {} }, provides: {} };
    if (via === 'global') context.config.globalProperties.$pinia = store;
    else if (via === 'symbol') context.provides[Symbol('pinia')] = store;
    else if (via === 'string') context.provides.pinia = store;
    return { __vue_app__: { _context: context } };
}
function setup({ pageContext = false, localRoot, pageRoot } = {}) {
    const timers = new Map(), issued = []; let timerId = 0, now = 0;
    const stores = pinia();
    let local = localRoot === undefined ? mounted(stores) : localRoot;
    let page = pageRoot === undefined ? mounted(stores) : pageRoot;
    const x = harness(fixture(), [], { prepareContext(context) {
        context.document.querySelector = selector => selector === '#app' ? local : null;
        context.window.document = context.document;
        if (pageContext) context.unsafeWindow = { document: { querySelector: selector => selector === '#app' ? page : null } };
        context.performance = { now: () => now };
        context.setTimeout = (fn, delay) => {
            const timer = { id: ++timerId, fn, delay }; timers.set(timer.id, timer); issued.push(timer); return timer.id;
        };
        context.clearTimeout = id => timers.delete(id);
    } });
    for (const name of ['farming', 'gathering', 'mining', 'crafting', 'aquatic', 'livestock', 'commissions', 'feed', 'sailing', 'refining', 'achievements']) {
        x.h.CONFIG[name].enabled = false;
    }
    x.h.CONFIG.rosterScanOnStart = false; x.h.CONFIG.taskItems.enabled = false;
    x.stores = stores; x.timers = timers; x.issued = issued;
    x.setLocalRoot = value => { local = value; };
    x.setPageRoot = value => { page = value; };
    x.advance = milliseconds => { now += milliseconds; };
    x.lastDelay = () => issued.at(-1)?.delay;
    x.setResponder(request => {
        assert.equal(request.method, 'GET', 'a quiet lifecycle pass only reads authoritative state');
        return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
    });
    return x;
}
function craftPlan(x) {
    x.h.CONFIG.crafting.enabled = true;
    const node = x.h.runtime.state.crafting_stations[0];
    x.h.setOverride('rlt-node-job:crafting:mill', 'flour');
    x.h.setOverride('rlt-craft-lock-times:mill', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    return { id: 'mill', node, job: node.recipes[0], runId: x.h.craftRun('mill').id,
        pipeline: { steps: x.h.configuredCraftSteps('mill'), stepIndex: 0, done: [0] } };
}

test('userscript metadata requests the page context without removing either supported town domain', () => {
    const source = fs.readFileSync(sourcePath, 'utf8'), header = source.slice(0, source.indexOf('// ==/UserScript=='));
    assert.match(header, /@grant\s+unsafeWindow\b/); assert.match(header, /@sandbox\s+raw\b/);
    assert.doesNotMatch(header, /@grant\s+none\b/);
    assert.match(header, /@match\s+https:\/\/chiyuki\.diving-fish\.com\/red-leaf-town\/\*/);
    assert.match(header, /@match\s+https:\/\/game\.diving-fish\.com\/red-leaf-town\/\*/);
});

test('the original globalProperties Pinia bridge still validates and exposes the original stores', () => {
    const x = setup();
    assert.equal(x.h.getPagePinia(), x.stores); assert.equal(x.h.getPageStore('story'), x.stores._s.get('story'));
    assert.equal(x.h.getPageStore('game'), x.stores._s.get('game')); assert.equal(x.h.getPageStore('absent'), null);
    assert.doesNotThrow(() => x.h.validateClientEnvironment());
});

test('unsafeWindow supplies the real page stores instead of inaccessible or stale sandbox stores', async () => {
    const local = pinia(), page = pinia(), x = setup({ pageContext: true, localRoot: mounted(local), pageRoot: mounted(page) });
    let called = 0; page._s.get('story').cue = function (cue) { assert.equal(this, page._s.get('story')); assert.equal(cue, 'action:plant'); called++; };
    local._s.get('story').cue = () => { throw new Error('sandbox story must not be used'); };
    assert.equal(x.h.getPagePinia(), page); await x.h.emitOfficialStoryCue('action:plant'); assert.equal(called, 1);
    x.h.setRunning(false); assert.equal(x.h.currentViewState(), page._s.get('game').state);
});

test('the normal document remains usable when unsafeWindow has no document', () => {
    const x = setup({ pageContext: true }); delete x.context.unsafeWindow.document;
    assert.equal(x.h.getPagePinia(), x.stores); assert.doesNotThrow(() => x.h.validateClientEnvironment());
});

test('Pinia in symbol or string provides entries is discovered without a globalProperties bridge', () => {
    for (const via of ['symbol', 'string']) {
        const stores = pinia(), root = mounted(stores, via);
        root.__vue_app__._context.provides.unrelated = { name: 'other injection' };
        const x = setup({ pageContext: true, pageRoot: root, localRoot: null });
        assert.equal(x.h.getPagePinia(), stores); assert.doesNotThrow(() => x.h.validateClientEnvironment());
    }
});

test('a valid direct Pinia store takes priority over other provided containers', () => {
    const direct = pinia(), other = pinia(), root = mounted(direct);
    root.__vue_app__._context.provides[Symbol('other')] = other;
    const x = setup({ localRoot: root }); assert.equal(x.h.getPagePinia(), direct);
});

test('missing root, an unmounted root and an app without Pinia report loading with a one-second retry', () => {
    for (const root of [null, {}, mounted(null, 'none')]) {
        const x = setup({ localRoot: root });
        assert.equal(x.h.getPagePinia(), null);
        assert.throws(() => x.h.validateClientEnvironment(), error => error.code === 'client_loading' && error.retryAfter === 1000);
    }
});

test('loading tick uses the precise waiting status and one-second retry without sending a state or write request', async () => {
    const x = setup({ localRoot: null }); await x.h.tick();
    assert.equal(x.h.statusLine.textContent, '等待游戏页面加载 · 自动重连中');
    assert.equal(x.calls.length, 0); assert.equal(x.lastDelay(), 1000);
    assert.equal(x.h.activity().running, true); assert.equal(x.h.activity().busy, false);
});

test('fifteen seconds of missing Pinia becomes a bridge failure and a successful connection resets the loading grace', async () => {
    const x = setup({ localRoot: null }); await x.h.tick(); assert.equal(x.lastDelay(), 1000);
    x.advance(14999); await x.h.tick();
    assert.equal(x.h.statusLine.textContent, '等待游戏页面加载 · 自动重连中'); assert.equal(x.lastDelay(), 1000);
    x.advance(1); await x.h.tick();
    assert.equal(x.h.statusLine.textContent, '安全暂停 · 剧情连接失败，自动重连中'); assert.equal(x.lastDelay(), 5000);
    assert.throws(() => x.h.validateClientEnvironment(), error => error.code === 'invalid_story_bridge' && error.retryAfter === 5000);
    assert.equal(x.calls.length, 0);
    x.setLocalRoot(mounted(x.stores)); await x.h.tick(); assert.equal(x.calls.length, 1);
    x.advance(100000); x.setLocalRoot(null); await x.h.tick();
    assert.equal(x.h.statusLine.textContent, '等待游戏页面加载 · 自动重连中'); assert.equal(x.lastDelay(), 1000);
    assert.equal(x.calls.length, 1);
});

test('bridge diagnostics describe the actual page app, Pinia, game and story connectivity', () => {
    const stores = pinia(), root = mounted(stores, 'symbol');
    const x = setup({ pageContext: true, pageRoot: root, localRoot: null });
    assert.equal(x.h.getPageApp(), root.__vue_app__); assert.equal(x.h.getPagePinia(), stores);
    const healthy = x.h.pageBridgeDiagnostic();
    assert.match(healthy, /页面已挂载/); assert.match(healthy, /Pinia可访问/);
    assert.match(healthy, /游戏状态已连接/); assert.match(healthy, /cue 类型为 function/);
    stores._s.get('story').cue = null; stores._s.delete('game');
    const partial = x.h.pageBridgeDiagnostic();
    assert.match(partial, /游戏状态未连接/); assert.match(partial, /cue 类型为 object/);
    assert.throws(() => x.h.validateClientEnvironment(), error => error.code === 'invalid_story_bridge' && error.message.includes(partial));
    x.setPageRoot(null);
    assert.match(x.h.pageBridgeDiagnostic(), /页面未挂载，Pinia不可访问/);
    assert.equal(x.calls.length, 0);
});

test('a delayed mount recovers on the next pass without restarting the helper or retaining a missing-store cache', async () => {
    const x = setup({ pageContext: true, pageRoot: null, localRoot: null }); await x.h.tick();
    assert.equal(x.calls.length, 0); assert.equal(x.lastDelay(), 1000);
    x.setPageRoot(mounted(x.stores, 'symbol')); await x.h.tick();
    assert.deepEqual(x.calls.map(request => request.method), ['GET']);
    assert.match(x.h.statusLine.textContent, /^运行中/); assert.equal(x.h.activity().running, true);
});

test('a mounted Pinia without a callable story cue reports the bridge failure rather than an update', async () => {
    for (const story of [undefined, { cue: null, queue: [] }]) {
        const stores = pinia(); stores._s.set('story', story);
        const x = setup({ localRoot: mounted(stores) });
        assert.throws(() => x.h.validateClientEnvironment(), error => error.code === 'invalid_story_bridge');
        await x.h.tick(); assert.equal(x.calls.length, 0);
        assert.equal(x.h.statusLine.textContent, '安全暂停 · 剧情连接失败，自动重连中');
        assert.equal(x.lastDelay(), 5000); assert.equal(x.h.activity().running, true);
    }
});

test('restoring the story store reconnects after the initial bridge failure', async () => {
    const stores = pinia(); stores._s.delete('story'); const x = setup({ localRoot: mounted(stores) });
    await x.h.tick(); assert.equal(x.lastDelay(), 5000); assert.equal(x.calls.length, 0);
    stores._s.set('story', { cue() {}, active: false, queue: [] }); await x.h.tick();
    assert.equal(x.calls.length, 1); assert.match(x.h.statusLine.textContent, /^运行中/);
});

test('environment error transitions stay visible while duplicate logs clear after a successful reconnect', async () => {
    const x = setup({ localRoot: null });
    const count = part => x.h.logBox.children.filter(line => line.textContent.includes(part)).length;
    await x.h.tick(); await x.h.tick();
    assert.equal(count('等待游戏官网加载完成'), 1, 'repeated loading failures share one log entry');
    x.advance(15000); await x.h.tick(); await x.h.tick();
    assert.equal(count('无法连接游戏官网剧情系统'), 1, 'the loading-to-failure transition remains visible');
    x.stores._s.get('story').cue = null; x.setLocalRoot(mounted(x.stores));
    await x.h.tick(); await x.h.tick();
    assert.equal(count('无法连接游戏官网剧情系统'), 2, 'the same error code with a changed connectivity diagnosis is a new event');
    assert.equal(count('cue 类型为 object'), 1);
    x.stores._s.get('story').cue = () => {}; await x.h.tick();
    assert.match(x.h.statusLine.textContent, /^运行中/);
    x.stores._s.get('story').cue = null; await x.h.tick(); await x.h.tick();
    assert.equal(count('cue 类型为 object'), 2, 'a repeat failure after recovery is logged again exactly once');
    assert.equal(x.calls.length, 1);
});

test('a genuine town build change retains the update warning and prevents new requests', async () => {
    const x = setup(); x.context.document.scripts = [{ src: 'https://game.diving-fish.com/red-leaf-town/assets/index-first.js' }];
    assert.equal(x.h.detectedGameBuild(), 'index-first.js'); x.h.validateClientEnvironment();
    x.context.document.scripts[0].src = 'https://game.diving-fish.com/red-leaf-town/assets/index-second.js';
    assert.throws(() => x.h.validateClientEnvironment(), error => error.code === 'unknown_build');
    await x.h.tick(); assert.equal(x.calls.length, 0);
    assert.equal(x.h.statusLine.textContent, '安全暂停 · 游戏已更新，请刷新页面');
    assert.equal(x.lastDelay(), x.h.CONFIG.maxPollInterval);
});

test('both town domains identify the same unchanged build without treating the domain itself as an update', () => {
    const x = setup(); x.context.document.scripts = [{ src: 'https://chiyuki.diving-fish.com/red-leaf-town/assets/index-same.js?cache=1' }];
    x.h.validateClientEnvironment(); x.context.document.scripts[0].src = 'https://game.diving-fish.com/red-leaf-town/assets/index-same.js';
    assert.equal(x.h.detectedGameBuild(), 'index-same.js'); assert.doesNotThrow(() => x.h.validateClientEnvironment());
});

test('a page-side cue preserves its receiver and its resulting active story is detected', async () => {
    const story = { active: false, queue: [], async cue(value) {
        assert.equal(this, story); assert.equal(value, 'action:harvest'); this.active = true;
    } };
    const x = setup({ pageContext: true, pageRoot: mounted(pinia(story), 'symbol'), localRoot: null });
    assert.equal(await x.h.emitOfficialStoryCue('action:harvest'), true); assert.equal(x.h.officialStoryBusy(), true);
});

test('new bridge story activity, queued scenes and reward synchronization still block writes', () => {
    const story = { cue() {}, active: true, queue: [] };
    const x = setup({ pageContext: true, pageRoot: mounted(pinia(story), 'symbol'), localRoot: null });
    assert.throws(() => x.h.ensureStoryIdle(), error => error.code === 'story_active');
    story.active = false; story.queue.push({ id: 'next' });
    assert.throws(() => x.h.ensureStoryIdle(), error => error.code === 'story_active');
    story.queue.length = 0;
    assert.throws(() => x.h.ensureStoryIdle(), error => error.code === 'story_active');
    x.advance(x.h.CONFIG.storySyncGrace - 1);
    assert.throws(() => x.h.ensureStoryIdle(), error => error.code === 'story_active');
    x.advance(1); assert.doesNotThrow(() => x.h.ensureStoryIdle()); assert.equal(x.calls.length, 0);
});

test('the UI refresh uses the same page-side Pinia and preserves the game method receiver', async () => {
    const page = pinia(), local = pinia(); let refreshed = 0;
    page._s.get('game').refresh = async function () { assert.equal(this, page._s.get('game')); refreshed++; };
    local._s.get('game').refresh = () => { throw new Error('sandbox refresh must not be called'); };
    const x = setup({ pageContext: true, pageRoot: mounted(page, 'symbol'), localRoot: mounted(local) });
    assert.equal(await x.h.refreshGameUI(), true); assert.equal(refreshed, 1); assert.equal(x.calls.length, 0);
    const replacement = pinia(); replacement._s.get('game').refresh = () => { refreshed += 10; };
    x.setPageRoot(mounted(replacement)); assert.equal(await x.h.refreshGameUI(), true); assert.equal(refreshed, 11);
});

test('UI refresh failure is contained and does not pretend that the page synchronized', async () => {
    const stores = pinia(); stores._s.get('game').refresh = () => { throw new Error('game refresh failed'); };
    const x = setup({ localRoot: mounted(stores) }); assert.equal(await x.h.refreshGameUI(), false);
    stores._s.delete('game'); assert.equal(await x.h.refreshGameUI(), false); assert.equal(x.calls.length, 0);
});

test('a pre-write loading or missing-story failure sends nothing and clears a newly prepared crafting flight', async () => {
    for (const unavailable of ['loading', 'story']) {
        const x = setup(), plan = craftPlan(x);
        if (unavailable === 'loading') x.setLocalRoot(null); else x.stores._s.get('story').cue = null;
        await assert.rejects(x.h.startCraftPlan(plan), error => error.writeNotSent === true &&
            error.code === (unavailable === 'loading' ? 'client_loading' : 'invalid_story_bridge'));
        assert.equal(x.calls.length, 0); assert.equal(x.h.craftFlight('mill'), null);
    }
});

test('a bridge lost during the authoritative pre-write GET prevents the following write', async () => {
    const x = setup(); x.h.runtime.stateUncertain = true;
    x.setResponder(request => {
        assert.equal(request.method, 'GET'); x.setLocalRoot(null);
        return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
    });
    await assert.rejects(x.h.mutate('/probe', { payload: {} }), error => error.code === 'client_loading' && error.writeNotSent);
    assert.deepEqual(x.calls.map(request => request.method), ['GET']);
});

test('a successful write followed by a broken page cue retains uncertain flight ownership', async () => {
    const stores = pinia(), x = setup({ pageContext: true, pageRoot: mounted(stores, 'symbol'), localRoot: null });
    const plan = craftPlan(x); stores._s.get('story').cue = async () => { throw new Error('page cue failed'); };
    x.setResponder(request => { assert.equal(request.method, 'POST'); return x.response(); });
    await assert.rejects(x.h.startCraftPlan(plan), error => error.code === 'invalid_story_bridge' && error.writeResponseReceived === true);
    assert.equal(x.calls.length, 1); assert.equal(x.h.craftFlight('mill').phase, 'uncertain');
});

test('stopping during loading cancels its scheduled retry and a late mount cannot restart automation', async () => {
    const x = setup({ localRoot: null }); await x.h.tick();
    assert.equal(x.lastDelay(), 1000); const retry = x.issued.at(-1);
    x.h.stop(); assert.equal(x.timers.has(retry.id), false);
    x.setLocalRoot(mounted(x.stores)); await retry.fn();
    assert.equal(x.h.activity().running, false); assert.equal(x.calls.length, 0); assert.equal(x.h.statusLine.textContent, '已停止');
});
