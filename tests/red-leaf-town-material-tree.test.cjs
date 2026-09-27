const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function treeHarness(state) {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        const source = originalRead.call(this, filename, ...args);
        return filename === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            'window.__materialTreeAudit = { craftMaterialTree, craftProductionSchedule }; if (CONFIG.ui.autoStart) start();') : source;
    };
    try {
        const x = harness(state);
        x.tree = (stationId = 'kitchen') => x.context.window.__materialTreeAudit.craftMaterialTree(
            x.h.runtime.state, x.h.runtime.state.crafting_stations.find(node => node.station_id === stationId));
        x.schedule = () => x.context.window.__materialTreeAudit.craftProductionSchedule(x.h.runtime.state);
        return x;
    } finally { fs.readFileSync = originalRead; }
}
function recipe(id, inputs, produceQuantity = 1, extra = {}) {
    return { id, name: id, unlocked: true, stamina_cost: 1, duration_seconds: 60, produce_quantity: produceQuantity,
        item: { item_id: id, name: id, sell_price: 10 },
        inputs: Object.entries(inputs).map(([item_id, quantity]) => ({ item_id, quantity, item: { item_id, name: item_id } })), ...extra };
}
function station(id, recipes, extra = {}) {
    return { station_id: id, definition: { name: id }, empty: true, ready: false, recipes, assigned_partner_ids: [], ...extra };
}
function setup({ jobs, items = {}, stations = null, times = 1, batchLimit = 10 }) {
    const state = fixture();
    state.inventory = Object.entries(items).map(([item_id, quantity]) => ({ item_id, name: item_id, quantity, quality: 0 }));
    state.crafting_stations = stations || [station('kitchen', jobs)];
    const x = treeHarness(state);
    x.h.CONFIG.crafting.autoCraftInputs = true;
    x.h.CONFIG.crafting.batchLimit = batchLimit;
    x.h.setOverride('rlt-node-job:crafting:kitchen', 'meal');
    x.h.setOverride('rlt-craft-lock-times:kitchen', String(times));
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'kitchen'), true);
    x.setResponder(request => {
        const match = request.url.match(/\/crafting\/stations\/([^/]+)\/start$/);
        assert.ok(match, `unexpected request: ${request.url}`);
        const node = x.backend.crafting_stations.find(row => row.station_id === match[1]);
        assert.equal(node.empty, true);
        const job = node.recipes.find(row => row.id === request.payload.recipe_id), count = request.payload.quantity;
        for (const input of job.inputs) {
            const item = x.backend.inventory.find(row => row.item_id === input.item_id);
            assert.ok(item && item.quantity >= input.quantity * count);
            item.quantity -= input.quantity * count;
        }
        Object.assign(node, { empty: false, recipe: job, queue_total: count, queued_count: count - 1,
            completed_count: 0, collected_count: 0, task_snapshot: { recipe_id: job.id, ready_at: state.server_time + 60 } });
        return x.response();
    });
    return x;
}
function flatten(root) { return root ? [root, ...(root.children || []).flatMap(flatten)] : []; }
function find(tree, kind, name) {
    const result = flatten(tree.root).find(node => node.kind === kind && node.name === name);
    assert.ok(result, `missing ${kind} ${name} in ${JSON.stringify(tree)}`);
    return result;
}
function signature(x) {
    return JSON.stringify({ storage: [...x.storage], runtime: x.h.runtime, calls: x.calls,
        progress: x.h.craftPipelineProgress('kitchen', x.h.configuredCraftSteps('kitchen')) });
}

