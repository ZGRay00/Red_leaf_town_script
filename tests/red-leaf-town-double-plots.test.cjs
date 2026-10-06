const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

// Fictional quantities and prices; the size multiplier and ordinary quality 1
// follow the downloaded official client, not assumptions about crop balance.
function farm(seedCount = 0, size = 2) {
    const state = fixture();
    state.player = { ...state.player, stamina: 100, stamina_cap: 100, stamina_restore_seconds: 0, coins: 100 };
    state.crops = [{ id: 'wheat', name: 'wheat', seed_item_id: 'wheat_seed', produce_item_id: 'wheat',
        produce_sell_price: 10, stamina_cost: 3, growth_seconds: 60, yield_min: 5, yield_max: 5 }];
    state.inventory = [{ item_id: 'wheat_seed', quality: 1, quantity: seedCount }];
    state.shop = [{ id: 'wheat_seed', item_id: 'wheat_seed', price: 3 }];
    state.plots = [{ slot: 0, size, empty: true, ready: false, assigned_partner_ids: [] }];
    state.crafting_stations = [];
    return state;
}
function tribute(quantity, min_quality = 1) {
    return { unlocked: true, tributes: [{ item_id: 'wheat', name: 'wheat', quantity, min_quality }] };
}
function makeGrowing(state) {
    Object.assign(state.plots[0], { empty: false, crop: structuredClone(state.crops[0]),
        ready: false, planted_at: state.server_time, ready_at: state.server_time + 20 });
}
function taskItem(timing, quantity) {
    return { id: timing, name: timing, timing, quantity, eligible_industries: ['farming'],
        effect: timing === 'start' ? 'duration_multiplier' : 'finish', value: timing === 'start' ? 0.5 : 60 };
}
function setup(state = farm()) {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        const source = read.call(this, file, ...args);
        return file === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            `window.__doublePlots = { renderFarmSettings, useConfiguredActiveTaskItems,
                staminaNeed: () => pendingStaminaCost };
             if (CONFIG.ui.autoStart) start();`) : source;
    };
    let x;
    try { x = harness(state); } finally { fs.readFileSync = read; }
    x.audit = x.context.window.__doublePlots;
    let before = () => null, after = () => {};
    x.before = fn => { before = fn; };
    x.after = fn => { after = fn; };
    x.setResponder(async req => {
        const response = await before(req);
        if (response) return response;
        if (req.url.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        if (req.url.endsWith('/shop/buy')) {
            const entry = x.backend.shop.find(row => row.id === req.payload.shop_id);
            assert.ok(entry); assert.ok(Number.isInteger(req.payload.quantity) && req.payload.quantity > 0);
            const cost = req.payload.quantity * entry.price;
            assert.ok(x.backend.player.coins >= cost, 'purchase respects actual funds');
            x.backend.player.coins -= cost;
            const id = entry.item?.item_id ?? entry.item_id ?? entry.id;
            let stack = x.backend.inventory.find(row => row.item_id === id && row.quality === 1);
            if (!stack) { stack = { item_id: id, quality: 1, quantity: 0 }; x.backend.inventory.push(stack); }
            stack.quantity += req.payload.quantity;
        } else if (/\/plots\/\d+\/plant$/.test(req.url)) {
            const slot = Number(req.url.match(/\/plots\/(\d+)\/plant$/)[1]);
            const plot = x.backend.plots.find(row => row.slot === slot), size = plot.size || 1;
            const crop = x.backend.crops.find(row => row.id === req.payload.crop_id);
            const stacks = x.backend.inventory.filter(row => row.item_id === crop.seed_item_id);
            assert.ok(stacks.reduce((sum, row) => sum + row.quantity, 0) >= size, 'double plot has its full seed requirement');
            assert.ok(x.backend.player.stamina >= crop.stamina_cost * size, 'double plot has its full stamina requirement');
            let remaining = size;
            for (const stack of stacks) { const used = Math.min(remaining, stack.quantity); stack.quantity -= used; remaining -= used; }
            x.backend.player.stamina -= crop.stamina_cost * size;
            if (req.payload.task_item_id) {
                const selected = x.backend.task_items.find(row => row.id === req.payload.task_item_id);
                assert.ok(selected.quantity >= size); selected.quantity -= size;
            }
            Object.assign(plot, { empty: false, crop: structuredClone(crop), ready_at: x.backend.server_time + 60 });
        } else if (req.url.endsWith('/tasks/use-item')) {
            const plot = x.backend.plots.find(row => String(row.slot) === req.payload.slot_id);
            const selected = x.backend.task_items.find(row => row.id === req.payload.task_item_id);
            const size = plot.size || 1;
            assert.ok(selected.quantity >= size); selected.quantity -= size; plot.ready = true;
        } else if (/\/inventory\/[^/]+\/sell$/.test(req.url)) {
            const id = req.url.match(/\/inventory\/([^/]+)\/sell$/)[1];
            const stack = x.backend.inventory.find(row => row.item_id === id && row.quality === req.payload.quality);
            assert.ok(stack.quantity >= req.payload.quantity);
            stack.quantity -= req.payload.quantity; x.backend.player.coins += stack.sell_price * req.payload.quantity;
        } else assert.fail(`unexpected request ${req.url}`);
        await after(req);
        return x.response();
    });
    x.buys = () => x.calls.filter(req => req.url.endsWith('/shop/buy'));
    x.plants = () => x.calls.filter(req => req.url.endsWith('/plant'));
    x.needs = () => [...x.h.farmingPlantingNeeds(x.h.runtime.state)].map(row => [row.shortage, row.pending]);
    return x;
}

