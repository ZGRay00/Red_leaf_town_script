const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, harness } = require('./red-leaf-town-v4.test.cjs');

function recipe(id, inputs, produceQuantity = 1, extra = {}) {
    return {
        id, name: id, unlocked: true, stamina_cost: 2, duration_seconds: 60,
        produce_quantity: produceQuantity, item: { item_id: id, name: id, sell_price: 10 },
        inputs: Object.entries(inputs).map(([item_id, quantity]) => ({ item_id, quantity, item: { item_id, name: item_id } })),
        ...extra,
    };
}
function station(id, recipes) {
    return { station_id: id, definition: { name: id }, empty: true, ready: false, recipes, assigned_partner_ids: [] };
}
function inventory(items) {
    return Object.entries(items).map(([item_id, quantity]) => ({ item_id, name: item_id, quantity, quality: 0 }));
}
function setup({ stations, items = {}, rootStation = 'kitchen', rootRecipe = 'meal', times = 1, batchLimit = 10, entries = [] }) {
    const state = fixture();
    state.inventory = inventory(items);
    state.crafting_stations = stations;
    const x = harness(state, entries);
    x.h.CONFIG.crafting.autoCraftInputs = true;
    x.h.CONFIG.crafting.batchLimit = batchLimit;
    x.h.setOverride(`rlt-node-job:crafting:${rootStation}`, rootRecipe);
    x.h.setOverride(`rlt-craft-lock-times:${rootStation}`, String(times));
    attachBackend(x);
    return x;
}
function attachBackend(x) {
    const addItem = (itemId, quantity) => {
        let item = x.backend.inventory.find(row => row.item_id === itemId);
        if (!item) { item = { item_id: itemId, name: itemId, quantity: 0, quality: 0 }; x.backend.inventory.push(item); }
        item.quantity += quantity;
        assert.ok(item.quantity >= 0, `backend refused negative inventory: ${itemId}`);
    };
    x.setResponder(request => {
        const match = request.url.match(/\/crafting\/stations\/([^/]+)\/(start|collect)$/);
        assert.ok(match, `unexpected request: ${request.url}`);
        const node = x.backend.crafting_stations.find(row => row.station_id === match[1]);
        assert.ok(node);
        if (match[2] === 'start') {
            assert.equal(node.empty, true, `cannot replace an active queue: ${node.station_id}`);
            const job = node.recipes.find(row => row.id === request.payload.recipe_id);
            assert.ok(job);
            const quantity = request.payload.quantity;
            assert.ok(Number.isInteger(quantity) && quantity > 0 && quantity <= 99);
            for (const input of job.inputs) addItem(input.item_id, -input.quantity * quantity);
            x.backend.player.stamina -= job.stamina_cost * quantity;
            assert.ok(x.backend.player.stamina >= 0);
            Object.assign(node, {
                empty: false, ready: false, recipe: job, queue_total: quantity, queued_count: quantity - 1,
                completed_count: 0, collected_count: 0,
                task_snapshot: { recipe_id: job.id, recipe: job, started_at: x.backend.server_time, ready_at: x.backend.server_time + 60 },
            });
            return x.response();
        }
        assert.ok(node.completed_count > 0);
        const count = node.completed_count;
        const completedOutputs = [...(node.completed_results || []), ...(node.task_results || [])];
        if (completedOutputs.length) for (const output of completedOutputs) addItem(output.item_id, output.quantity);
        else addItem(node.recipe.item.item_id, count * node.recipe.produce_quantity);
        Object.assign(node, { empty: true, ready: false, recipe: null, task_snapshot: null, queue_total: 0, queued_count: 0, completed_count: 0, collected_count: 0, completed_results: [], task_results: [] });
        return x.response({ completed_count: count });
    });
    x.starts = () => x.calls.filter(request => request.url.endsWith('/start'));
    x.readyAll = () => {
        for (const node of x.backend.crafting_stations) if (!node.empty) {
            Object.assign(node, { ready: true, completed_count: node.queue_total, queued_count: 0, task_snapshot: null });
        }
        x.sync();
    };
    x.step = async () => {
        x.h.runtime.actionCount = 0;
        x.h.reconcileCraftFlights(x.h.runtime.state);
        await x.h.startEmptyIndustries();
    };
    x.collect = async () => {
        x.readyAll();
        x.h.runtime.actionCount = 0;
        await x.h.collectReadyIndustries();
        x.h.reconcileCraftFlights(x.h.runtime.state);
    };
    x.drain = async (limit = 12) => {
        for (let index = 0; index < limit; index++) {
            await x.step();
            if (x.backend.crafting_stations.every(node => node.empty)) return;
            await x.collect();
        }
        assert.fail('dependency chain did not finish within the test limit');
    };
    return x;
}