test('material tree follows all levels and the quantity multipliers selected by the real planner', () => {
    const x = setup({ jobs: [recipe('meal', { mash: 1 }), recipe('mash', { flour: 2 }), recipe('flour', { wheat: 1 }, 2)],
        items: { wheat: 2 }, times: 2 });
    const tree = x.tree();
    assert.equal(tree.quantity, 2);
    assert.equal(tree.root.kind, 'recipe');
    assert.equal(tree.root.required, 2);
    assert.equal(find(tree, 'material', 'mash').required, 2);
    assert.equal(find(tree, 'recipe', 'mash').required, 2);
    assert.equal(find(tree, 'material', 'flour').required, 4);
    assert.equal(find(tree, 'recipe', 'flour').required, 2);
    assert.equal(find(tree, 'material', 'wheat').available, 2);
    assert.equal(find(tree, 'material', 'flour').missing, 4, 'a feasible child still represents material that needs production');
});

test('a finite root displays the complete material shortage without hiding it behind a smaller batch', () => {
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })], items: { wheat: 2 }, times: 5 });
    const tree = x.tree();
    assert.equal(tree.quantity, 5);
    assert.equal(tree.status, 'blocked');
    assert.equal(find(tree, 'material', 'wheat').required, 5);
    assert.equal(find(tree, 'material', 'wheat').missing, 3);
});

test('successful sibling backtracking removes the rejected producer from the material tree', async () => {
    const x = setup({ jobs: [recipe('meal', { a: 1, b: 1 }),
        recipe('a-wheat', { wheat: 1 }, 1, { item: { item_id: 'a', name: 'a' } }),
        recipe('a-corn', { corn: 1 }, 1, { item: { item_id: 'a', name: 'a' } }), recipe('b', { wheat: 1 })],
    items: { wheat: 1, corn: 1 } });
    const tree = x.tree();
    find(tree, 'recipe', 'a-corn');
    assert.equal(flatten(tree.root).some(node => node.kind === 'recipe' && node.name === 'a-wheat'), false);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls[0].payload.recipe_id, 'a-corn');
});

test('branches display shared actual stock and the previously planned surplus only once', () => {
    const x = setup({ jobs: [recipe('meal', { paste: 1, batter: 1 }), recipe('paste', { flour: 2 }),
        recipe('batter', { flour: 1 }), recipe('flour', { wheat: 1 }, 2)], items: { flour: 1, wheat: 1 } });
    const tree = x.tree(), flourRows = flatten(tree.root).filter(node => node.kind === 'material' && node.name === 'flour');
    assert.equal(flourRows.length, 2);
    assert.equal(flourRows.reduce((sum, node) => sum + node.available, 0), 1);
    assert.equal(flourRows.reduce((sum, node) => sum + node.planned, 0), 1);
    assert.equal(flatten(tree.root).filter(node => node.kind === 'material' && node.name === 'wheat').reduce((sum, node) => sum + node.available, 0), 1);
});

test('separate root trees share the same actual allocation ledger as execution', () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { wheat: 1 })]),
        station('bakery', [recipe('bread', { wheat: 1 })])], items: { wheat: 1 } });
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread');
    x.h.setOverride('rlt-craft-lock-times:bakery', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'bakery'), true);
    const first = find(x.tree(), 'material', 'wheat'), second = find(x.tree('bakery'), 'material', 'wheat');
    assert.equal(first.available, 1);
    assert.equal(second.available, 0);
    assert.equal(second.otherAllocated, 1);
    assert.equal(second.missing, 1);
});

test('a blocked tree reports all missing basic materials for the finite goal without submitting anything', async () => {
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 2 })], times: 5 });
    const tree = x.tree(), leaf = find(tree, 'material', 'wheat');
    assert.equal(tree.quantity, 5);
    assert.equal(leaf.required, 10);
    assert.equal(leaf.missing, 10);
    assert.ok(leaf.statusLabel || leaf.note);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 0);
});

test('cycle and locked-producer blocking remain visible without unbounded expansion', () => {
    for (const jobs of [[recipe('meal', { a: 1 }), recipe('a', { b: 1 }), recipe('b', { a: 1 })],
        [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 }, 1, { unlocked: false })]]) {
        const x = setup({ jobs, items: { wheat: 5 } });
        const tree = x.tree();
        assert.ok(tree.root);
        assert.ok(flatten(tree.root).some(node => node.kind === 'material' && node.missing > 0));
        assert.ok(flatten(tree.root).length < 20);
        assert.equal(x.calls.length, 0);
    }
});

