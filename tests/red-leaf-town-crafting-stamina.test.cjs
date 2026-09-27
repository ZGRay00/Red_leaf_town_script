const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function auditedHarness(state, entries = []) {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        const source = originalRead.call(this, filename, ...args);
        return filename === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            'window.__craftStaminaAudit = { craftProductionSchedule, craftMaterialTree }; if (CONFIG.ui.autoStart) start();') : source;
    };
    try {
        const x = harness(state, entries), audit = x.context.window.__craftStaminaAudit;
        x.schedule = () => audit.craftProductionSchedule(x.h.runtime.state);
        x.tree = (id = 'kitchen') => audit.craftMaterialTree(x.h.runtime.state,
            x.h.runtime.state.crafting_stations.find(node => node.station_id === id));
        return x;
    } finally { fs.readFileSync = originalRead; }
}

function recipe(id, inputs, stamina, quantity = 1, itemId = id) {
    return { id, name: id, unlocked: true, stamina_cost: stamina, duration_seconds: 60, produce_quantity: quantity,
        item: { item_id: itemId, name: itemId, sell_price: 10 },
        inputs: Object.entries(inputs).map(([item_id, quantity]) => ({ item_id, quantity, item: { item_id, name: item_id } })) };
}
function station(id, recipes) {
    return { station_id: id, definition: { name: id }, recipes, empty: true, ready: false, assigned_partner_ids: [] };
}
function setup({ recipes, stations = [station('kitchen', recipes)], items = {}, stamina, reserve = 0, times = 1, batchLimit = 10, cap = 100 }) {
    const state = fixture();
    Object.assign(state.player, { stamina, stamina_cap: cap, stamina_restore_seconds: 0 });
    state.inventory = Object.entries(items).map(([item_id, quantity]) => ({ item_id, name: item_id, quantity, quality: 0 }));
    state.crafting_stations = stations;
    const x = attachBackend(auditedHarness(state));
    Object.assign(x.h.CONFIG.crafting, { autoCraftInputs: true, staminaReserve: reserve, batchLimit });
    x.h.setOverride('rlt-node-job:crafting:kitchen', 'meal');
    x.h.setOverride('rlt-craft-lock-times:kitchen', String(times));
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'kitchen'), true);
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
        const match = request.url.match(/\/crafting\/stations\/([^/]+)\/(start|collect)$/);
        assert.ok(match, `unexpected request: ${request.url}`);
        const node = x.backend.crafting_stations.find(row => row.station_id === match[1]);
        assert.ok(node);
        if (match[2] === 'start') {
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
        const outputs = [...(node.completed_results || []), ...(node.task_results || [])];
        if (outputs.length) for (const output of outputs) addItem(output.item_id, output.quantity);
        else addItem(node.recipe.item.item_id, count * node.recipe.produce_quantity);
        Object.assign(node, { empty: true, ready: false, recipe: null, queue_total: 0, queued_count: 0, completed_count: 0,
            collected_count: 0, task_snapshot: null, completed_results: [], task_results: [] });
        return x.response({ completed_count: count });
    });
    x.starts = () => x.calls.filter(request => request.url.endsWith('/start'));
    x.step = async () => {
        x.h.runtime.actionCount = 0;
        x.h.reconcileCraftFlights(x.h.runtime.state);
        await x.h.startEmptyIndustries();
    };
    x.collect = async () => {
        for (const node of x.backend.crafting_stations) if (!node.empty) {
            const remaining = node.completed_count + node.queued_count + (node.task_snapshot && !node.ready ? 1 : 0);
            Object.assign(node, { ready: true, completed_count: remaining, queued_count: 0, task_snapshot: null });
        }
        x.sync(); x.h.runtime.actionCount = 0;
        await x.h.collectReadyIndustries();
        x.h.reconcileCraftFlights(x.h.runtime.state);
    };
    x.drain = async (limit = 12) => {
        for (let index = 0; index < limit; index++) {
            await x.step();
            if (x.backend.crafting_stations.every(node => node.empty)) return;
            await x.collect();
        }
        assert.fail('crafting did not finish in the expected number of submissions');
    };
    return x;
}
const starts = x => x.starts().map(request => [request.payload.recipe_id, request.payload.quantity]);
const basicChain = () => [recipe('meal', { flour: 1 }, 10), recipe('flour', { wheat: 1 }, 5)];
const deepChain = () => [recipe('meal', { mash: 2 }, 7), recipe('mash', { flour: 2 }, 3), recipe('flour', { wheat: 1 }, 2, 3)];
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];
function assertStamina(actual, expected) {
    assert.ok(actual, 'the complete route must expose stamina accounting');
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `stamina.${key}`);
}