test('same station recursively crafts every level and only final collection advances the root', async () => {
    const jobs = [recipe('meal', { mash: 1 }), recipe('mash', { flour: 2 }), recipe('flour', { wheat: 1 })];
    const x = setup({ stations: [station('kitchen', jobs)], items: { wheat: 2 } });
    await x.step();
    assert.deepEqual(x.starts().map(row => [row.payload.recipe_id, row.payload.quantity]), [['flour', 2]]);
    assert.equal(x.h.craftFlight('kitchen').steps.length, 0);
    assert.equal(x.h.craftPipelineProgress('kitchen', x.h.configuredCraftSteps('kitchen')).done[0], 0);
    await x.collect(); await x.step();
    assert.equal(x.starts().at(-1).payload.recipe_id, 'mash');
    await x.collect(); await x.step();
    assert.equal(x.starts().at(-1).payload.recipe_id, 'meal');
    assert.equal(x.h.craftPipelineProgress('kitchen', x.h.configuredCraftSteps('kitchen')).done[0], 0);
    await x.collect(); await x.step();
    assert.equal(x.starts().length, 3);
    assert.equal(x.h.craftPipelineProgress('kitchen', x.h.configuredCraftSteps('kitchen')).done[0], 1);
});

test('a missing basic material aborts the entire chain before any sibling is submitted', async () => {
    const jobs = [recipe('meal', { flour: 1, pumpkin: 1 }), recipe('flour', { wheat: 1 })];
    const x = setup({ stations: [station('kitchen', jobs)], items: { wheat: 10 } });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('a missing basic material at the deepest level prevents all crafting', async () => {
    const jobs = [recipe('meal', { mash: 1 }), recipe('mash', { flour: 1 }), recipe('flour', { wheat: 1 })];
    const x = setup({ stations: [station('kitchen', jobs)] });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('cyclic dependency without usable inventory submits nothing', async () => {
    const jobs = [recipe('meal', { a: 1 }), recipe('a', { b: 1 }), recipe('b', { a: 1 })];
    const x = setup({ stations: [station('kitchen', jobs)] });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('available inventory can satisfy an otherwise cyclic recipe without recursing forever', async () => {
    const jobs = [recipe('meal', { a: 1 }), recipe('a', { b: 1 }), recipe('b', { a: 1 })];
    const x = setup({ stations: [station('kitchen', jobs)], items: { a: 1 } });
    await x.step(); assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['meal']);
});

test('locked intermediate recipes cannot be automatically crafted', async () => {
    const jobs = [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 }, 1, { unlocked: false })];
    const x = setup({ stations: [station('kitchen', jobs)], items: { wheat: 10 } });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('one shared basic inventory pool cannot be allocated to two branches', async () => {
    const jobs = [recipe('meal', { a: 1, b: 1 }), recipe('a', { wheat: 1 }), recipe('b', { wheat: 1 })];
    const x = setup({ stations: [station('kitchen', jobs)], items: { wheat: 1 } });
    await x.step(); assert.equal(x.calls.length, 0);
});

test('multi-unit intermediate output rounds up only the actual remaining shortage', async () => {
    const jobs = [recipe('meal', { flour: 5 }), recipe('flour', { wheat: 1 }, 2)];
    const x = setup({ stations: [station('kitchen', jobs)], items: { flour: 2, wheat: 2 } });
    await x.drain();
    assert.deepEqual(x.starts().map(row => [row.payload.recipe_id, row.payload.quantity]), [['flour', 2], ['meal', 1]]);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'flour').quantity, 1);
});

test('branches share existing and newly produced intermediate stock without double allocation', async () => {
    const jobs = [recipe('meal', { paste: 1, batter: 1 }), recipe('paste', { flour: 2 }), recipe('batter', { flour: 1 }), recipe('flour', { wheat: 1 }, 2)];
    const x = setup({ stations: [station('kitchen', jobs)], items: { flour: 1, wheat: 1 } });
    await x.drain();
    assert.equal(x.starts().filter(row => row.payload.recipe_id === 'flour').reduce((sum, row) => sum + row.payload.quantity, 0), 1);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'meal').quantity, 1);
});

test('an unconfigured idle station can supply another station without gaining root progress', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]), station('mill', [recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    await x.step();
    assert.equal(x.starts()[0].url.endsWith('/mill/start'), true);
    assert.equal(x.h.craftFlight('mill').steps.length, 0);
    assert.equal(x.h.getOverride('rlt-node-job:crafting:mill'), null);
    await x.collect(); await x.step();
    assert.equal(x.starts().at(-1).url.endsWith('/kitchen/start'), true);
});

