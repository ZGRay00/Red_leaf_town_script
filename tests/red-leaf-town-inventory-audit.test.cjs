const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, harness } = require('./red-leaf-town-v4.test.cjs');

function tribute(itemId, quantity, minQuality = 0) {
    return { item_id: itemId, name: itemId, quantity, delivered: 0, min_quality: minQuality };
}
function crop(id, price) {
    return { id, name: id, seed_item_id: `${id}_seed`, produce_item_id: id, produce_sell_price: price,
        seed_price: 1, growth_seconds: 60, yield_min: 2, yield_max: 2 };
}
function productionState(items, demands) {
    const state = fixture();
    state.inventory = items.map(([item_id, quantity, quality = 0]) => ({ item_id, name: item_id, quantity, quality }));
    state.inventory.push({ item_id: 'wheat_seed', quantity: 10 }, { item_id: 'pumpkin_seed', quantity: 10 });
    state.crops = [crop('wheat', 1), crop('pumpkin', 100)];
    state.portals = demands.map((tributes, index) => ({ id: index, unlocked: true, tributes }));
    state.crafting_stations = [];
    return state;
}
function deficits(x) {
    return x.h.gatherNeeds(x.h.runtime.state, { productionOnly: true }).map(need => x.h.needShortage(x.h.runtime.state, need));
}

test('two portals share inventory once and unmet combined demand outranks crop profit', () => {
    const x = harness(productionState([['wheat', 10]], [[tribute('wheat', 10)], [tribute('wheat', 10)]]));
    assert.deepEqual([...deficits(x)], [0, 10]);
    assert.equal(x.h.chooseCropTarget(x.h.runtime.state, { slot: 0 }).crop.id, 'wheat');
});

test('in-flight crop yield is allocated once across multiple production needs', () => {
    const state = productionState([], [[tribute('wheat', 2)], [tribute('wheat', 2)]]);
    state.plots = [{ slot: 0, empty: false, crop: state.crops[0] }];
    assert.deepEqual([...deficits(harness(state))], [0, 2]);
});

test('high-quality thresholds preserve rare stacks while ordinary stock satisfies ordinary needs', () => {
    const x = harness(productionState([['wheat', 2, 3], ['wheat', 3, 0]], [[tribute('wheat', 3)], [tribute('wheat', 2, 3)]]));
    assert.deepEqual([...deficits(x)], [0, 0]);
    assert.equal(x.h.chooseCropTarget(x.h.runtime.state, { slot: 0 }).crop.id, 'pumpkin');
});

test('ordinary crops in flight never satisfy an unfulfilled high-quality demand', () => {
    const state = productionState([['wheat', 1, 3]], [[tribute('wheat', 2, 3)], [tribute('wheat', 2)]]);
    state.plots = [{ slot: 0, empty: false, crop: state.crops[0] }];
    assert.deepEqual([...deficits(harness(state))], [1, 0]);
});

test('a commission retains priority among equal-quality demands', () => {
    const state = productionState([['wheat', 2]], [[tribute('wheat', 2)]]);
    state.commissions = { commission: { item_id: 'wheat', item: { name: 'wheat' }, quantity: 2 } };
    const x = harness(state);
    const needs = x.h.gatherNeeds(x.h.runtime.state, { productionOnly: true });
    assert.equal(needs[0].source, 'commission');
    assert.deepEqual([...deficits(x)], [0, 2]);
});

test('quality allocation does not reorder which unmet production need is selected first', () => {
    const state = productionState([['wheat', 2, 3]], [[tribute('wheat', 2, 3)], [tribute('pumpkin', 1)]]);
    state.commissions = { commission: { item_id: 'wheat', item: { name: 'wheat' }, quantity: 3 } };
    const x = harness(state);
    assert.deepEqual([...deficits(x)], [3, 0, 1]);
    const chosen = x.h.chooseCropTarget(x.h.runtime.state, { slot: 0 });
    assert.equal(chosen.crop.id, 'wheat');
    assert.equal(chosen.need.source, 'commission');
});