test('enough stamina for the first intermediate but not the whole route submits nothing', async () => {
    const x = setup({ recipes: basicChain(), items: { wheat: 1 }, stamina: 14 });
    await x.step();
    assert.equal(x.calls.length, 0);
    assertStamina(x.tree().stamina, { cost: 15, reserve: 0, reserved: 0, required: 15, current: 14, missing: 1 });
});

test('the exact full-route cost plus reserve completes every level and leaves the reserve', async () => {
    const x = setup({ recipes: basicChain(), items: { wheat: 1 }, stamina: 22, reserve: 7 });
    assertStamina(x.tree().stamina, { cost: 15, reserve: 7, required: 22, missing: 0 });
    await x.drain();
    assert.deepEqual(starts(x), [['flour', 1], ['meal', 1]]);
    assert.equal(x.backend.player.stamina, 7);
});

test('the configured reserve is included once before any intermediate is submitted', async () => {
    const x = setup({ recipes: basicChain(), items: { wheat: 1 }, stamina: 21, reserve: 7 });
    await x.step(); assert.equal(x.calls.length, 0);
    assertStamina(x.tree().stamina, { cost: 15, reserve: 7, required: 22, missing: 1 });
});

test('multiple levels include recipe quantities and ceil-rounded intermediate batches', async () => {
    const x = setup({ recipes: deepChain(), items: { wheat: 2 }, stamina: 16 });
    await x.step(); assert.equal(x.calls.length, 0);
    const tree = x.tree();
    assertStamina(tree.stamina, { cost: 17, required: 17, missing: 1 });
    assert.deepEqual(flatten(tree.root).filter(row => row.kind === 'recipe').map(row => [row.name, row.required, row.stamina]),
        [['meal', 1, 7], ['mash', 2, 6], ['flour', 2, 4]]);
    assert.ok(flatten(tree.root).some(row => row.kind === 'material' && row.name === 'wheat'), 'the leaf remains visible when stamina is insufficient');
});

test('the full multi-level route completes at the exact rounded cost', async () => {
    const x = setup({ recipes: deepChain(), items: { wheat: 2 }, stamina: 17 });
    await x.drain();
    assert.deepEqual(starts(x), [['flour', 2], ['mash', 2], ['meal', 1]]);
    assert.equal(x.backend.player.stamina, 0);
});

test('a finite root waits for the entire route and reserve before submitting any partial batch', async () => {
    const x = setup({ recipes: [recipe('meal', { flour: 1 }, 3), recipe('flour', { wheat: 1 }, 2)], items: { wheat: 4 }, stamina: 11, reserve: 1, times: 4 });
    assert.equal(x.tree().quantity, 4);
    assertStamina(x.tree().stamina, { cost: 20, reserve: 1, required: 21, missing: 10 });
    await x.step(); assert.equal(x.calls.length, 0);
    x.backend.player.stamina = 21; x.sync();
    await x.drain();
    assert.deepEqual(starts(x), [['flour', 4], ['meal', 4]]);
    assert.equal(x.backend.player.stamina, 1);
    assert.equal(x.h.craftPipelineProgress('kitchen', x.h.configuredCraftSteps('kitchen')).done[0], 4);
});

test('existing intermediate stock only incurs stamina for the actual shortage and root', async () => {
    const x = setup({ recipes: [recipe('meal', { flour: 3 }, 7), recipe('flour', { wheat: 1 }, 10)], items: { flour: 2, wheat: 1 }, stamina: 17 });
    assertStamina(x.tree().stamina, { cost: 17, required: 17, missing: 0 });
    await x.drain(); assert.deepEqual(starts(x), [['flour', 1], ['meal', 1]]);
    assert.equal(x.backend.player.stamina, 0);
});

test('a fully stocked root only pays its own recipe stamina', async () => {
    const x = setup({ recipes: [recipe('meal', { flour: 3 }, 7), recipe('flour', { wheat: 1 }, 10)], items: { flour: 3 }, stamina: 7 });
    assertStamina(x.tree().stamina, { cost: 7, required: 7, missing: 0 });
    await x.drain(); assert.deepEqual(starts(x), [['meal', 1]]);
});

for (const ready of [false, true]) {
    test(`${ready ? 'completed' : 'in-flight'} intermediates have already paid their stamina`, async () => {
        const flour = recipe('flour', { wheat: 1 }, 50);
        const mill = station('mill', [flour]);
        Object.assign(mill, { empty: false, ready, recipe: flour, queue_total: 2, queued_count: ready ? 0 : 1,
            completed_count: ready ? 2 : 0, collected_count: 0,
            task_snapshot: ready ? null : { recipe_id: 'flour', recipe: flour, ready_at: Math.floor(Date.now() / 1000) + 60 } });
        const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 3 }, 7)]), mill], items: { flour: 1 }, stamina: 7 });
        assertStamina(x.tree().stamina, { cost: 7, required: 7, missing: 0 });
        await x.step(); assert.equal(x.calls.length, 0);
        await x.collect(); await x.drain();
        assert.deepEqual(starts(x), [['meal', 1]]);
        assert.equal(x.backend.player.stamina, 0);
    });
}