test('real pending output is allocated without displaying a duplicate production recipe', () => {
    const flour = recipe('flour', { wheat: 1 });
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 3 })]), station('mill', [flour], {
        empty: false, recipe: flour, queue_total: 3, queued_count: 2, completed_count: 0, collected_count: 0,
        task_snapshot: { recipe_id: 'flour', ready_at: 123 },
    })], items: { wheat: 10 } });
    const tree = x.tree(), row = find(tree, 'material', 'flour');
    assert.equal(row.pending, 3);
    assert.equal(row.missing, 0);
    assert.equal(flatten(tree.root).some(node => node.kind === 'recipe' && node.name === 'flour'), false);
});

test('cancelled queue totals never conceal the remaining material shortage in the tree', () => {
    const flour = recipe('flour', { wheat: 1 });
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 3 })]), station('mill', [flour], {
        empty: false, ready: true, recipe: flour, queue_total: 10, queued_count: 0, completed_count: 2, collected_count: 0,
        task_snapshot: null,
    })] });
    const row = find(x.tree(), 'material', 'flour');
    assert.equal(row.pending, 2);
    assert.equal(row.missing, 1);
});

test('protected inventory and its demand details are separate from allocated usable stock', () => {
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })], items: { flour: 1, wheat: 1 } });
    x.backend.portals = [{ name: 'Wheat gate', unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, min_quality: 0 }] }];
    x.sync();
    const tree = x.tree(), flour = find(tree, 'material', 'flour');
    assert.equal(flour.stock, 1);
    assert.equal(flour.protected, 1);
    assert.equal(flour.available, 0);
    assert.ok(flour.protections.some(row => row.quantity === 1 && row.minQuality === 0));
    assert.equal(find(tree, 'recipe', 'flour').required, 1);
});

test('protected debt appears in the extra intermediate production rather than inflating root requirements', () => {
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })], items: { wheat: 2 } });
    x.backend.portals = [{ name: 'Gate', unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, min_quality: 0 }] }];
    x.sync();
    const tree = x.tree();
    assert.equal(find(tree, 'material', 'flour').required, 1);
    assert.equal(find(tree, 'recipe', 'flour').required, 2);
    assert.equal(find(tree, 'material', 'wheat').required, 2);
});

test('high-quality protection blocking is shown without inventing ordinary production as a solution', () => {
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })], items: { wheat: 5 } });
    x.backend.portals = [{ name: 'Quality gate', unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, min_quality: 3 }] }];
    x.sync();
    const row = find(x.tree(), 'material', 'flour');
    assert.equal(row.missing, 1);
    assert.ok(row.protections.some(need => need.minQuality === 3));
    assert.equal((row.children || []).length, 0);
});

test('disabled and paused target previews do not alter settings, journals, progress, runtime or network activity', async () => {
    for (const pause of ['enabled', 'autoStart', 'station', 'pipeline']) {
        const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })], items: { wheat: 1 } });
        if (pause === 'station') x.h.stopCraftRun('kitchen');
        else if (pause === 'pipeline') {
            x.h.setOverride('rlt-node-job:crafting:kitchen', '');
            x.h.setOverride('rlt-craft-pipe:kitchen', JSON.stringify([{ recipeId: 'meal', times: 1 }]));
            x.h.stopCraftRun('kitchen');
        } else x.h.CONFIG.crafting[pause] = false;
        const before = signature(x), tree = x.tree();
        assert.equal(tree.preview, true, pause);
        find(tree, 'recipe', 'flour');
        assert.deepEqual(x.tree(), tree);
        assert.equal(signature(x), before, pause);
        await x.h.startEmptyIndustries();
        assert.equal(x.calls.length, 0, pause);
    }
});