test('paused and explicitly closed stations cannot be borrowed for intermediate production', async () => {
    for (const entries of [
        [['rlt-craft-paused:mill', '1']],
        [['rlt-node-job:crafting:mill', '__off']],
        [['rlt-node-job:crafting:mill', '__off_keep']],
    ]) {
        const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]), station('mill', [recipe('flour', { wheat: 1 })])], items: { wheat: 1 }, entries });
        await x.step(); assert.equal(x.calls.length, 0);
    }
});

test('another running pipeline is not overridden by intermediate crafting', async () => {
    const steps = [{ recipeId: 'oil', times: 1 }];
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1 })]), station('mill', [recipe('flour', { wheat: 1 }), recipe('oil', { sesame: 1 })])],
        items: { wheat: 1 }, entries: [['rlt-craft-pipe:mill', JSON.stringify(steps)], ['rlt-craft-pipe-run:mill', '1']],
    });
    await x.step(); assert.equal(x.calls.length, 0);
    assert.equal(x.h.getOverride('rlt-craft-pipe:mill'), JSON.stringify(steps));
});

test('an in-flight intermediate satisfies demand without another duplicate queue', async () => {
    const flour = recipe('flour', { wheat: 1 });
    const mill = station('mill', [flour]);
    Object.assign(mill, { empty: false, ready: false, recipe: flour, queue_total: 1, queued_count: 0, completed_count: 0, collected_count: 0, task_snapshot: { recipe_id: 'flour', recipe: flour, ready_at: Math.floor(Date.now() / 1000) + 60 } });
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]), mill], items: { wheat: 10 } });
    await x.step(); assert.equal(x.calls.length, 0);
    await x.collect(); await x.step();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['meal']);
});

test('refresh restores intermediate journals and resumes the root after collection', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    await x.step(); assert.equal(x.starts().length, 1);
    const y = attachBackend(harness(structuredClone(x.backend), [...x.storage]));
    await y.step(); assert.equal(y.calls.length, 0);
    await y.collect(); await y.step();
    assert.deepEqual(y.starts().map(row => row.payload.recipe_id), ['meal']);
});

test('disabling the dependency option retains wait-for-material behavior', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    x.h.CONFIG.crafting.autoCraftInputs = false;
    await x.step(); assert.equal(x.calls.length, 0);
});

test('intermediate queue respects batchLimit even when the root needs more units', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 5 }), recipe('flour', { wheat: 1 })])], items: { wheat: 5 }, batchLimit: 2 });
    await x.drain();
    assert.deepEqual(x.starts().filter(row => row.payload.recipe_id === 'flour').map(row => row.payload.quantity), [2, 2, 1]);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'meal').quantity, 1);
});

test('intermediate production leaves the configured stamina reserve untouched', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 5 }), recipe('flour', { wheat: 1 })])], items: { wheat: 5 } });
    x.backend.player.stamina = 8; x.sync(); x.h.CONFIG.crafting.staminaReserve = 4;
    await x.step();
    assert.deepEqual(x.starts().map(row => [row.payload.recipe_id, row.payload.quantity]), [['flour', 2]]);
    assert.equal(x.backend.player.stamina, 4);
});

test('the root batch is reduced when only a smaller complete chain is feasible', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })])], items: { wheat: 2 }, times: 5, batchLimit: 5 });
    await x.drain();
    assert.deepEqual(x.starts().map(row => [row.payload.recipe_id, row.payload.quantity]), [['flour', 2], ['meal', 2]]);
    assert.equal(x.h.craftPipelineProgress('kitchen', x.h.configuredCraftSteps('kitchen')).done[0], 2);
});

test('stopping the root pipeline after a child starts prevents further child queues', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { mash: 1 }), recipe('mash', { flour: 1 }), recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    x.h.setOverride('rlt-node-job:crafting:kitchen', '');
    x.h.setOverride('rlt-craft-pipe:kitchen', JSON.stringify([{ recipeId: 'meal', times: 1 }]));
    x.h.setOverride('rlt-craft-pipe-run:kitchen', '1');
    await x.step(); assert.equal(x.starts().length, 1);
    x.h.setOverride('rlt-craft-pipe-run:kitchen', '0');
    await x.collect(); await x.step();
    assert.equal(x.starts().length, 1);
    assert.equal(x.h.craftPipelineProgress('kitchen', x.h.configuredCraftSteps('kitchen')).done[0], 0);
});