test('locked portals do not take stock from active production priorities', () => {
    const state = productionState([['wheat', 2]], [[tribute('wheat', 2)], [tribute('wheat', 2)]]);
    state.portals[0].unlocked = false;
    assert.deepEqual([...deficits(harness(state))], [0]);
});

function recipe(id, inputs) {
    return { id, name: id, unlocked: true, stamina_cost: 1, duration_seconds: 60, produce_quantity: 1,
        item: { item_id: id, name: id, sell_price: 10 },
        inputs: Object.entries(inputs).map(([item_id, quantity]) => ({ item_id, quantity, item: { name: item_id } })) };
}
function busyRoot({ times = 2, quantity = 1, credited = 0, futureStep = false, batchLimit = 1 } = {}) {
    const state = fixture();
    state.inventory = [{ item_id: 'wheat', name: 'wheat', quantity: 5, quality: 0 }, { item_id: 'corn', name: 'corn', quantity: 5, quality: 0 }];
    const jobs = [recipe('meal', { flour: 1 }), recipe('flour', { wheat: 1 }), recipe('cereal', { paste: 1 }), recipe('paste', { corn: 1 })];
    state.crafting_stations = [{ station_id: 'mill', empty: false, ready: false, recipes: jobs, recipe: jobs[0],
        queue_total: quantity, queued_count: quantity - credited - 1, completed_count: 0, collected_count: credited,
        task_snapshot: { recipe_id: 'meal', ready_at: state.server_time + 60 }, assigned_partner_ids: [] },
    { station_id: 'spare', empty: true, ready: false, recipes: [jobs[1]], assigned_partner_ids: [] }];
    const x = harness(state);
    x.h.CONFIG.crafting.autoCraftInputs = true;
    x.h.CONFIG.crafting.batchLimit = batchLimit;
    x.h.CONFIG.selling.defaultKeep = 0;
    const steps = [{ recipeId: 'meal', times }];
    if (futureStep) steps.push({ recipeId: 'cereal', times: 1 });
    x.h.setOverride('rlt-craft-pipe:mill', JSON.stringify(steps));
    x.h.setOverride('rlt-craft-pipe-run:mill', '1');
    x.h.saveCraftFlight('mill', { phase: 'active', recipeId: 'meal', quantity, credited: 0, observedCollected: credited, steps, stepIndex: 0 });
    if (credited) x.h.creditCraftFlight('mill', credited);
    return x;
}

test('an active root protects the next batch raw materials without starting an available helper station', async () => {
    const x = busyRoot();
    assert.equal(x.h.craftingInputReserves(x.h.runtime.state).get('wheat'), 1);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wheat'), 4);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 0);
});

test('the final committed batch does not reserve another recursive batch', async () => {
    const x = busyRoot({ times: 1 });
    assert.equal(x.h.craftingInputReserves(x.h.runtime.state).get('wheat') || 0, 0);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 0);
});

test('partially collected active queues reserve only the next unsubmitted batch', () => {
    const x = busyRoot({ times: 4, quantity: 2, credited: 1, batchLimit: 2 });
    assert.equal(x.h.craftingInputReserves(x.h.runtime.state).get('wheat'), 2);
    assert.equal(x.h.craftPipelineProgress('mill', x.h.configuredCraftSteps('mill')).done[0], 1);
});

test('future pipeline steps keep direct materials without recursively expanding before the current step finishes', () => {
    const x = busyRoot({ times: 1, futureStep: true });
    const reserves = x.h.craftingInputReserves(x.h.runtime.state);
    assert.equal(reserves.get('paste'), 1);
    assert.equal(reserves.get('corn') || 0, 0);
});

test('pausing future submissions releases the active root next-batch recursive reservation', () => {
    const x = busyRoot();
    x.h.setOverride('rlt-craft-paused:mill', '1');
    assert.equal(x.h.craftingInputReserves(x.h.runtime.state).get('wheat') || 0, 0);
});
