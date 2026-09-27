const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

// These three recipes are deliberately fictional. Their ratios reproduce the screenshot;
// they are not documentation of the game's real feed recipes.
function recipe(id, inputs, stamina, quantity = 1) {
    return { id, name: id, unlocked: true, stamina_cost: stamina, duration_seconds: 60, produce_quantity: quantity,
        item: { item_id: id, name: id, sell_price: 10 },
        inputs: Object.entries(inputs).map(([item_id, quantity]) => ({ item_id, quantity, item: { item_id, name: item_id } })) };
}
const recipes = () => [recipe('nutrition', { refined: 2 }, 3), recipe('refined', { mixed: 2 }, 2, 2), recipe('mixed', { grain: 2 }, 1, 2)];
function auditHarness(state, entries = []) {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        const source = originalRead.call(this, filename, ...args);
        return filename === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            'window.__craftTargetAudit = { craftProductionSchedule, craftMaterialTree }; if (CONFIG.ui.autoStart) start();') : source;
    };
    try {
        const x = harness(state, entries), audit = x.context.window.__craftTargetAudit;
        x.schedule = () => audit.craftProductionSchedule(x.h.runtime.state);
        x.tree = (id = 'mill') => audit.craftMaterialTree(x.h.runtime.state,
            x.h.runtime.state.crafting_stations.find(node => node.station_id === id));
        return attachBackend(x);
    } finally { fs.readFileSync = originalRead; }
}
function setup({ total = 10, stamina = 60, items = { grain: 20 }, batchLimit = 10, batchEnabled = true } = {}) {
    const state = fixture();
    Object.assign(state.player, { stamina, stamina_cap: 200, stamina_restore_seconds: 0 });
    state.inventory = Object.entries(items).map(([item_id, quantity]) => ({ item_id, name: item_id, quantity, quality: 0 }));
    state.crafting_stations = [{ station_id: 'mill', definition: { name: 'mill' }, recipes: recipes(), empty: true, ready: false, assigned_partner_ids: [] }];
    const x = auditHarness(state);
    Object.assign(x.h.CONFIG.crafting, { autoCraftInputs: true, staminaReserve: 0, batchLimit, batchEnabled });
    x.h.setOverride('rlt-node-job:crafting:mill', 'nutrition');
    x.h.setOverride('rlt-craft-lock-times:mill', String(total));
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    return x;
}
function attachBackend(x) {
    const addItem = (itemId, quantity) => {
        let row = x.backend.inventory.find(item => item.item_id === itemId);
        if (!row) { row = { item_id: itemId, name: itemId, quantity: 0, quality: 0 }; x.backend.inventory.push(row); }
        row.quantity += quantity;
        assert.ok(row.quantity >= 0, `negative inventory for ${itemId}`);
    };
    x.setResponder(request => {
        const route = request.url.match(/\/crafting\/stations\/([^/]+)\/(start|collect)$/);
        assert.ok(route, `unexpected request: ${request.url}`);
        const node = x.backend.crafting_stations.find(row => row.station_id === route[1]);
        assert.ok(node);
        if (request.url.endsWith('/start')) {
            assert.equal(node.empty, true);
            const job = node.recipes.find(row => row.id === request.payload.recipe_id), count = request.payload.quantity;
            assert.ok(job && Number.isInteger(count) && count > 0 && count <= 99);
            for (const input of job.inputs) addItem(input.item_id, -input.quantity * count);
            x.backend.player.stamina -= job.stamina_cost * count;
            assert.ok(x.backend.player.stamina >= 0, 'backend rejected insufficient stamina');
            Object.assign(node, { empty: false, ready: false, recipe: job, queue_total: count, queued_count: count - 1,
                collected_count: 0, completed_count: 0, task_snapshot: { recipe_id: job.id, recipe: job, ready_at: x.backend.server_time + 60 } });
            return x.response();
        }
        const count = node.completed_count;
        assert.ok(count > 0);
        addItem(node.recipe.item.item_id, count * node.recipe.produce_quantity);
        Object.assign(node, { empty: true, ready: false, recipe: null, queue_total: 0, queued_count: 0,
            collected_count: 0, completed_count: 0, task_snapshot: null, completed_results: [], task_results: [] });
        return x.response({ completed_count: count });
    });
    x.starts = () => x.calls.filter(request => request.url.endsWith('/start'));
    x.step = async () => { x.h.runtime.actionCount = 0; x.h.reconcileCraftFlights(x.h.runtime.state); await x.h.startEmptyIndustries(); };
    x.collect = async () => {
        assert.ok(x.backend.crafting_stations.some(node => !node.empty));
        for (const node of x.backend.crafting_stations) if (!node.empty) {
            const remaining = node.completed_count + node.queued_count + (node.task_snapshot && !node.ready ? 1 : 0);
            Object.assign(node, { ready: true, completed_count: remaining, queued_count: 0, task_snapshot: null });
        }
        x.sync(); x.h.runtime.actionCount = 0;
        await x.h.collectReadyIndustries(); x.h.reconcileCraftFlights(x.h.runtime.state);
    };
    x.drain = async () => {
        for (let index = 0; index < 40; index++) {
            await x.step();
            if (x.backend.crafting_stations.every(node => node.empty)) return;
            await x.collect();
        }
        assert.fail('finite crafting target did not finish');
    };
    return x;
}
function setFlight(x, { recipeId = 'mixed', quantity = 5, credited = 0, done = 0, root = false, steps } = {}) {
    const node = x.backend.crafting_stations[0], job = node.recipes.find(row => row.id === recipeId), remaining = quantity - credited;
    Object.assign(node, { empty: false, ready: false, recipe: job, queue_total: quantity, queued_count: remaining - 1,
        collected_count: credited, completed_count: 0, task_snapshot: { recipe_id: recipeId, recipe: job, ready_at: x.backend.server_time + 60 } });
    x.sync();
    const configured = x.h.configuredCraftSteps('mill');
    if (done) x.h.setOverride('rlt-craft-pipe-prog:mill', JSON.stringify({ version: 2,
        sig: JSON.stringify(configured.map(step => ({ recipeId: step.recipeId, times: step.times }))), done: [done] }));
    x.h.saveCraftFlight('mill', { phase: 'active', recipeId, quantity, credited, observedCollected: credited,
        runId: x.h.craftRun('mill').id, steps: steps ?? (root ? configured : []), stepIndex: 0,
        dependencyFor: root ? null : { stationId: 'mill', recipeId: 'nutrition', name: 'nutrition' } });
}
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];
function budget(tree, expected) {
    assert.ok(tree.stamina, 'complete material route must expose its remaining stamina');
    for (const [key, value] of Object.entries(expected)) assert.equal(tree.stamina[key], value, `stamina.${key}`);
}
function goal(tree, expected) {
    assert.ok(tree.goal, 'tree must distinguish the configured target from committed and unsubmitted quantities');
    for (const [key, value] of Object.entries(expected)) assert.equal(tree.goal[key], value, `goal.${key}`);
}