test('empty double plot buys exactly two seeds then plants once at its leading slot', async () => {
    const x = setup();
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [2]);
    assert.deepEqual(x.plants().map(req => req.url.split('/').slice(-3).join('/')), ['plots/0/plant']);
    assert.equal(x.backend.player.coins, 94); assert.equal(x.backend.player.stamina, 94);
    assert.equal(x.backend.inventory[0].quantity, 0);
    await x.h.plantEmptyPlots();
    assert.equal(x.calls.length, 2, 'a running double plot does not trigger another seed purchase');
});

test('a partially supplied double plot buys only its one missing seed', async () => {
    const x = setup(farm(1));
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [1]);
    assert.equal(x.plants().length, 1); assert.equal(x.backend.player.coins, 97);
});

test('seeds across inventory stacks cover the double plot without another purchase', async () => {
    const state = farm(1); state.inventory.push({ item_id: 'wheat_seed', quality: 0, quantity: 1 });
    const x = setup(state);
    await x.h.plantEmptyPlots();
    assert.equal(x.buys().length, 0); assert.equal(x.plants().length, 1);
    assert.equal(x.backend.inventory.reduce((sum, row) => sum + row.quantity, 0), 0);
});

test('disabled seed buying leaves a half-supplied double plot idle, including a manual lock', async () => {
    for (const locked of [false, true]) {
        const x = setup(farm(1)); x.h.CONFIG.farming.autoBuySeeds = false;
        if (locked) x.h.setOverride('rlt-plot-crop:0', 'wheat');
        await x.h.plantEmptyPlots();
        assert.equal(x.calls.length, 0); assert.equal(x.backend.inventory[0].quantity, 1);
    }
});

test('automatic double plots do not buy half a seed requirement they cannot fully afford', async () => {
    const state = farm(); state.player.coins = 3;
    const x = setup(state);
    await x.h.plantEmptyPlots();
    assert.equal(x.calls.length, 0);
});

test('safe-sale budget covers the full missing seed cost and respects the remaining sale limit', async () => {
    const state = farm(); state.player.coins = 0;
    state.inventory.push({ item_id: 'wheat', name: 'wheat', quality: 1, quantity: 10, sell_price: 2 });
    const x = setup(state); x.h.CONFIG.selling.defaultKeep = 0; x.h.CONFIG.selling.maxUnitsPerTick = 2;
    await x.h.plantEmptyPlots(); assert.equal(x.calls.length, 0);
    x.h.CONFIG.selling.maxUnitsPerTick = 3;
    await x.h.plantEmptyPlots();
    assert.equal(x.calls.find(req => req.url.endsWith('/sell')).payload.quantity, 3);
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [2]);
    assert.equal(x.plants().length, 1); assert.equal(x.backend.player.coins, 0);
});

test('double plot waits for doubled stamina before buying or planting', async () => {
    for (const seeds of [0, 2]) {
        const state = farm(seeds); state.player.stamina = 3;
        const x = setup(state);
        await x.h.plantEmptyPlots();
        assert.equal(x.calls.length, 0); assert.equal(x.audit.staminaNeed(), 6);
    }
});

test('a crop whose double-plot stamina exceeds the cap is excluded from automatic candidates', async () => {
    const state = farm(2); state.player.stamina = state.player.stamina_cap = 5;
    const x = setup(state);
    assert.equal(x.h.chooseCropTarget(x.h.runtime.state, x.h.runtime.state.plots[0]).crop, undefined);
    await x.h.plantEmptyPlots(); assert.equal(x.calls.length, 0);
});