test('preview cannot borrow an explicitly closed helper station or contaminate resumed real planning', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]), station('mill', [recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    x.h.stopCraftRun('kitchen');
    x.h.setOverride('rlt-node-job:crafting:mill', '__off');
    const blocked = x.tree();
    assert.equal(find(blocked, 'material', 'flour').missing, 1);
    assert.equal(find(blocked, 'recipe', 'flour').status, 'blocked');
    assert.match(find(blocked, 'recipe', 'flour').note, /mill.*关闭/);
    assert.equal(find(blocked, 'material', 'wheat').available, 1);
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'kitchen'), true);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 0);
    x.h.setOverride('rlt-node-job:crafting:mill', '');
    const resumed = x.tree();
    assert.equal(resumed.preview, false);
    find(resumed, 'recipe', 'flour');
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 1);
    assert.equal(x.calls[0].payload.recipe_id, 'flour');
});

test('unavailable stations still show deeper recipes and every sibling without writing or reserving inventory', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1, brine: 1 }), recipe('brine', { wheat: 1, water: 1 })]),
        station('mill', [recipe('flour', { grain: 1 })]), station('grinder', [recipe('grain', { wheat: 1, corn: 1 })])],
    items: { wheat: 1, water: 1 } });
    x.h.setOverride('rlt-node-job:crafting:mill', '__off_keep');
    x.h.setOverride('rlt-node-job:crafting:grinder', '__off');
    const before = signature(x), tree = x.tree(), rows = flatten(tree.root);
    assert.match(find(tree, 'recipe', 'flour').note, /mill.*关闭/);
    assert.match(find(tree, 'recipe', 'grain').note, /grinder.*关闭/);
    assert.equal(find(tree, 'material', 'corn').status, 'blocked');
    assert.equal(find(tree, 'material', 'water').available, 1, 'later siblings are checked after an earlier missing raw material');
    assert.equal(rows.filter(row => row.kind === 'material' && row.name === 'wheat').reduce((sum, row) => sum + row.available, 0), 1);
    assert.equal(rows.some(row => row.status === 'unchecked'), false);
    assert.equal(x.schedule().rootReserves.has('kitchen'), false);
    assert.equal(x.schedule().reserves.size, 0);
    assert.equal(x.schedule().plans.size, 0);
    assert.equal(signature(x), before);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 0);
});

test('an idle station with its own configured goal exposes its recipe route while remaining unavailable to borrow', () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]),
        station('mill', [recipe('flour', { wheat: 1 }), recipe('other', { stone: 1 })])], items: { wheat: 1 } });
    x.h.setOverride('rlt-node-job:crafting:mill', 'other');
    const tree = x.tree();
    assert.match(tree.statusLabel, /mill.*锁定/);
    assert.match(find(tree, 'recipe', 'flour').note, /mill.*锁定/);
    assert.equal(find(tree, 'material', 'wheat').available, 1);
    assert.equal(x.schedule().plans.size, 0);
    assert.equal(x.schedule().rootReserves.has('kitchen'), false);
});

test('diagnostic allocations do not steal raw materials from another executable target', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]),
        station('mill', [recipe('flour', { wheat: 1 })]), station('bakery', [recipe('bread', { wheat: 1 })])], items: { wheat: 1 } });
    x.h.setOverride('rlt-node-job:crafting:mill', '__off');
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread');
    x.h.setOverride('rlt-craft-lock-times:bakery', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'bakery'), true);
    assert.equal(find(x.tree(), 'material', 'wheat').available, 1);
    assert.equal(find(x.tree('bakery'), 'material', 'wheat').available, 1);
    assert.equal(x.schedule().rootReserves.has('kitchen'), false);
    assert.equal(x.schedule().reserves.get('wheat'), 1);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 1);
    assert.equal(x.calls[0].payload.recipe_id, 'bread');
});