test('the screenshot route keeps all ten unsubmitted portions instead of silently shrinking to six', async () => {
    const x = setup({ stamina: 32, items: { mixed: 2, grain: 100 } });
    setFlight(x);
    const tree = x.tree();
    assert.equal(tree.quantity, 10);
    goal(tree, { total: 10, collected: 0, committed: 0, remaining: 10, finite: true });
    budget(tree, { cost: 54, required: 54, current: 32, missing: 22 });
    const rows = flatten(tree.root);
    assert.deepEqual(rows.filter(row => row.kind === 'recipe').map(row => [row.name, row.required, row.stamina]),
        [['nutrition', 10, 30], ['refined', 10, 20], ['mixed', 4, 4]]);
    const mixed = rows.find(row => row.kind === 'material' && row.itemId === 'mixed');
    assert.equal(mixed.required, 20); assert.equal(mixed.available, 2); assert.equal(mixed.pending, 10); assert.equal(mixed.missing, 8);
    assert.equal(x.schedule().plans.size, 0);
    await x.step(); assert.equal(x.calls.length, 0);
});

test('a complete ten-portion chain with no intermediates requires sixty stamina before its first write', async () => {
    const x = setup({ stamina: 59 });
    assert.equal(x.tree().quantity, 10);
    budget(x.tree(), { cost: 60, required: 60, current: 59, missing: 1 });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('stamina below even one portion still displays the full finite target', async () => {
    const x = setup({ stamina: 0 });
    assert.equal(x.tree().quantity, 10);
    budget(x.tree(), { cost: 60, required: 60, current: 0, missing: 60 });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('insufficient base materials do not reduce a finite target to the few affordable portions', async () => {
    const x = setup({ items: { grain: 12 } });
    assert.equal(x.tree().quantity, 10);
    goal(x.tree(), { total: 10, remaining: 10, finite: true });
    assert.equal(x.schedule().plans.size, 0);
    await x.step(); assert.equal(x.calls.length, 0);
});

test('batchLimit only caps each actual request while the tree accounts for the entire finite target', async () => {
    const x = setup({ total: 25, stamina: 150, items: { grain: 50 }, batchLimit: 3 });
    assert.equal(x.tree().quantity, 25);
    budget(x.tree(), { cost: 150, required: 150, missing: 0 });
    await x.step();
    assert.deepEqual(x.starts().map(request => [request.payload.recipe_id, request.payload.quantity]), [['mixed', 3]]);
    assert.equal(x.tree().quantity, 25, 'a helper submission must not consume the root goal');
    budget(x.tree(), { cost: 147, required: 147, current: 147, missing: 0 });
});

test('disabling batch submission still checks the entire finite route before one-portion requests', async () => {
    const x = setup({ batchEnabled: false });
    assert.equal(x.tree().quantity, 10);
    budget(x.tree(), { cost: 60, required: 60, missing: 0 });
    await x.step();
    assert.deepEqual(x.starts().map(request => [request.payload.recipe_id, request.payload.quantity]), [['mixed', 1]]);
});

test('finite targets above the protocol request maximum remain complete in the tree', async () => {
    const x = setup({ total: 120, stamina: 720, items: { grain: 240 }, batchLimit: 150 });
    assert.equal(x.tree().quantity, 120);
    budget(x.tree(), { cost: 720, required: 720, missing: 0 });
    await x.step();
    assert.equal(x.starts()[0].payload.quantity, 99);
    assert.equal(x.tree().quantity, 120);
    budget(x.tree(), { cost: 621, required: 621, current: 621, missing: 0 });
});

test('collected root portions and the uncollected part of a matching root flight are deducted exactly once', () => {
    const x = setup();
    setFlight(x, { recipeId: 'nutrition', quantity: 4, credited: 1, done: 3, root: true });
    const tree = x.tree();
    assert.equal(tree.quantity, 4);
    goal(tree, { total: 10, collected: 3, committed: 3, remaining: 4, finite: true });
    budget(tree, { cost: 24, required: 24, missing: 0 });
    assert.equal(x.schedule().plans.size, 0, 'the active root queue must finish before further submissions');
});

test('an entirely committed root keeps a zero-unsubmitted goal while awaiting collection', async () => {
    const x = setup({ stamina: 0, items: {} });
    setFlight(x, { recipeId: 'nutrition', quantity: 10, credited: 2, done: 2, root: true });
    const tree = x.tree();
    assert.equal(tree.quantity, 0);
    goal(tree, { total: 10, collected: 2, committed: 8, remaining: 0, finite: true });
    assert.equal(x.schedule().plans.size, 0);
    await x.step(); assert.equal(x.calls.length, 0);
});

for (const mismatch of ['recipe', 'signature', 'step']) {
    test(`a root flight with a different ${mismatch} does not reduce the current target`, () => {
        const x = setup({ stamina: 100 });
        setFlight(x, { root: true, recipeId: mismatch === 'recipe' ? 'refined' : 'nutrition', quantity: 4,
            steps: mismatch === 'signature' ? [{ recipeId: 'nutrition', times: 11, taskItemId: '' }] : undefined });
        if (mismatch === 'step') {
            const flight = x.h.craftFlight('mill'); flight.stepIndex = 1; x.h.saveCraftFlight('mill', flight);
        }
        assert.equal(x.tree().quantity, 10);
        goal(x.tree(), { total: 10, collected: 0, committed: 0, remaining: 10, finite: true });
    });
}

test('a running pipeline checks the whole current step while leaving later steps for their own turn', async () => {
    const x = setup({ stamina: 59 });
    x.h.setOverride('rlt-node-job:crafting:mill', '');
    x.h.setOverride('rlt-craft-pipe:mill', JSON.stringify([{ recipeId: 'nutrition', times: 10 }, { recipeId: 'mixed', times: 5 }]));
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    assert.equal(x.tree().quantity, 10);
    goal(x.tree(), { total: 10, collected: 0, committed: 0, remaining: 10, finite: true });
    budget(x.tree(), { cost: 60, required: 60, missing: 1 });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('split helper and root submissions complete the exact target without repeating paid stamina or credit', async () => {
    const x = setup({ batchLimit: 3 });
    await x.drain();
    const totals = new Map();
    for (const request of x.starts()) {
        assert.ok(request.payload.quantity <= 3);
        const id = request.payload.recipe_id;
        totals.set(id, (totals.get(id) || 0) + request.payload.quantity);
    }
    assert.deepEqual([...totals], [['mixed', 10], ['refined', 10], ['nutrition', 10]]);
    assert.equal(x.backend.player.stamina, 0);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'nutrition').quantity, 10);
    assert.equal(x.h.craftPipelineProgress('mill', x.h.configuredCraftSteps('mill')).done[0], 10);
    assert.equal(x.h.craftFlight('mill'), null);
});

test('refresh after a paid helper batch preserves the complete root and only its unpaid route cost', async () => {
    const x = setup({ batchLimit: 3 });
    await x.step();
    const y = auditHarness(x.backend, [...x.storage]);
    assert.equal(y.tree().quantity, 10);
    goal(y.tree(), { total: 10, collected: 0, committed: 0, remaining: 10, finite: true });
    budget(y.tree(), { cost: 57, required: 57, current: 57, missing: 0 });
    await y.step(); assert.equal(y.calls.length, 0, 'an active helper batch is not resubmitted on reload');
    await y.collect(); await y.drain();
    assert.equal(y.backend.player.stamina, 0);
    assert.equal(y.h.craftPipelineProgress('mill', y.h.configuredCraftSteps('mill')).done[0], 10);
});

test('a legacy unlimited count becomes one complete execution after explicit authorization', async () => {
    const x = setup({ total: 0, stamina: 37, items: { mixed: 2, grain: 100 } });
    assert.equal(x.tree().quantity, 1);
    goal(x.tree(), { total: 1, remaining: 1, finite: true });
    budget(x.tree(), { cost: 5, required: 5, current: 37, missing: 0 });
    await x.step();
    assert.deepEqual(x.starts().map(request => [request.payload.recipe_id, request.payload.quantity]), [['refined', 1]]);
    await x.collect(); await x.drain();
    assert.equal(x.h.craftRun('mill').status, 'completed');
    assert.equal(x.backend.inventory.find(row => row.item_id === 'nutrition').quantity, 1);
});

for (const phase of ['submitting', 'unknown']) {
    test(`an unconfirmed root flight in phase ${phase} does not reduce the unsubmitted goal`, () => {
        const x = setup();
        setFlight(x, { recipeId: 'nutrition', quantity: 4, root: true });
        const flight = x.h.craftFlight('mill'); flight.phase = phase; x.h.saveCraftFlight('mill', flight);
        assert.equal(x.tree().quantity, 10);
        goal(x.tree(), { total: 10, collected: 0, committed: 0, remaining: 10, finite: true });
        assert.equal(x.schedule().plans.size, 0);
        assert.equal(x.calls.length, 0);
    });
}

test('a manual root queue without a flight does not count toward the helper target', async () => {
    const x = setup();
    setFlight(x, { recipeId: 'nutrition', quantity: 4, root: true });
    x.h.saveCraftFlight('mill', null);
    assert.equal(x.tree().quantity, 10);
    goal(x.tree(), { total: 10, collected: 0, committed: 0, remaining: 10, finite: true });
    budget(x.tree(), { cost: 60, required: 60, missing: 0 });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('a finite goal counts recipe executions even when each execution produces multiple items', async () => {
    const x = setup({ total: 4, stamina: 24, items: { grain: 8 }, batchLimit: 3 });
    x.backend.crafting_stations[0].recipes[0].produce_quantity = 3;
    x.sync();
    assert.equal(x.tree().quantity, 4);
    goal(x.tree(), { total: 4, collected: 0, committed: 0, remaining: 4, finite: true });
    budget(x.tree(), { cost: 24, required: 24, missing: 0 });
    await x.drain();
    assert.equal(x.starts().filter(request => request.payload.recipe_id === 'nutrition')
        .reduce((sum, request) => sum + request.payload.quantity, 0), 4);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'nutrition').quantity, 12);
    assert.equal(x.h.craftPipelineProgress('mill', x.h.configuredCraftSteps('mill')).done[0], 4);
    assert.equal(x.backend.player.stamina, 0);
});

test('partial collection of two executions from an actual root batch of three leaves seven unsubmitted', async () => {
    const x = setup({ stamina: 30, items: { refined: 20 }, batchLimit: 3 });
    await x.step();
    assert.deepEqual(x.starts().map(request => [request.payload.recipe_id, request.payload.quantity]), [['nutrition', 3]]);
    goal(x.tree(), { total: 10, collected: 0, committed: 3, remaining: 7, finite: true });
    const node = x.backend.crafting_stations[0];
    Object.assign(node, { completed_count: 2, queued_count: 0 });
    x.sync();
    x.setResponder(request => {
        assert.ok(request.url.endsWith('/collect'));
        assert.equal(node.completed_count, 2);
        x.backend.inventory.push({ item_id: 'nutrition', name: 'nutrition', quantity: 2, quality: 0 });
        Object.assign(node, { completed_count: 0, collected_count: 2 });
        return x.response({ completed_count: 2 });
    });
    await x.h.collectReadyIndustries();
    x.h.reconcileCraftFlights(x.h.runtime.state);
    goal(x.tree(), { total: 10, collected: 2, committed: 1, remaining: 7, finite: true });
    assert.equal(x.tree().quantity, 7);
    budget(x.tree(), { cost: 21, required: 21, current: 21, missing: 0 });
    assert.equal(x.h.craftFlight('mill').credited, 2);
    assert.equal(x.h.craftPipelineProgress('mill', x.h.configuredCraftSteps('mill')).done[0], 2);
    await x.step();
    assert.equal(x.starts().length, 1, 'the remaining execution is still in flight, so no root batch is resubmitted');
});

function sharedRoots(stamina) {
    const x = setup({ total: 3, stamina, items: { mixed: 3 }, batchLimit: 1 });
    const station = (id, jobs) => ({ station_id: id, definition: { name: id }, recipes: jobs,
        empty: true, ready: false, assigned_partner_ids: [] });
    x.backend.crafting_stations = [station('mill', [recipe('nutrition', { refined: 2 }, 3)]),
        station('bakery', [recipe('bread', { refined: 1 }, 4)]), station('factory', [recipe('refined', { mixed: 1 }, 2, 4)])];
    x.sync();
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread');
    x.h.setOverride('rlt-craft-lock-times:bakery', '3');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'bakery'), true);
    return x;
}
function submittedTotals(x) {
    const totals = {};
    for (const request of x.starts()) totals[request.payload.recipe_id] = (totals[request.payload.recipe_id] || 0) + request.payload.quantity;
    return totals;
}

test('two complete finite goals reuse rounded helper output across roots and finish at their shared exact budget', async () => {
    const x = sharedRoots(27);
    assert.equal(x.tree().quantity, 3); assert.equal(x.tree('bakery').quantity, 3);
    budget(x.tree(), { cost: 13, reserved: 0, required: 13, current: 27, missing: 0 });
    budget(x.tree('bakery'), { cost: 14, reserved: 13, required: 27, current: 27, missing: 0 });
    await x.drain();
    assert.deepEqual(submittedTotals(x), { refined: 3, nutrition: 3, bread: 3 });
    assert.equal(x.backend.inventory.find(row => row.item_id === 'refined').quantity, 3, 'twelve helper items cover nine consumed items with three left');
    assert.equal(x.backend.player.stamina, 0);
    assert.equal(x.h.craftPipelineProgress('mill', x.h.configuredCraftSteps('mill')).done[0], 3);
    assert.equal(x.h.craftPipelineProgress('bakery', x.h.configuredCraftSteps('bakery')).done[0], 3);
});

test('a second finite root does not shrink to use shared leftovers when its full route is one stamina short', async () => {
    const x = sharedRoots(26);
    assert.equal(x.tree('bakery').quantity, 3);
    budget(x.tree('bakery'), { cost: 14, reserved: 13, required: 27, current: 26, missing: 1 });
    await x.drain();
    assert.deepEqual(submittedTotals(x), { refined: 2, nutrition: 3 });
    assert.equal(x.backend.inventory.find(row => row.item_id === 'refined').quantity, 2);
    assert.equal(x.backend.player.stamina, 13);
    assert.equal(x.tree('bakery').quantity, 3);
    goal(x.tree('bakery'), { total: 3, collected: 0, committed: 0, remaining: 3, finite: true });
    budget(x.tree('bakery'), { cost: 14, reserved: 0, required: 14, current: 13, missing: 1 });
    x.backend.player.stamina += 1; x.sync();
    await x.drain();
    assert.deepEqual(submittedTotals(x), { refined: 3, nutrition: 3, bread: 3 });
    assert.equal(x.backend.player.stamina, 0);
});