test('protected portal materials are unavailable even at the deepest dependency level', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'wheat', name: 'wheat', quantity: 1, delivered: 0, min_quality: 0 }] }];
    x.sync(); await x.step();
    assert.equal(x.calls.length, 0);
    assert.equal(x.backend.inventory[0].quantity, 1);
});

test('infeasible first root does not reserve raw materials needed by a feasible second root', async () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1, pumpkin: 1 })]), station('bakery', [recipe('bread', { flour: 1 })]), station('mill', [recipe('flour', { wheat: 1 })])],
        items: { wheat: 1 },
    });
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread');
    x.h.setOverride('rlt-craft-lock-times:bakery', '1');
    await x.drain();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['flour', 'bread']);
});

test('two roots cannot each count the same intermediate in flight toward their demand', async () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1 })]), station('bakery', [recipe('bread', { flour: 1 })]), station('mill', [recipe('flour', { wheat: 1 })])],
        items: { wheat: 1 },
    });
    x.h.setOverride('rlt-node-job:crafting:bakery', 'bread');
    x.h.setOverride('rlt-craft-lock-times:bakery', '1');
    await x.step(); await x.step();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['flour']);
    await x.collect(); await x.drain();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['flour', 'meal']);
    assert.equal(x.h.craftPipelineProgress('bakery', x.h.configuredCraftSteps('bakery')).done[0], 0);
});

test('a feasible recursive chain reserves raw materials against selling and unspecified consumption', async () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { mash: 1, pumpkin: 2 }), recipe('mash', { flour: 1 }), recipe('flour', { wheat: 1 })])],
        items: { wheat: 1, pumpkin: 4 },
    });
    x.h.CONFIG.selling.defaultKeep = 0;
    let reserves = x.h.craftingInputReserves(x.h.runtime.state);
    assert.equal(reserves.get('wheat'), 1);
    assert.equal(reserves.get('pumpkin'), 2);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wheat'), 0);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'pumpkin'), 2);
    await x.step();
    reserves = x.h.craftingInputReserves(x.h.runtime.state);
    assert.equal(reserves.get('pumpkin'), 2);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'pumpkin'), 2);
});

test('alternative intermediate recipes are tried when the first producer has missing basic material', async () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1 })]), station('wheat-mill', [recipe('flour', { wheat: 1 })]), station('rice-mill', [recipe('rice-flour', { rice: 1 }, 1, { item: { item_id: 'flour', name: 'flour' } })])],
        items: { rice: 1 },
    });
    await x.drain();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['rice-flour', 'meal']);
});

test('a root pipeline task item is reserved for the root rather than its intermediate recipe', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    x.backend.task_items = [{ id: 'lucky', name: 'lucky', timing: 'start', quantity: 1, eligible_industries: ['crafting'] }]; x.sync();
    x.h.setOverride('rlt-node-job:crafting:kitchen', '');
    x.h.setOverride('rlt-craft-pipe:kitchen', JSON.stringify([{ recipeId: 'meal', times: 1, taskItemId: 'lucky' }]));
    x.h.setOverride('rlt-craft-pipe-run:kitchen', '1');
    await x.step(); assert.equal(x.starts()[0].payload.task_item_id, '');
    await x.collect(); await x.step(); assert.equal(x.starts().at(-1).payload.task_item_id, 'lucky');
});

test('an uncertain intermediate submission blocks duplicate production across reload', async () => {
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1 })]), station('mill', [recipe('flour', { wheat: 1 })])], items: { wheat: 1 } });
    x.setResponder(request => {
        if (request.url.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        throw new Error('connection lost after submission');
    });
    await assert.rejects(x.step());
    assert.equal(x.h.craftFlight('mill').phase, 'uncertain');
    const y = attachBackend(harness(structuredClone(x.backend), [...x.storage]));
    await y.step(); assert.equal(y.calls.length, 0);
    assert.equal(y.h.craftFlight('mill').phase, 'uncertain');
});

test('portal-reserved intermediate in flight cannot justify starting an otherwise impossible sibling', async () => {
    const flour = recipe('flour', { wheat: 1 });
    const mill = station('mill', [flour]);
    Object.assign(mill, { empty: false, ready: false, recipe: flour, queue_total: 1, queued_count: 0, completed_count: 0, collected_count: 0, task_snapshot: { recipe_id: 'flour', recipe: flour, ready_at: Math.floor(Date.now() / 1000) + 60 } });
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 1, paste: 1 }), recipe('paste', { corn: 1 })]), mill], items: { corn: 1 } });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, delivered: 0, min_quality: 0 }] }];
    x.sync(); await x.step();
    assert.equal(x.calls.length, 0);
});