test('making additional protected intermediate stock is included in the stamina total', async () => {
    const x = setup({ recipes: [recipe('meal', { flour: 1 }, 3), recipe('flour', { wheat: 1 }, 2)], items: { wheat: 2 }, stamina: 6 });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, delivered: 0, min_quality: 0 }] }];
    x.sync(); await x.step(); assert.equal(x.calls.length, 0);
    assertStamina(x.tree().stamina, { cost: 7, required: 7, missing: 1 });
});

test('stamina failure backtracks to a cheaper valid alternative recipe', async () => {
    const x = setup({ recipes: [recipe('meal', { flour: 1 }, 5), recipe('expensive-flour', { wheat: 1 }, 20, 1, 'flour'), recipe('cheap-flour', { corn: 1 }, 2, 1, 'flour')], items: { wheat: 1, corn: 1 }, stamina: 7 });
    assertStamina(x.tree().stamina, { cost: 7, required: 7, missing: 0 });
    await x.drain();
    assert.deepEqual(starts(x), [['cheap-flour', 1], ['meal', 1]]);
    assert.equal(x.backend.inventory.find(item => item.item_id === 'wheat').quantity, 1);
});

test('different roots share one stamina budget for all their unpaid work', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 }, 5)]), station('bakery', [recipe('bread', { corn: 1 }, 5)]), station('mill', [recipe('flour', { wheat: 1 }, 5)])], items: { wheat: 1, corn: 1 }, stamina: 10 });
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread'); x.h.setOverride('rlt-craft-lock-times:bakery', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'bakery'), true);
    assertStamina(x.tree('bakery').stamina, { cost: 5, reserved: 10, required: 15, current: 10, missing: 5 });
    await x.drain();
    assert.deepEqual(starts(x), [['flour', 1], ['meal', 1]]);
    assert.equal(x.backend.inventory.find(item => item.item_id === 'corn').quantity, 1);
});

test('shared planned output does not charge the same producer twice across roots', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 }, 5)]), station('bakery', [recipe('bread', { flour: 1 }, 6)]), station('mill', [recipe('flour', { wheat: 1 }, 4, 2)])], items: { wheat: 1 }, stamina: 15 });
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread'); x.h.setOverride('rlt-craft-lock-times:bakery', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'bakery'), true);
    assertStamina(x.tree('bakery').stamina, { cost: 6, reserved: 9, required: 15, current: 15, missing: 0 });
    await x.drain();
    assert.deepEqual(starts(x), [['flour', 1], ['meal', 1], ['bread', 1]]);
    assert.equal(x.backend.player.stamina, 0);
});

test('refresh resumes using only the route stamina that remains unpaid', async () => {
    const x = setup({ recipes: basicChain(), items: { wheat: 1 }, stamina: 15 });
    await x.step(); assert.deepEqual(starts(x), [['flour', 1]]);
    const y = attachBackend(auditedHarness(structuredClone(x.backend), [...x.storage]));
    assertStamina(y.tree().stamina, { cost: 10, required: 10, current: 10, missing: 0 });
    await y.step(); assert.equal(y.calls.length, 0);
    await y.collect(); await y.drain();
    assert.deepEqual(starts(y), [['meal', 1]]);
});

test('stamina above the ordinary cap can fund a complete route', async () => {
    const x = setup({ recipes: deepChain(), items: { wheat: 2 }, stamina: 17, cap: 10 });
    assertStamina(x.tree().stamina, { required: 17, current: 17, missing: 0 });
    await x.drain(); assert.equal(x.backend.player.stamina, 0);
});

test('a single route that exceeds the cap does not begin a partial chain', async () => {
    const x = setup({ recipes: deepChain(), items: { wheat: 2 }, stamina: 10, cap: 10 });
    await x.step(); assert.equal(x.calls.length, 0);
    assertStamina(x.tree().stamina, { cost: 17, current: 10, required: 17, missing: 7 });
    assert.equal(flatten(x.tree().root).filter(row => row.kind === 'recipe').length, 3);
});

test('zero-stamina recipes remain usable when the full route costs zero', async () => {
    const x = setup({ recipes: [recipe('meal', { flour: 1 }, 0), recipe('flour', { wheat: 1 }, 0)], items: { wheat: 1 }, stamina: 0 });
    assertStamina(x.tree().stamina, { cost: 0, required: 0, missing: 0 });
    await x.drain(); assert.deepEqual(starts(x), [['flour', 1], ['meal', 1]]);
});