test('an executable recipe remains preferred over a diagnostic route with a closed station', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]),
        station('closed-mill', [recipe('closed-flour', { wheat: 1 }, 1, { item: { item_id: 'flour', name: 'flour' } })]),
        station('free-mill', [recipe('free-flour', { wheat: 1 }, 1, { item: { item_id: 'flour', name: 'flour' } })])], items: { wheat: 1 } });
    x.h.setOverride('rlt-node-job:crafting:closed-mill', '__off');
    const tree = x.tree();
    find(tree, 'recipe', 'free-flour');
    assert.equal(flatten(tree.root).some(row => row.name === 'closed-flour'), false);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls[0].payload.recipe_id, 'free-flour');
});

test('locked recipes reveal their ingredients without implying they can be submitted', async () => {
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 }, 1, { unlocked: false })], items: { wheat: 1 } });
    const tree = x.tree();
    assert.match(find(tree, 'recipe', 'flour').note, /尚未解锁/);
    assert.equal(find(tree, 'material', 'wheat').available, 1);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 0);
});

test('missing output metadata is distinguished from an uncraftable basic material without guessing IDs', async () => {
    for (const broken of [recipe('flour', { wheat: 1 }, 0), recipe('flour', { wheat: 1 }, 1, { item: { name: 'flour' } })]) {
        const x = setup({ jobs: [recipe('meal', { flour: 1 }), broken], items: { wheat: 1 } });
        const tree = x.tree();
        assert.match(find(tree, 'material', 'flour').note, /产物.*不完整/);
        assert.equal(flatten(tree.root).some(row => row.kind === 'recipe' && row.name === 'flour'), false);
        await x.h.startEmptyIndustries();
        assert.equal(x.calls.length, 0);
    }
});

test('running root tree explains reservation of its unsubmitted remainder without executing its helper plan', async () => {
    const meal = recipe('meal', { flour: 1 }), flour = recipe('flour', { wheat: 1 });
    const x = setup({ stations: [station('kitchen', [meal]), station('mill', [flour])],
    items: { wheat: 1 }, times: 2, batchLimit: 1 });
    Object.assign(x.backend.crafting_stations[0], { empty: false, recipe: meal, queue_total: 1, queued_count: 0,
        completed_count: 0, collected_count: 0, task_snapshot: { recipe_id: 'meal', ready_at: 123 } });
    x.sync();
    x.h.saveCraftFlight('kitchen', { phase: 'active', recipeId: 'meal', quantity: 1, credited: 0, observedCollected: 0,
        runId: x.h.craftRun('kitchen').id, steps: [{ recipeId: 'meal', times: 2, taskItemId: '' }], stepIndex: 0 });
    const tree = x.tree();
    assert.ok(tree.note, 'running queue trees explain that this is a future reservation');
    find(tree, 'recipe', 'flour');
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 0);
});

test('missing, completed, and unavailable goals provide a message without guessing a recipe', () => {
    for (const condition of ['none', 'closed', 'complete', 'locked']) {
        const x = setup({ jobs: [recipe('meal', { wheat: 1 })], items: { wheat: 1 } });
        if (condition === 'none') x.h.setOverride('rlt-node-job:crafting:kitchen', '');
        if (condition === 'closed') x.h.setOverride('rlt-node-job:crafting:kitchen', '__off');
        if (condition === 'complete') {
            x.h.saveCraftFlight('kitchen', { phase: 'active', quantity: 1, credited: 0, observedCollected: 0,
                runId: x.h.craftRun('kitchen').id, recipeId: 'meal', steps: [{ recipeId: 'meal', times: 1, taskItemId: '' }], stepIndex: 0 });
            x.h.creditCraftFlight('kitchen', 1); x.h.saveCraftFlight('kitchen', null);
        }
        if (condition === 'locked') { x.backend.crafting_stations[0].recipes[0].unlocked = false; x.sync(); }
        const tree = x.tree();
        assert.equal(tree.root, null, condition);
        assert.ok(tree.statusLabel || tree.note, condition);
        assert.equal(x.calls.length, 0);
    }
});

