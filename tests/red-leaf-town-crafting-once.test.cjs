const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function recipe(id, inputs, stamina = 1, quantity = 1) {
    return { id, name: id, unlocked: true, stamina_cost: stamina, duration_seconds: 60, produce_quantity: quantity,
        item: { item_id: id, name: id, sell_price: 10 },
        inputs: Object.entries(inputs).map(([item_id, quantity]) => ({ item_id, quantity, item: { item_id, name: item_id } })) };
}
const jobs = () => [recipe('meal', { flour: 2 }, 3), recipe('flour', { wheat: 1 }, 2, 2), recipe('jam', { berry: 1 })];
const station = (id, recipes) => ({ station_id: id, definition: { name: id }, recipes, empty: true, ready: false, assigned_partner_ids: [] });

// This suite deliberately never authorizes a run in its fixture or on configuration writes.
// Every positive case invokes the same explicit start API as the button.
function rawHarness(state, entries = []) {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        const source = originalRead.call(this, filename, ...args);
        return filename === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();', `window.__craftOnceAudit = {
            startCraftRun: typeof startCraftRun === 'function' ? startCraftRun : null,
            stopCraftRun: typeof stopCraftRun === 'function' ? stopCraftRun : null,
            craftRun: typeof craftRun === 'function' ? craftRun : null,
            craftPipelineRunning, craftProductionSchedule, craftMaterialTree,
            setBusy(value) { busy = value; }
        }; if (CONFIG.ui.autoStart) start();`) : source;
    };
    try {
        const x = harness(state, entries), audit = x.context.window.__craftOnceAudit;
        x.run = (id = 'kitchen') => { assert.equal(typeof audit.craftRun, 'function'); return audit.craftRun(id); };
        x.start = (id = 'kitchen') => { assert.equal(typeof audit.startCraftRun, 'function'); return audit.startCraftRun(x.h.runtime.state, id); };
        x.stop = (id = 'kitchen') => { assert.equal(typeof audit.stopCraftRun, 'function'); return audit.stopCraftRun(id); };
        x.active = (id = 'kitchen') => audit.craftPipelineRunning(id);
        x.schedule = () => audit.craftProductionSchedule(x.h.runtime.state);
        x.tree = (id = 'kitchen') => audit.craftMaterialTree(x.h.runtime.state, x.h.runtime.state.crafting_stations.find(node => node.station_id === id));
        x.setBusy = audit.setBusy;
        return attachBackend(x);
    } finally { fs.readFileSync = originalRead; }
}
function setup({ total = 2, pipeline = null, items = { wheat: 20, berry: 20 }, stamina = 100, batchLimit = 10 } = {}) {
    const state = fixture();
    Object.assign(state.player, { stamina, stamina_cap: 100, stamina_restore_seconds: 0 });
    state.inventory = Object.entries(items).map(([item_id, quantity]) => ({ item_id, name: item_id, quantity, quality: 0 }));
    state.crafting_stations = [station('kitchen', jobs())];
    const x = rawHarness(state);
    Object.assign(x.h.CONFIG.crafting, { autoCraftInputs: true, staminaReserve: 0, batchLimit });
    if (pipeline) x.h.setOverride('rlt-craft-pipe:kitchen', JSON.stringify(pipeline));
    else {
        x.h.setOverride('rlt-node-job:crafting:kitchen', 'meal');
        if (total != null) x.h.setOverride('rlt-craft-lock-times:kitchen', String(total));
    }
    return x;
}
function attachBackend(x) {
    x.addItem = (itemId, quantity) => {
        let row = x.backend.inventory.find(item => item.item_id === itemId);
        if (!row) { row = { item_id: itemId, name: itemId, quantity: 0, quality: 0 }; x.backend.inventory.push(row); }
        row.quantity += quantity;
        assert.ok(row.quantity >= 0, `negative inventory for ${itemId}`);
    };
    x.respond = request => {
        if (request.url.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        const route = request.url.match(/\/crafting\/stations\/([^/]+)\/(start|collect)$/);
        assert.ok(route, `unexpected request: ${request.url}`);
        const node = x.backend.crafting_stations.find(row => row.station_id === route[1]);
        assert.ok(node);
        if (route[2] === 'start') {
            assert.equal(node.empty, true);
            const job = node.recipes.find(row => row.id === request.payload.recipe_id), count = request.payload.quantity;
            assert.ok(job && Number.isInteger(count) && count > 0 && count <= 99);
            for (const input of job.inputs) x.addItem(input.item_id, -input.quantity * count);
            x.backend.player.stamina -= job.stamina_cost * count;
            assert.ok(x.backend.player.stamina >= 0);
            Object.assign(node, { empty: false, ready: false, recipe: job, queue_total: count, queued_count: count - 1,
                collected_count: 0, completed_count: 0, task_snapshot: { recipe_id: job.id, recipe: job, ready_at: x.backend.server_time + 60 } });
            return x.response();
        }
        const count = node.completed_count;
        assert.ok(count > 0);
        x.addItem(node.recipe.item.item_id, count * node.recipe.produce_quantity);
        Object.assign(node, { empty: true, ready: false, recipe: null, queue_total: 0, queued_count: 0,
            collected_count: 0, completed_count: 0, task_snapshot: null, completed_results: [], task_results: [] });
        return x.response({ completed_count: count });
    };
    x.setResponder(x.respond);
    x.starts = () => x.calls.filter(request => request.url.endsWith('/start'));
    x.progress = (id = 'kitchen') => [...x.h.craftPipelineProgress(id, x.h.configuredCraftSteps(id)).done];
    x.step = async () => { x.h.runtime.actionCount = 0; x.h.reconcileCraftFlights(x.h.runtime.state); await x.h.startEmptyIndustries(); };
    x.collect = async () => {
        assert.ok(x.backend.crafting_stations.some(node => !node.empty));
        for (const node of x.backend.crafting_stations) if (!node.empty) {
            const count = node.completed_count + node.queued_count + (node.task_snapshot && !node.ready ? 1 : 0);
            Object.assign(node, { completed_count: count, queued_count: 0, ready: true, task_snapshot: null });
        }
        x.sync(); x.h.runtime.actionCount = 0;
        await x.h.collectReadyIndustries(); x.h.reconcileCraftFlights(x.h.runtime.state);
    };
    x.drain = async () => {
        for (let index = 0; index < 30; index++) {
            await x.step();
            if (x.backend.crafting_stations.every(node => node.empty)) return;
            await x.collect();
        }
        assert.fail('one-shot run did not settle');
    };
    return x;
}
const started = x => x.starts().map(request => [request.payload.recipe_id, request.payload.quantity]);
const pipeline = () => [{ recipeId: 'meal', times: 2 }, { recipeId: 'jam', times: 3 }];

test('selecting a locked recipe does not authorize any production', async () => {
    const x = setup();
    await x.step();
    assert.equal(x.calls.length, 0);
    assert.equal(x.active(), false);
    assert.equal(x.run(), null);
});

test('a saved legacy pipeline run flag and repeat preference do not authorize a new run', async () => {
    const x = setup({ pipeline: pipeline() });
    x.h.setOverride('rlt-craft-pipe-run:kitchen', '1');
    x.h.CONFIG.crafting.repeatPipeline = true;
    const y = rawHarness(x.backend, [...x.storage]);
    await y.step();
    assert.equal(y.calls.length, 0);
    assert.equal(y.active(), false);
    assert.equal(y.run(), null);
});

test('a material tree preview cannot create an authorization record', async () => {
    const x = setup();
    const before = [...x.storage];
    assert.ok(x.tree().root);
    assert.deepEqual([...x.storage], before);
    assert.equal(x.run(), null);
    await x.step(); assert.equal(x.calls.length, 0);
});

for (const total of [0, null]) {
    test(`a locked ${total == null ? 'unset' : 'zero'} count becomes exactly one execution after one click`, async () => {
        const x = setup({ total });
        assert.equal(x.h.configuredCraftSteps('kitchen')[0].times, 1);
        await x.step(); assert.equal(x.calls.length, 0);
        assert.equal(x.start(), true);
        await x.drain();
        assert.deepEqual(started(x), [['flour', 1], ['meal', 1]]);
        assert.equal(x.run().status, 'completed');
        assert.equal(x.active(), false);
        await x.step(); await x.step(); assert.equal(x.starts().length, 2);
    });
}

test('one explicit click completes a locked target and stops even with the obsolete repeat preference enabled', async () => {
    const x = setup(); x.h.CONFIG.crafting.repeatPipeline = true;
    assert.equal(x.start(), true);
    const record = x.run();
    assert.equal(record.version, 1); assert.equal(record.status, 'running'); assert.ok(record.id && record.sig && record.startedAt);
    assert.equal(x.calls.length, 0, 'the synchronous click authorizes work without sending a write itself');
    await x.drain();
    assert.deepEqual(started(x), [['flour', 2], ['meal', 2]]);
    assert.deepEqual(x.progress(), [2]);
    assert.equal(x.run().status, 'completed'); assert.equal(x.run().id, record.id); assert.equal(x.active(), false);
    await x.step(); await x.step(); assert.equal(x.starts().length, 2);
});

test('one click completes every configured pipeline step once', async () => {
    const x = setup({ pipeline: pipeline(), batchLimit: 1 });
    assert.equal(x.start(), true);
    await x.drain();
    const totals = {};
    for (const [id, quantity] of started(x)) totals[id] = (totals[id] || 0) + quantity;
    assert.deepEqual(totals, { flour: 2, meal: 2, jam: 3 });
    assert.deepEqual(x.progress(), [2, 3]);
    assert.equal(x.run().status, 'completed');
    const count = x.starts().length; await x.step(); assert.equal(x.starts().length, count);
});

test('a second click while running does not create another run or reset progress', async () => {
    const x = setup({ total: 3, items: { flour: 6 }, batchLimit: 1 });
    assert.equal(x.start(), true);
    const id = x.run().id;
    assert.equal(x.start(), false);
    await x.step(); await x.collect();
    assert.deepEqual(x.progress(), [1]);
    assert.equal(x.start(), false);
    assert.equal(x.run().id, id); assert.deepEqual(x.progress(), [1]);
    await x.drain(); assert.equal(x.run().status, 'completed');
});

test('clicking a completed target explicitly creates a new run and resets its progress', async () => {
    const x = setup(); assert.equal(x.start(), true); await x.drain();
    const completedId = x.run().id;
    assert.equal(x.start(), true);
    assert.notEqual(x.run().id, completedId);
    assert.deepEqual(x.progress(), [0]);
    await x.drain();
    assert.deepEqual(started(x), [['flour', 2], ['meal', 2], ['flour', 2], ['meal', 2]]);
    assert.equal(x.run().status, 'completed');
});

test('stopping an unfinished run preserves progress and clicking again resumes the same run', async () => {
    const x = setup({ total: 3, items: { flour: 6 }, batchLimit: 1 });
    assert.equal(x.start(), true);
    const id = x.run().id;
    await x.step(); await x.collect();
    assert.equal(x.stop(), true); assert.equal(x.run().status, 'stopped'); assert.equal(x.active(), false);
    await x.step(); assert.equal(x.starts().length, 1);
    assert.equal(x.start(), true); assert.equal(x.run().id, id); assert.deepEqual(x.progress(), [1]);
    await x.drain(); assert.equal(x.run().status, 'completed'); assert.deepEqual(x.progress(), [3]);
    assert.equal(x.starts().length, 3);
});

test('an authorized run waits for base materials and resumes without another click', async () => {
    const x = setup({ items: {} });
    assert.equal(x.start(), true); const id = x.run().id;
    await x.step(); assert.equal(x.calls.length, 0); assert.equal(x.run().status, 'running');
    x.addItem('wheat', 2); x.sync();
    await x.drain(); assert.equal(x.run().id, id); assert.equal(x.run().status, 'completed');
});

test('an authorized run waits for its full-route stamina and keeps the same authorization after recovery', async () => {
    const x = setup({ stamina: 9 });
    assert.equal(x.start(), true); const id = x.run().id;
    await x.step(); assert.equal(x.calls.length, 0);
    assert.equal(x.tree().quantity, 2);
    x.backend.player.stamina = 10; x.sync();
    await x.drain(); assert.equal(x.run().id, id); assert.equal(x.run().status, 'completed');
    assert.equal(x.backend.player.stamina, 0);
});

test('the whole pipeline signature invalidates an active run when a later step changes', async () => {
    const x = setup({ pipeline: pipeline() });
    assert.equal(x.start(), true); const id = x.run().id;
    x.h.setOverride('rlt-craft-pipe:kitchen', JSON.stringify([{ recipeId: 'meal', times: 2 }, { recipeId: 'jam', times: 4 }]));
    assert.equal(x.active(), false);
    await x.step(); assert.equal(x.calls.length, 0);
    assert.equal(x.start(), true); assert.notEqual(x.run().id, id);
    await x.drain(); assert.deepEqual(x.progress(), [2, 4]);
});

test('changing only a pipeline task-item choice preserves the run signature', () => {
    const x = setup({ pipeline: pipeline() });
    assert.equal(x.start(), true); const original = x.run();
    x.h.setOverride('rlt-craft-pipe:kitchen', JSON.stringify([{ recipeId: 'meal', times: 2, taskItemId: '__off' }, { recipeId: 'jam', times: 3 }]));
    assert.equal(x.active(), true); assert.equal(x.run().id, original.id); assert.equal(x.run().sig, original.sig);
});

test('busy state rejects a click without persisting a run', () => {
    const x = setup(); x.setBusy(true);
    try { assert.equal(x.start(), false); assert.equal(x.run(), null); }
    finally { x.setBusy(false); }
    assert.equal(x.start(), true);
});

test('a manual active root queue rejects a new run', () => {
    const x = setup(), node = x.backend.crafting_stations[0];
    Object.assign(node, { empty: false, recipe: node.recipes[0], task_snapshot: { recipe_id: 'meal', ready_at: x.backend.server_time + 60 } });
    x.sync(); assert.equal(x.start(), false); assert.equal(x.run(), null);
});

test('a persisted uncertain root flight rejects a new run even if the root station looks empty', () => {
    const x = setup();
    x.h.saveCraftFlight('kitchen', { phase: 'uncertain', recipeId: 'meal', quantity: 2, credited: 0, observedCollected: 0,
        steps: x.h.configuredCraftSteps('kitchen'), stepIndex: 0 });
    assert.equal(x.start(), false); assert.equal(x.run(), null);
});

test('a helper flight at another station rejects opening a new run for its parent', () => {
    const x = setup(); x.backend.crafting_stations.push(station('mill', [jobs()[1]])); x.sync();
    x.h.saveCraftFlight('mill', { phase: 'active', recipeId: 'flour', quantity: 2, credited: 0, observedCollected: 0, steps: [], stepIndex: 0,
        dependencyFor: { stationId: 'kitchen', recipeId: 'meal', name: 'meal' }, runId: 'old-run' });
    assert.equal(x.start(), false); assert.equal(x.run(), null);
});

test('stopping during a helper queue prevents parent submissions and cannot resume until the helper is collected', async () => {
    const x = setup(); assert.equal(x.start(), true); const id = x.run().id;
    await x.step();
    const flight = x.h.craftFlight('kitchen');
    assert.equal(flight.runId, id); assert.equal(flight.dependencyFor.stationId, 'kitchen'); assert.equal(flight.steps.length, 0);
    assert.equal(x.stop(), true); assert.equal(x.start(), false);
    await x.collect(); await x.step();
    assert.deepEqual(started(x), [['flour', 2]]); assert.equal(x.run().status, 'stopped');
    assert.equal(x.start(), true); assert.equal(x.run().id, id);
    await x.drain(); assert.deepEqual(started(x), [['flour', 2], ['meal', 2]]); assert.equal(x.run().status, 'completed');
});

test('a valid active run and helper flight resume across refresh without another click', async () => {
    const x = setup(); assert.equal(x.start(), true); const id = x.run().id; await x.step();
    const y = rawHarness(x.backend, [...x.storage]);
    assert.equal(y.run().id, id); assert.equal(y.active(), true);
    await y.step(); assert.equal(y.calls.length, 0);
    await y.collect(); await y.drain();
    assert.deepEqual(started(y), [['meal', 2]]); assert.equal(y.run().status, 'completed'); assert.deepEqual(y.progress(), [2]);
});

test('a stale planned write cannot execute after its run has been stopped', async () => {
    const x = setup(); assert.equal(x.start(), true);
    const plan = x.schedule().plans.get('kitchen');
    assert.ok(plan); assert.equal(plan.runId, x.run().id);
    x.stop();
    assert.equal(await x.h.startCraftPlan(plan), false);
    assert.equal(x.calls.length, 0); assert.equal(x.h.craftFlight('kitchen'), null);
});

test('stopping during an awaited state refresh prevents the subsequent planned POST', async () => {
    const x = setup(); assert.equal(x.start(), true);
    const plan = x.schedule().plans.get('kitchen');
    x.h.runtime.stateUncertain = true;
    let enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    x.setResponder(async request => {
        if (request.url.endsWith('/state')) { enteredResolve(); await gate; }
        return x.respond(request);
    });
    const work = x.h.startCraftPlan(plan).then(value => ({ value }), error => ({ error }));
    await entered; x.stop(); release(); await work;
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/state'));
    assert.equal(x.starts().length, 0); assert.equal(x.h.craftFlight('kitchen'), null);
    assert.equal(x.run().status, 'stopped');
});

test('a fully submitted target displays its pending queue without another zero-sized recipe or stamina charge', async () => {
    const x = setup({ items: { flour: 4 }, stamina: 6 });
    assert.equal(x.start(), true); await x.step();
    const tree = x.tree();
    assert.equal(tree.phase, 'committed'); assert.equal(tree.quantity, 0);
    assert.equal(tree.goal.committed, 2); assert.equal(tree.goal.remaining, 0);
    assert.equal(tree.root.kind, 'queue'); assert.equal(tree.root.required, 2);
    assert.ok(tree.root.stamina == null, 'the queue row is already paid and should not display a recipe cost');
    assert.equal(x.schedule().plans.size, 0);
    await x.collect(); assert.equal(x.run().status, 'completed');
});

test('a legacy flight remains collectable but its completion cannot authorize another run', async () => {
    const x = setup({ items: { flour: 4 } }), node = x.backend.crafting_stations[0], job = node.recipes[0];
    Object.assign(node, { empty: false, ready: false, recipe: job, queue_total: 2, queued_count: 1, completed_count: 0,
        collected_count: 0, task_snapshot: { recipe_id: job.id, recipe: job, ready_at: x.backend.server_time + 60 } });
    x.sync();
    x.h.saveCraftFlight('kitchen', { phase: 'active', recipeId: 'meal', quantity: 2, credited: 0,
        observedCollected: 0, steps: x.h.configuredCraftSteps('kitchen'), stepIndex: 0 });
    assert.equal(x.start(), false);
    await x.collect(); await x.step();
    assert.equal(x.starts().length, 0); assert.equal(x.run(), null); assert.equal(x.h.craftFlight('kitchen'), null);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'meal').quantity, 2);
    assert.equal(x.start(), true); assert.deepEqual(x.progress(), [0]);
});

test('stopping while a write is pending prevents further work and a simultaneous click cannot start a second run', async () => {
    const x = setup(); assert.equal(x.start(), true);
    let enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    x.setResponder(async request => { if (request.url.endsWith('/start')) { enteredResolve(); await gate; } return x.respond(request); });
    const work = x.step(); await entered;
    assert.equal(x.start(), false);
    assert.equal(x.stop(), true); assert.equal(x.start(), false);
    release(); await work;
    assert.equal(x.starts().length, 1); assert.equal(x.run().status, 'stopped');
    x.setResponder(x.respond); await x.collect(); await x.step(); assert.equal(x.starts().length, 1);
});

test('a lost response leaves an uncertain flight and never blindly resubmits after refresh', async () => {
    const x = setup(); assert.equal(x.start(), true);
    x.setResponder(request => {
        const response = x.respond(request);
        if (request.url.endsWith('/start')) throw new Error('lost response after server acceptance');
        return response;
    });
    await assert.rejects(x.step());
    assert.equal(x.h.craftFlight('kitchen').phase, 'uncertain'); assert.equal(x.starts().length, 1);
    const y = rawHarness(x.backend, [...x.storage]);
    await y.step(); assert.equal(y.calls.length, 0); assert.equal(y.start(), false);
});

for (const helper of [false, true]) {
    test(`canceling a ${helper ? 'helper' : 'root'} queue stops its owning run`, async () => {
        const x = setup({ items: helper ? { wheat: 20 } : { flour: 20 } });
        assert.equal(x.start(), true); await x.step();
        const node = x.backend.crafting_stations[0];
        x.h.runtime.cancelCraft = { id: 'kitchen', recipeId: node.recipe.id, readyAt: node.task_snapshot.ready_at };
        x.setResponder(request => {
            assert.ok(request.url.endsWith('/tasks/cancel'));
            Object.assign(node, { empty: true, ready: false, recipe: null, queue_total: 0, queued_count: 0, completed_count: 0,
                collected_count: 0, task_snapshot: null });
            return x.response();
        });
        await x.h.processCraftCancel();
        assert.equal(x.run().status, 'stopped'); assert.equal(x.active(), false);
        x.setResponder(x.respond); await x.step(); assert.equal(x.starts().length, 1);
    });
}

test('a refreshed missing base material invalidates an old helper plan before its POST', async () => {
    const x = setup({ total: 1, items: { wheat: 2, pumpkin: 1 } });
    x.backend.crafting_stations[0].recipes[0] = recipe('meal', { flour: 2, pumpkin: 1 }, 3);
    x.sync(); assert.equal(x.start(), true);
    const plan = x.schedule().plans.get('kitchen');
    assert.equal(plan.job.id, 'flour');
    x.h.runtime.stateUncertain = true;
    x.backend.inventory.find(row => row.item_id === 'pumpkin').quantity = 0;
    await assert.rejects(x.h.startCraftPlan(plan), error => error.writeNotSent === true);
    assert.deepEqual(x.calls.map(request => request.method), ['GET']);
    assert.equal(x.h.craftFlight('kitchen'), null);
    assert.equal(x.run().status, 'running', 'the run remains authorized while waiting for its missing material');
    assert.match(x.tree().statusLabel, /pumpkin/);
    await x.step(); assert.equal(x.starts().length, 0);
    x.addItem('pumpkin', 1); x.sync(); await x.drain();
    assert.deepEqual(started(x), [['flour', 1], ['meal', 1]]);
    assert.equal(x.run().status, 'completed');
});

test('a legacy helper pause marker cannot block a newly authorized root run', async () => {
    const x = setup();
    x.backend.crafting_stations[0].recipes = jobs().filter(job => job.id !== 'flour');
    x.backend.crafting_stations.push(station('mill', [jobs()[1]])); x.sync();
    x.h.setOverride('rlt-craft-paused:mill', '1');
    x.h.setOverride('rlt-craft-paused:kitchen', '1');
    const y = rawHarness(x.backend, [...x.storage]);
    await y.step(); assert.equal(y.calls.length, 0, 'legacy settings do not grant permission to start');
    assert.equal(y.start(), true); await y.drain();
    assert.deepEqual(started(y), [['flour', 2], ['meal', 2]]);
    assert.equal(y.starts()[0].url.endsWith('/stations/mill/start'), true);
    assert.equal(y.run().status, 'completed'); assert.deepEqual(y.progress(), [2]);
    await y.step(); assert.equal(y.starts().length, 2);
});

test('canceling a different station helper through the UI allows the owning run to continue later', async t => {
    const x = setup(); t.after(() => x.h.stop());
    x.backend.crafting_stations[0].recipes = jobs().filter(job => job.id !== 'flour');
    x.backend.crafting_stations.push(station('mill', [jobs()[1]])); x.sync();
    assert.equal(x.start(), true); const runId = x.run().id;
    await x.step(); assert.equal(x.starts()[0].url.endsWith('/stations/mill/start'), true);
    x.h.tabBar.children.find(button => button.dataset.page === 'crafting').onclick();
    const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
    const cancel = descendants(x.h.configBox).find(node => node.tagName === 'BUTTON' && node.textContent === '取消当前队列');
    assert.ok(cancel); assert.equal(cancel.disabled, false); cancel.onclick();
    assert.equal(x.run().status, 'stopped');
    assert.equal(x.h.runtime.cancelCraft.id, 'mill');
    x.setResponder(request => {
        assert.ok(request.url.endsWith('/tasks/cancel'));
        assert.equal(request.payload.slot_id, 'mill');
        Object.assign(x.backend.crafting_stations[1], { empty: true, ready: false, recipe: null,
            queue_total: 0, queued_count: 0, completed_count: 0, collected_count: 0, task_snapshot: null });
        return x.response();
    });
    await x.h.processCraftCancel();
    assert.equal(x.h.craftFlight('mill'), null);
    assert.equal(x.h.getOverride('rlt-craft-paused:mill'), null, 'cancel must not create an inaccessible legacy station pause');
    x.setResponder(x.respond); await x.step(); assert.equal(x.starts().length, 1);
    assert.equal(x.start(), true); assert.equal(x.run().id, runId);
    await x.drain();
    assert.deepEqual(started(x), [['flour', 2], ['flour', 2], ['meal', 2]]);
    assert.deepEqual(x.progress(), [2]); assert.equal(x.run().status, 'completed');
    await x.step(); assert.equal(x.starts().length, 3);
});
