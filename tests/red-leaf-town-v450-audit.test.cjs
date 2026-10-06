const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function snapshot(stock = 4) {
    const state = fixture(), now = state.server_time;
    state.player.stamina_restore_seconds = 0;
    state.inventory = [{ item_id: 'grape', name: 'Grape', quality: 1, quantity: stock, sell_price: 2 }];
    state.partners = [{ partner_id: 'refiner', assigned_refining: true,
        tendencies: [{ industry: 'crafting', current_ability: 100 }] }];
    state.industry_rules.crafting.partner_capacity = 2;
    state.facilities = { upgrades: [{ id: 'farm-1', kind: 'farm', inputs: [{ item_id: 'grape', quantity: 2, min_quality: 1 }] }],
        refining: { built: true, unlocked: true, max_quality: 4, assigned_partner: { partner_id: 'refiner' },
            slots: [null, null], recipes: [{ id: 'wine', unlocked: true, input_item: { item_id: 'grape', name: 'Grape' },
                input_quantity: 2, item: { item_id: 'wine', name: 'Wine' },
                options: [{ quality: 1, quality_times: [10, 20, 30, 40].map(delay => now + delay) }] }] } };
    return state;
}
function setup(state = snapshot()) {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        const source = read.call(this, file, ...args);
        return file === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            `window.__crossModule = { startRefiningRun, stopRefiningRun, refiningRun, refiningMaterialNeeds,
                refiningAvailableInputQty, doRefining };
             if (CONFIG.ui.autoStart) start();`) : source;
    };
    let x;
    try { x = harness(state); } finally { fs.readFileSync = read; }
    x.r = x.context.window.__crossModule;
    x.authorize = (slot = 0, times = 1) => {
        x.h.setOverride(`rlt-refining-config:${slot}`, JSON.stringify({ recipeId: 'wine', inputQuality: 1, targetQuality: 3, times }));
        assert.equal(x.r.startRefiningRun(x.h.runtime.state, slot), true);
    };
    let after = () => {};
    x.after = fn => { after = fn; };
    x.setResponder(async req => {
        if (req.url.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        const refine = req.url.match(/\/refining\/(\d+)\/start$/);
        if (refine) {
            const slot = Number(refine[1]), room = x.backend.facilities.refining;
            const input = x.backend.inventory.find(row => row.item_id === 'grape' && row.quality === req.payload.quality);
            assert.ok(input.quantity >= 2); input.quantity -= 2;
            room.slots[slot] = { task_id: `task-${slot}`, item: { item_id: 'wine' }, max_quality: 4,
                quality_times: [10, 20, 30, 40].map(delay => x.backend.server_time + delay) };
        } else if (req.url.endsWith('/crafting/stations/mill/start')) {
            const node = x.backend.crafting_stations[0], recipe = node.recipes[0];
            assert.equal(req.payload.recipe_id, recipe.id);
            const input = x.backend.inventory.find(row => row.item_id === 'grape');
            const amount = 2 * req.payload.quantity;
            assert.ok(input.quantity >= amount); input.quantity -= amount;
            Object.assign(node, { empty: false, recipe, queue_total: req.payload.quantity, collected_count: 0,
                completed_count: 0, queued_count: req.payload.quantity - 1,
                task_snapshot: { recipe_id: recipe.id, ready_at: x.backend.server_time + 60 } });
        } else assert.fail(`unexpected request ${req.url}`);
        await after(req);
        return x.response();
    });
    return x;
}

test('a running refining reservation cannot disappear because the room is absent in a later snapshot', () => {
    const x = setup(snapshot(2)); x.authorize();
    const previous = x.h.runtime.state;
    delete x.backend.facilities.refining;
    assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /refining/.test(error.message));
    assert.equal(x.h.runtime.state, previous);
    assert.equal(x.r.refiningMaterialNeeds(previous)[0].need, 2);
    assert.equal(x.h.safeUnspecifiedConsumeQty(previous, 'grape', '', { applyKeep: false }), 0);
});

test('a running slot cannot disappear through a truncated refining slot array', () => {
    const x = setup(); x.authorize(1);
    x.backend.facilities.refining.slots.length = 1;
    assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /refining/.test(error.message));
});

test('a running material reservation requires its selected recipe to remain readable', () => {
    const x = setup(); x.authorize();
    x.backend.facilities.refining.recipes = [];
    assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /recipes/.test(error.message));
});

test('stopping an unsubmitted refining round releases its reservation explicitly', () => {
    const x = setup(); x.authorize();
    assert.equal(x.r.stopRefiningRun(0), true);
    delete x.backend.facilities.refining; x.sync();
    assert.equal(x.r.refiningMaterialNeeds(x.h.runtime.state).length, 0);
});

test('missing optional facilities still support users with no refining or facility reservation', () => {
    const x = setup(fixture());
    assert.doesNotThrow(() => x.sync());
    assert.equal(x.r.refiningMaterialNeeds(x.h.runtime.state).length, 0);
});

test('selected facility material schema rejects null rows and invalid quality thresholds', () => {
    for (const input of [null, { item_id: 'grape', quantity: 2, min_quality: 'bad' },
        { item_id: 'grape', quantity: 2, min_quality: -1 }, { item_id: 'grape', quantity: 2, min_quality: 1.5 },
        { item_id: 'grape', quantity: 2, min_quality: 6 }]) {
        const x = setup(); x.h.setOverride('rlt-facility-reserve:farm', 'farm-1');
        x.backend.facilities.upgrades[0].inputs = [input];
        assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /inputs/.test(error.message));
    }
});

test('authorized crafting can proceed when refining wants the same input, while refining waits for crafting', async () => {
    const state = snapshot(2);
    const recipe = state.crafting_stations[0].recipes[0];
    recipe.inputs = [{ item_id: 'grape', quantity: 2 }]; recipe.stamina_cost = 1;
    const x = setup(state); x.authorize();
    x.h.setOverride('rlt-node-job:crafting:mill', recipe.id);
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    assert.equal(x.r.refiningAvailableInputQty(x.h.runtime.state, 'grape', 1, 0), 0);
    await x.r.doRefining(); assert.equal(x.calls.length, 0);
    await x.h.startEmptyIndustries();
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/crafting/stations/mill/start'));
    await x.r.doRefining(); assert.equal(x.calls.length, 1);
});

test('adding facility protection during a refining request stops the next slot from spending the newly reserved input', async () => {
    const x = setup(); x.authorize(0); x.authorize(1);
    x.after(req => { if (req.url.endsWith('/refining/0/start')) x.h.setOverride('rlt-facility-reserve:farm', 'farm-1'); });
    await x.r.doRefining();
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/refining/0/start'));
    assert.equal(x.backend.inventory[0].quantity, 2);
    assert.equal(x.backend.facilities.refining.slots[1], null);
});

test('turning off refining during a submitted start preserves that batch and prevents the next slot from starting', async () => {
    const x = setup(); x.authorize(0); x.authorize(1);
    x.after(req => { if (req.url.endsWith('/refining/0/start')) x.h.CONFIG.refining.enabled = false; });
    await x.r.doRefining();
    assert.equal(x.calls.length, 1);
    assert.equal(x.r.refiningRun(0).flight.phase, 'active');
    assert.equal(x.r.refiningRun(1).flight, null);
    assert.equal(x.backend.inventory[0].quantity, 2);
});