test('a planned intermediate must satisfy portal reservations before contributing to the root', async () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1, paste: 1 }), recipe('flour', { wheat: 1 }), recipe('paste', { corn: 1 })])],
        items: { wheat: 1, corn: 1 },
    });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, delivered: 0, min_quality: 0 }] }];
    x.sync(); await x.step();
    assert.equal(x.calls.length, 0);
});

test('an entire chain can produce the reserved intermediate plus the root shortage when materials suffice', async () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1, paste: 1 }), recipe('flour', { wheat: 1 }), recipe('paste', { corn: 1 })])],
        items: { wheat: 2, corn: 1 },
    });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, delivered: 0, min_quality: 0 }] }];
    x.sync(); await x.drain();
    assert.equal(x.starts().filter(row => row.payload.recipe_id === 'flour').reduce((sum, row) => sum + row.payload.quantity, 0), 2);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'flour').quantity, 1);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'meal').quantity, 1);
});

test('alternative producers are reconsidered when a later branch needs the same scarce basic material', async () => {
    const x = setup({
        stations: [station('kitchen', [
            recipe('meal', { a: 1, b: 1 }),
            recipe('a-wheat', { wheat: 1 }, 1, { item: { item_id: 'a', name: 'a' } }),
            recipe('a-corn', { corn: 1 }, 1, { item: { item_id: 'a', name: 'a' } }),
            recipe('b', { wheat: 1 }),
        ])],
        items: { wheat: 1, corn: 1 },
    });
    await x.drain();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['a-corn', 'b', 'meal']);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'meal').quantity, 1);
});

test('guaranteed ordinary-quality output cannot fill a protected high-quality deficit', async () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1, paste: 1 }), recipe('flour', { wheat: 1 }), recipe('paste', { corn: 1 })])],
        items: { wheat: 2, corn: 1 },
    });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'flour', name: 'flour', quantity: 1, delivered: 0, min_quality: 2 }] }];
    x.sync(); await x.step();
    assert.equal(x.calls.length, 0);
});

test('current recursive materials and later pipeline materials have additive reservations', () => {
    const x = setup({
        stations: [station('kitchen', [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 }), recipe('cereal', { wheat: 1 })])],
        items: { wheat: 2 },
    });
    x.h.setOverride('rlt-node-job:crafting:kitchen', '');
    x.h.setOverride('rlt-craft-pipe:kitchen', JSON.stringify([{ recipeId: 'meal', times: 1 }, { recipeId: 'cereal', times: 1 }]));
    x.h.setOverride('rlt-craft-pipe-run:kitchen', '1');
    x.h.CONFIG.selling.defaultKeep = 0;
    assert.equal(x.h.craftingInputReserves(x.h.runtime.state).get('wheat'), 2);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wheat'), 0);
});

test('cancelled queues contribute only their remaining completed output, not the original queue size', async () => {
    const flour = recipe('flour', { wheat: 1 });
    const mill = station('mill', [flour]);
    Object.assign(mill, { empty: false, ready: true, recipe: flour, queue_total: 10, queued_count: 0, completed_count: 2, collected_count: 0, task_snapshot: null });
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 3, paste: 1 }), recipe('paste', { corn: 1 })]), mill], items: { corn: 1 } });
    await x.step();
    assert.equal(x.calls.length, 0);
});

test('actual completed outputs from both result lists prevent unnecessary intermediate production', async () => {
    const flour = recipe('flour', { wheat: 1 });
    const mill = station('mill', [flour]);
    Object.assign(mill, {
        empty: false, ready: true, recipe: flour, queue_total: 2, queued_count: 0, completed_count: 2, collected_count: 0, task_snapshot: null,
        completed_results: [{ item_id: 'flour', quantity: 3, quality: 0 }], task_results: [{ item_id: 'flour', quantity: 1, quality: 0 }],
    });
    const x = setup({ stations: [station('kitchen', [recipe('meal', { flour: 4, paste: 1 }), recipe('paste', { corn: 1 })]), mill, station('spare-mill', [flour])], items: { corn: 1, wheat: 2 } });
    await x.step();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['paste']);
    await x.collect(); await x.drain();
    assert.deepEqual(x.starts().map(row => row.payload.recipe_id), ['paste', 'meal']);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'wheat').quantity, 2);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'meal').quantity, 1);
});