test('double-plot profit multiplies expected yield and charges only missing seeds', () => {
    for (const [seeds, expected] of [[0, 5640], [1, 5820], [2, 6000]]) {
        const x = setup(farm(seeds));
        assert.equal(x.h.cropHourlyProfit(x.h.runtime.state, x.h.runtime.state.crops[0], 0, x.h.runtime.state.plots[0]), expected);
    }
});

test('ordinary quality 1 supplies the price and takes priority over legacy quality 0', () => {
    const state = farm(2); delete state.crops[0].produce_sell_price;
    state.inventory.push({ item_id: 'wheat', quality: 0, quantity: 1, sell_price: 99 },
        { item_id: 'wheat', quality: 1, quantity: 1, sell_price: 10 }, { item_id: 'wheat', quality: 5, quantity: 1, sell_price: 999 });
    const x = setup(state);
    assert.equal(x.h.cropHourlyProfit(x.h.runtime.state, x.h.runtime.state.crops[0], 0, x.h.runtime.state.plots[0]), 6000);
});

test('legacy ordinary quality 0 stays usable while premium quality 2+ is never the base price', () => {
    for (const [quality, expected] of [[0, 6000], [2, null], [5, null]]) {
        const state = farm(2); delete state.crops[0].produce_sell_price;
        state.inventory.push({ item_id: 'wheat', quality, quantity: 1, sell_price: 10 });
        const x = setup(state);
        assert.equal(x.h.cropHourlyProfit(x.h.runtime.state, x.h.runtime.state.crops[0], 0, x.h.runtime.state.plots[0]), expected);
    }
});

test('ordinary quality 1 tribute counts all guaranteed output from a double plot', () => {
    const state = farm(); makeGrowing(state); state.portals = [tribute(10)];
    const x = setup(state);
    assert.deepEqual(x.needs(), [[0, 0]]);
    const need = x.h.gatherNeeds(x.h.runtime.state, { productionOnly: true })[0];
    assert.equal(x.h.needShortage(x.h.runtime.state, need), 0);
});

test('high-quality trials use doubled output only once after ordinary demand allocation', () => {
    const state = farm(); makeGrowing(state); state.portals = [tribute(5, 1), tribute(10, 2), tribute(5, 3)];
    const x = setup(state);
    assert.deepEqual(x.needs(), [[0, 0], [10, 5], [5, 0]]);
    assert.equal(x.h.needShortage(x.h.runtime.state, x.h.gatherNeeds(x.h.runtime.state, { productionOnly: true })[1]), 10);
});

test('start task items cannot dip into the reserve to cover a double plot', async () => {
    const state = farm(2); state.task_items = [taskItem('start', 2)];
    const x = setup(state);
    x.h.setOverride('rlt-node-task-item:farming:0', 'start'); x.h.setOverride('rlt-node-task-item-keep:farming:0', '1');
    assert.equal(x.h.slotTaskItem(x.h.runtime.state, 'farming', 0, 'start'), null);
    await x.h.plantEmptyPlots();
    assert.equal(x.plants()[0].payload.task_item_id, ''); assert.equal(x.backend.task_items[0].quantity, 2);
});

test('a double plot consumes two start items when both are above the reserve', async () => {
    const state = farm(2); state.task_items = [taskItem('start', 3)];
    const x = setup(state);
    x.h.setOverride('rlt-node-task-item:farming:0', 'start'); x.h.setOverride('rlt-node-task-item-keep:farming:0', '1');
    await x.h.plantEmptyPlots();
    assert.equal(x.plants()[0].payload.task_item_id, 'start'); assert.equal(x.backend.task_items[0].quantity, 1);
});

test('profit does not assume a speed item that a double plot cannot afford above its reserve', () => {
    const state = farm(2); state.task_items = [taskItem('start', 2)];
    const x = setup(state);
    x.h.setOverride('rlt-node-task-item:farming:0', 'start'); x.h.setOverride('rlt-node-task-item-keep:farming:0', '1');
    assert.equal(x.h.cropHourlyProfit(x.h.runtime.state, x.h.runtime.state.crops[0], 0, x.h.runtime.state.plots[0]), 6000);
});

test('active task items require two available units and leave the configured reserve intact', async () => {
    const state = farm(); makeGrowing(state); state.task_items = [taskItem('active', 2)];
    const x = setup(state);
    x.h.setOverride('rlt-node-task-item:farming:0', 'active'); x.h.setOverride('rlt-node-task-item-keep:farming:0', '1');
    assert.equal(await x.audit.useConfiguredActiveTaskItems(), 0); assert.equal(x.calls.length, 0);
    x.backend.task_items[0].quantity = 3; x.sync();
    assert.equal(await x.audit.useConfiguredActiveTaskItems(), 1);
    assert.equal(x.backend.task_items[0].quantity, 1);
    assert.equal(x.calls[0].payload.slot_id, '0');
});