test('a paused material tree still displays every recipe and its complete stamina requirement', () => {
    const x = setup({ recipes: deepChain(), items: { wheat: 2 }, stamina: 1, reserve: 3 });
    x.h.CONFIG.crafting.enabled = false;
    const tree = x.tree();
    assert.equal(tree.preview, true);
    assertStamina(tree.stamina, { cost: 17, reserve: 3, required: 20, current: 1, missing: 19 });
    assert.deepEqual(flatten(tree.root).filter(row => row.kind === 'recipe').map(row => row.name), ['meal', 'mash', 'flour']);
    assert.equal(x.schedule().plans.size, 0);
    assert.equal(x.calls.length, 0);
});

test('submission rechecks the whole-route threshold if stamina changed after planning', async () => {
    const x = setup({ recipes: basicChain(), items: { wheat: 1 }, stamina: 15 });
    const plan = x.schedule().plans.get('kitchen');
    assert.ok(plan);
    assert.equal(plan.requiredStamina, 15);
    x.backend.player.stamina = 14; x.sync();
    await x.h.startCraftPlan(plan);
    assert.equal(x.calls.length, 0);
});

test('natural stamina recovery invalidates a cached blocked route without replacing the state object', () => {
    const x = setup({ recipes: basicChain(), items: { wheat: 1 }, stamina: 14 });
    x.backend.player.stamina_restore_seconds = 60; x.sync();
    const state = x.h.runtime.state, blocked = x.schedule();
    assert.equal(blocked.plans.size, 0);
    assertStamina(x.tree().stamina, { current: 14, missing: 1 });
    // Advance the synchronized server clock by one recovery interval, keeping the authoritative snapshot unchanged.
    x.h.runtime.serverMsAtSync += 60000;
    const recovered = x.schedule();
    assert.equal(x.h.runtime.state, state);
    assert.notEqual(recovered, blocked);
    assert.ok(recovered.plans.has('kitchen'));
    assertStamina(x.tree().stamina, { current: 15, missing: 0, required: 15 });
    assert.equal(x.calls.length, 0);
});

test('stamina diagnostics and paused-route previews do not alter runtime, storage, or inventory', () => {
    const x = setup({ recipes: deepChain(), items: { wheat: 2 }, stamina: 1, reserve: 3 });
    x.h.CONFIG.crafting.enabled = false;
    const runtimeBefore = JSON.stringify(x.h.runtime), storedBefore = [...x.storage], logCount = x.h.logBox.children.length;
    const tree = x.tree();
    assertStamina(tree.stamina, { cost: 17, required: 20, current: 1, missing: 19 });
    assert.equal(JSON.stringify(x.h.runtime), runtimeBefore);
    assert.deepEqual([...x.storage], storedBefore);
    assert.equal(x.h.logBox.children.length, logCount);
    assert.equal(x.calls.length, 0);
});

test('a materially feasible route waiting only for stamina still protects its raw inventory', async () => {
    const x = setup({ recipes: [recipe('meal', { flour: 10 }, 10), recipe('flour', { wheat: 1 }, 5)], items: { wheat: 10 }, stamina: 59 });
    assertStamina(x.tree().stamina, { cost: 60, current: 59, required: 60, missing: 1 });
    assert.equal(x.h.craftingInputReserves(x.h.runtime.state).get('wheat'), 10);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wheat'), 0, 'feeding, selling and other consumers must preserve the waiting route materials');
    await x.step();
    assert.equal(x.calls.length, 0, 'protecting materials must not submit an unaffordable route');
});

test('an unaffordable route protects external inventory without blocking a feasible second production root', async () => {
    const x = setup({ stations: [
        station('kitchen', [recipe('meal', { flour: 10 }, 10)]),
        station('bakery', [recipe('bread', { wheat: 2 }, 2)]),
        station('mill', [recipe('flour', { wheat: 1 }, 5)]),
    ], items: { wheat: 10 }, stamina: 59 });
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread');
    x.h.setOverride('rlt-craft-lock-times:bakery', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'bakery'), true);
    assertStamina(x.tree('bakery').stamina, { cost: 2, reserved: 0, required: 2, current: 59, missing: 0 });
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wheat'), 0);
    await x.drain();
    assert.deepEqual(starts(x), [['bread', 1]]);
    assert.equal(x.backend.inventory.find(item => item.item_id === 'wheat').quantity, 8);
    assert.equal(x.backend.inventory.find(item => item.item_id === 'bread').quantity, 1);
});