test('inventory refresh and configuration changes recompute tree quantities without retaining stale traces', () => {
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })], items: { wheat: 1 }, times: 2 });
    assert.equal(x.tree().quantity, 2);
    assert.equal(x.tree().status, 'blocked');
    assert.equal(find(x.tree(), 'material', 'wheat').missing, 1);
    x.backend.inventory[0].quantity = 2; x.sync();
    assert.equal(x.tree().quantity, 2);
    assert.equal(find(x.tree(), 'material', 'wheat').missing, 0);
    x.h.CONFIG.crafting.batchLimit = 1;
    assert.equal(x.tree().quantity, 2, 'submission limits do not change a finite goal');
    assert.equal(x.tree().goal.batchLimit, 1);
    x.h.setOverride('rlt-craft-lock-times:kitchen', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'kitchen'), true);
    assert.equal(x.tree().quantity, 1);
    assert.equal(find(x.tree(), 'material', 'wheat').required, 1);
});

test('the material tree truncates a broad recipe explicitly without limiting actual production', async () => {
    const inputs = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`raw${i}`, 1]));
    const x = setup({ jobs: [recipe('meal', inputs)], items: inputs });
    const tree = x.tree();
    assert.ok(flatten(tree.root).length <= 161);
    assert.match([tree.note, ...flatten(tree.root).map(node => node.note)].join(' '), /截断|省略|上限|过多/);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 1);
    assert.equal(x.calls[0].payload.recipe_id, 'meal');
});

test('a newly authorized smaller target discards the rejected oversized trace', () => {
    const broadInputs = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`raw${i}`, 1]));
    const x = setup({ jobs: [recipe('meal', { flour: 1 }), recipe('flour', broadInputs)], items: { flour: 1 }, times: 2, batchLimit: 2 });
    assert.equal(x.tree().status, 'blocked');
    assert.match(x.tree().note, /截断|省略|160/);
    x.h.setOverride('rlt-craft-lock-times:kitchen', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'kitchen'), true);
    const tree = x.tree();
    assert.equal(tree.quantity, 1);
    assert.equal(tree.status, 'ready');
    assert.equal(flatten(tree.root).length, 2);
    assert.equal(find(tree, 'material', 'flour').available, 1);
    assert.doesNotMatch(tree.note, /截断|省略|160/);
});

test('a blocked leaf outside the trace cap still has its reason in the top-level status', () => {
    const inputs = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`raw${i}`, 1]));
    const items = { ...inputs }; delete items.raw179;
    const x = setup({ jobs: [recipe('meal', inputs)], items });
    const tree = x.tree();
    assert.equal(tree.status, 'blocked');
    assert.equal(tree.root.status, 'blocked');
    assert.equal(flatten(tree.root).some(node => node.name === 'raw179'), false);
    assert.match(tree.statusLabel, /raw179/);
    assert.match(tree.note, /省略|截断/);
    assert.equal(x.calls.length, 0);
});

test('hitting the search complexity cap reports the actual attempted batch and retains the stop reason', () => {
    const jobs = [recipe('meal', { level0: 1 })];
    // Each alternative fails at the bottom; branching exhausts the search budget for the finite target.
    for (let level = 0; level < 14; level++) for (const variant of ['a', 'b']) {
        jobs.push(recipe(`level${level}-${variant}`, { [`level${level + 1}`]: 1 }, 1,
            { item: { item_id: `level${level}`, name: `level${level}` } }));
    }
    const x = setup({ jobs, times: 5, batchLimit: 5 });
    const tree = x.tree();
    assert.equal(tree.status, 'blocked');
    assert.equal(tree.quantity, 5, 'the complexity guard retains the complete finite target');
    assert.equal(tree.root.status, 'blocked');
    assert.match(tree.note, /按 5 次检查未通过/);
    assert.doesNotMatch(tree.note, /连 1 份|完整材料链/);
    assert.match(tree.statusLabel, /复杂|无效/);
    assert.ok(flatten(tree.root).length <= 161);
    assert.equal(x.calls.length, 0);
});