test('an active-item state refresh rechecks the double-plot reserve before sending a write', async () => {
    const state = farm(); makeGrowing(state); state.task_items = [taskItem('active', 3)];
    const x = setup(state);
    x.h.setOverride('rlt-node-task-item:farming:0', 'active'); x.h.setOverride('rlt-node-task-item-keep:farming:0', '1');
    x.h.runtime.stateUncertain = true; x.backend.task_items[0].quantity = 2;
    await assert.rejects(x.audit.useConfiguredActiveTaskItems(), error => error.code === 'aborted');
    assert.deepEqual(x.calls.map(req => req.method), ['GET']);
});

test('changing plot size during a seed purchase prevents planting the stale plan', async () => {
    const x = setup(farm(0, 1));
    x.after(req => { if (req.url.endsWith('/shop/buy')) x.backend.plots[0].size = 2; });
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [1]); assert.equal(x.plants().length, 0);
    x.after(() => {});
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [1, 1]); assert.equal(x.plants().length, 1);
});

test('merging a plot during the pre-write refresh prevents the old one-seed purchase', async () => {
    const x = setup(farm(0, 1)); x.h.runtime.stateUncertain = true; x.backend.plots[0].size = 2;
    await assert.rejects(x.h.plantEmptyPlots(), error => error.code === 'aborted');
    assert.deepEqual(x.calls.map(req => req.method), ['GET']);
});

test('a purchase response without enough seeds never leads to an invalid planting request', async () => {
    const x = setup();
    x.after(req => { if (req.url.endsWith('/shop/buy')) x.backend.inventory[0].quantity = 1; });
    await x.h.plantEmptyPlots();
    assert.equal(x.buys().length, 1); assert.equal(x.plants().length, 0);
});

test('an uncertain purchase is resynchronized without blindly buying the second seed again', async () => {
    const x = setup();
    x.before(req => {
        if (req.url.endsWith('/shop/buy')) {
            x.backend.inventory[0].quantity += req.payload.quantity;
            x.backend.player.coins -= req.payload.quantity * 3;
            throw new Error('response lost after purchase');
        }
        return null;
    });
    await assert.rejects(x.h.plantEmptyPlots(), error => error.code === 'network_error');
    assert.equal(x.buys().length, 1); assert.equal(x.plants().length, 0);
    x.before(() => null); await x.h.plantEmptyPlots();
    assert.equal(x.buys().length, 1); assert.equal(x.plants().length, 1);
});

test('merged farm settings label occupied slots together and preconfigure the next actual slot', () => {
    const state = farm(); state.plots.push({ slot: 2, size: 2, empty: true, assigned_partner_ids: [] });
    const x = setup(state);
    x.h.configBox.replaceChildren(); x.audit.renderFarmSettings(x.h.runtime.state);
    const walk = node => [node, ...node.children.flatMap(walk)];
    const selects = walk(x.h.configBox).filter(node => node.tagName === 'SELECT' && /^(土地|双倍田)/.test(node.attrs['aria-label'] || ''));
    assert.deepEqual(selects.map(node => node.attrs['aria-label']), ['双倍田 1＋2:', '双倍田 3＋4:', '土地 5:']);
    selects[2].value = 'wheat'; selects[2].onchange();
    assert.equal(x.h.getOverride('rlt-plot-crop:4'), 'wheat');
    assert.equal(x.h.getOverride('rlt-plot-crop:3'), null, 'the second half of a merged plot is not a new plot');
});

test('legacy plots without a size still buy and consume exactly one seed', async () => {
    const state = farm(); delete state.plots[0].size;
    const x = setup(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [1]);
    assert.equal(x.backend.player.stamina, 97);
});

test('an explicit task-item requirement preserves compatibility with non-farming callers', () => {
    const state = farm(); state.task_items = [{ ...taskItem('start', 3), eligible_industries: ['crafting'] }];
    const x = setup(state); x.h.setOverride('rlt-node-task-item:crafting:mill', 'start');
    x.h.setOverride('rlt-node-task-item-keep:crafting:mill', '1');
    assert.ok(x.h.slotTaskItem(x.h.runtime.state, 'crafting', 'mill', 'start'));
    assert.ok(x.h.slotTaskItem(x.h.runtime.state, 'crafting', 'mill', 'start', { requiredQuantity: 2 }));
    assert.equal(x.h.slotTaskItem(x.h.runtime.state, 'crafting', 'mill', 'start', { requiredQuantity: 3 }), null);
});
