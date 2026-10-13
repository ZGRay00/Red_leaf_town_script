const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const harnessSource = shared.slice(0, shared.indexOf('async function run()')).replace('doAquaticFeed, doSailing,', `
    refiningConfig, refiningRun, startRefiningRun, stopRefiningRun, adoptRefiningTask,
    resolveRefiningUncertain, refiningMaterialNeeds, refiningBlockReason, refiningNextReadyAt,
    refiningAvailableInputQty, computeSellables, feedFreeQuantity, doRefining, doAquaticFeed, doSailing,`);
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);

// Synthetic recipes isolate execution, quality and reservation rules from live game balancing.
function setup({ stock = 20, slots = 2, initial = null, entries = [] } = {}) {
    const state = initial ? structuredClone(initial) : fixture();
    if (!initial) {
        state.inventory = [{ item_id: 'grape', name: 'Grape', quality: 1, quantity: stock, sell_price: 2 }];
        state.player.stamina = 0; state.player.stamina_restore_seconds = 0;
        state.partners = [{ partner_id: 'crafter', name: 'Crafter', assigned_refining: true,
            tendencies: [{ industry: 'crafting', current_ability: 100 }] }];
        state.industry_rules.crafting.partner_capacity = 2;
        state.facilities = { refining: { built: true, unlocked: true, locked: false, max_quality: 4, ability: 100,
            assigned_partner: { partner_id: 'crafter' }, slots: Array(slots).fill(null), recipes: [
                { id: 'wine', name: 'Wine', unlocked: true, input_item: { item_id: 'grape', name: 'Grape' },
                    input_quantity: 2, item: { item_id: 'wine', name: 'Wine' } },
                { id: 'cheese', name: 'Cheese', unlocked: true, input_item: { item_id: 'milk', name: 'Milk' },
                    input_quantity: 3, item: { item_id: 'cheese', name: 'Cheese' } },
            ].map(recipe => ({ ...recipe, options: [1, 2].map(quality => ({ quality, owned: stock,
                quality_times: [10, 30, 60, 90].map(delay => state.server_time + delay) })), output_prices: [5, 10, 15, 20] })) } };
    }
    const x = harness(state, entries);
    x.configure = (slot = 0, values = {}) => x.h.setOverride(`rlt-refining-config:${slot}`,
        JSON.stringify({ recipeId: 'wine', inputQuality: 1, targetQuality: 3, times: 1, loop: true, ...values }));
    x.run = (slot = 0) => x.h.refiningRun(slot);
    x.start = (slot = 0) => x.h.startRefiningRun(x.h.runtime.state, slot);
    x.stop = (slot = 0) => x.h.stopRefiningRun(slot);
    x.step = async () => { x.h.runtime.actionCount = 0; await x.h.doRefining(); };
    x.advance = seconds => { x.backend.server_time += seconds; x.sync(); };
    x.starts = () => x.calls.filter(request => request.url.endsWith('/start'));
    x.finishes = () => x.calls.filter(request => request.url.endsWith('/finish'));
    x.room = () => x.backend.facilities.refining;
    x.needs = () => x.h.refiningMaterialNeeds(x.h.runtime.state);
    x.reload = () => setup({ initial: x.backend, entries: [...x.storage] });
    x.setStock = (itemId, quality, quantity) => {
        let row = x.backend.inventory.find(item => item.item_id === itemId && item.quality === quality);
        if (!row) { row = { item_id: itemId, quality, quantity: 0 }; x.backend.inventory.push(row); }
        row.quantity = quantity; x.sync();
    };
    x.manual = (slot = 0) => {
        x.room().slots[slot] = { task_id: `manual-${slot}`, item: { item_id: 'wine', name: 'Wine' },
            max_quality: 4, quality_times: [10, 30, 60, 90].map(delay => x.backend.server_time + delay) };
        x.sync();
    };
    let before = () => null, after = () => {}, serial = 0;
    x.before = fn => { before = fn; }; x.after = fn => { after = fn; };
    x.respond = async request => {
        const override = await before(request); if (override) return override;
        if (request.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        const match = request.url.match(/\/refining\/(\d+)\/(start|finish)$/);
        assert.ok(match, `unexpected request ${request.url}`);
        const slot = Number(match[1]), room = x.room();
        if (match[2] === 'start') {
            assert.equal(room.slots[slot], null, 'one live batch per slot');
            const recipe = room.recipes.find(row => row.id === request.payload.recipe_id); assert.ok(recipe);
            const input = x.backend.inventory.find(row => row.item_id === recipe.input_item.item_id && row.quality === request.payload.quality);
            assert.ok(input && input.quantity >= recipe.input_quantity, 'consume exactly the selected quality');
            input.quantity -= recipe.input_quantity;
            room.slots[slot] = { task_id: `batch-${slot}-${++serial}`, item: recipe.item, max_quality: room.max_quality,
                quality_times: [10, 30, 60, 90].slice(0, room.max_quality).map(delay => x.backend.server_time + delay) };
        } else {
            const task = room.slots[slot]; assert.ok(task);
            assert.equal(request.payload.task_id, task.task_id); assert.equal(request.payload.cancel, false);
            assert.ok(task.quality_times[0] <= x.backend.server_time);
            room.slots[slot] = null;
        }
        await after(request); return x.response();
    };
    x.setResponder(x.respond); return x;
}
const reject400 = () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({ message: 'temporarily unavailable' }) });

test('loop is opt-in and legacy finite run signatures remain valid after refresh', async () => {
    const x = setup(); assert.equal(x.h.refiningConfig(0).loop, false);
    x.h.setOverride('rlt-refining-config:0', JSON.stringify({ recipeId: 'wine', inputQuality: 1, targetQuality: 3, times: 2 }));
    x.h.setOverride('rlt-refining-run:0', JSON.stringify({ version: 1, id: 'legacy-finite',
        sig: JSON.stringify(['wine', 1, 3, 2]), config: { recipeId: 'wine', inputQuality: 1, targetQuality: 3, times: 2 },
        status: 'running', done: 1, flight: null, collectOnly: false }));
    const restored = x.reload(); await restored.step(); restored.advance(60); await restored.step(); await restored.step();
    assert.equal(restored.starts().length, 1); assert.equal(restored.run().done, 2); assert.equal(restored.run().status, 'completed');
});

test('selecting a loop recipe does not authorize starts or adopt a manual batch', async () => {
    const x = setup(); x.configure(); await x.step(); assert.equal(x.calls.length, 0);
    x.manual(); x.advance(100); await x.step(); assert.equal(x.calls.length, 0); assert.equal(x.start(), false);
    assert.equal(x.run(), null);
});

test('an explicitly started loop waits for quality then starts one next batch and counts beyond times', async () => {
    const x = setup(); x.configure(); assert.equal(x.start(), true); assert.equal(x.start(), false);
    const id = x.run().id; assert.equal(x.run().sig, JSON.stringify(['wine', 1, 3, 'loop']));
    await x.step(); assert.equal(x.starts().length, 1); assert.equal(x.run().done, 0);
    assert.equal(x.h.refiningNextReadyAt(x.h.runtime.state), x.backend.server_time + 60);
    x.advance(59); await x.step(); assert.equal(x.finishes().length, 0);
    x.advance(1); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 2); assert.equal(x.run().done, 1);
    x.advance(60); await x.step();
    assert.equal(x.finishes().length, 2); assert.equal(x.starts().length, 3); assert.equal(x.run().done, 2);
    assert.equal(x.run().status, 'running'); assert.equal(x.run().id, id); assert.equal(x.h.runtime.state.player.stamina, 0);
});

test('each target quality collects precisely at its own time threshold and then starts one replacement', async () => {
    for (const [index, delay] of [10, 30, 60, 90].entries()) {
        const targetQuality = index + 1, x = setup(); x.configure(0, { targetQuality });
        assert.equal(x.start(), true); await x.step();
        const deadline = x.backend.server_time + delay;
        assert.equal(x.h.refiningNextReadyAt(x.h.runtime.state), deadline, `quality ${targetQuality} deadline`);
        x.advance(delay - 1); await x.step();
        assert.equal(x.finishes().length, 0, `quality ${targetQuality} must not be collected early`);
        assert.equal(x.starts().length, 1); assert.equal(x.run().done, 0);
        x.advance(1); await x.step();
        assert.equal(x.finishes().length, 1, `quality ${targetQuality} is collectable exactly at the threshold`);
        assert.equal(x.starts().length, 2); assert.equal(x.run().done, 1); assert.equal(x.run().status, 'running');
        assert.equal(x.h.refiningNextReadyAt(x.h.runtime.state), deadline + delay);
    }
});

test('even an immediately ready replacement gets at most one start per slot per pass', async () => {
    const x = setup({ stock: 200 }); x.configure(); x.start();
    x.after(request => { if (request.url.endsWith('/start')) x.room().slots[0].quality_times.fill(x.backend.server_time); });
    await x.step(); assert.equal(x.starts().length, 1); assert.equal(x.finishes().length, 0);
    await x.step(); assert.equal(x.starts().length, 2); assert.equal(x.finishes().length, 1);
    assert.equal(x.run().done, 1);
});

test('finite rounds retain their old count and schedule the next batch on a later pass', async () => {
    const x = setup(); x.configure(0, { loop: false, times: 2 }); x.start(); await x.step();
    x.advance(60); await x.step(); assert.equal(x.starts().length, 1); assert.equal(x.run().done, 1);
    await x.step(); assert.equal(x.starts().length, 2);
    x.advance(60); await x.step(); await x.step();
    assert.equal(x.starts().length, 2); assert.equal(x.run().status, 'completed'); assert.equal(x.run().done, 2);
});

test('empty input keeps loop authorization and starts automatically when the chosen quality arrives', async () => {
    const x = setup({ stock: 0 }); x.configure(); assert.equal(x.start(), true); const id = x.run().id;
    x.setStock('grape', 2, 20); await x.step(); assert.equal(x.calls.length, 0);
    assert.match(x.h.refiningBlockReason(x.h.runtime.state, 0), /原料不足/);
    x.setStock('grape', 1, 2); await x.step();
    assert.equal(x.starts().length, 1); assert.equal(x.starts()[0].payload.quality, 1); assert.equal(x.run().id, id);
    assert.equal(x.backend.inventory.find(row => row.quality === 2).quantity, 20);
});

test('a depleted loop remains running after collection and resumes after reload and replenishment', async () => {
    const x = setup({ stock: 2 }); x.configure(); x.start(); await x.step(); x.advance(60); await x.step();
    assert.equal(x.starts().length, 1); assert.equal(x.finishes().length, 1); assert.equal(x.run().flight, null);
    assert.equal(x.run().status, 'running'); const id = x.run().id;
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0);
    restored.setStock('grape', 1, 2); await restored.step();
    assert.equal(restored.starts().length, 1); assert.equal(restored.run().id, id); assert.equal(restored.run().done, 1);
});

test('each loop reserves just its next exact-quality batch even while another batch is in flight', async () => {
    const x = setup({ stock: 8 }); x.configure(0, { times: 99 }); x.start();
    assert.equal(x.needs().length, 1); assert.equal(x.needs()[0].need, 2); assert.equal(x.needs()[0].exactQuality, 1);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'grape', '', { applyDefaultKeep: false }), 6);
    await x.step(); assert.equal(x.needs()[0].need, 2);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'grape', '', { applyDefaultKeep: false }), 4);
    x.advance(60); await x.step(); assert.equal(x.needs()[0].need, 2);
    x.stop(); assert.equal(x.needs().length, 0);
});

test('different slots preserve their recipe, input quality and collection target independently', async () => {
    const x = setup(); x.setStock('milk', 2, 12);
    x.configure(0, { targetQuality: 2 }); x.configure(1, { recipeId: 'cheese', inputQuality: 2, targetQuality: 4 });
    x.start(0); x.start(1); await x.step();
    assert.deepEqual(x.starts().map(request => request.payload), [{ recipe_id: 'wine', quality: 1 }, { recipe_id: 'cheese', quality: 2 }]);
    const needs = x.needs(); assert.equal(needs.length, 2);
    assert.equal(needs.find(row => row.slotId === '0').need, 2); assert.equal(needs.find(row => row.slotId === '1').need, 3);
    assert.equal(needs.find(row => row.slotId === '1').exactQuality, 2);
    x.advance(30); await x.step(); assert.equal(x.run(0).done, 1); assert.equal(x.run(1).done, 0);
    x.advance(60); await x.step(); assert.equal(x.run(1).done, 1);
    assert.equal(x.finishes().filter(request => request.url.includes('/1/finish')).length, 1);
});

test('two loop slots protect one future batch each instead of their ignored finite counts', async () => {
    const x = setup({ stock: 8 }); x.configure(0, { times: 99 }); x.configure(1, { times: 99 }); x.start(0); x.start(1);
    assert.equal(x.needs().reduce((sum, need) => sum + need.need, 0), 4);
    await x.step(); assert.equal(x.starts().length, 2);
    assert.equal(x.needs().reduce((sum, need) => sum + need.need, 0), 4);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'grape', '', { applyDefaultKeep: false }), 0);
});

test('exactly two batches of shared input start both loop slots without reserving the second one away', async () => {
    const x = setup({ stock: 4 }); x.configure(0); x.configure(1); x.start(0); x.start(1);
    await x.step();
    assert.deepEqual(x.starts().map(request => request.url), ['/api/red-leaf-town/refining/0/start', '/api/red-leaf-town/refining/1/start']);
    assert.equal(x.backend.inventory[0].quantity, 0);
    assert.equal(x.run(0).flight.phase, 'active'); assert.equal(x.run(1).flight.phase, 'active');
    assert.equal(x.needs().reduce((sum, need) => sum + need.need, 0), 4);
});

test('with only one shared batch the lower slot wins even if the higher slot was authorized first', async () => {
    const x = setup({ stock: 2 }); x.configure(0); x.configure(1); x.start(1); x.start(0);
    await x.step(); await x.step();
    assert.deepEqual(x.starts().map(request => request.url), ['/api/red-leaf-town/refining/0/start']);
    assert.equal(x.backend.inventory[0].quantity, 0); assert.equal(x.run(1).flight, null); assert.equal(x.run(1).status, 'running');
    x.setStock('grape', 1, 2); await x.step();
    assert.equal(x.starts().length, 2); assert.ok(x.starts()[1].url.endsWith('/1/start'));
});

test('in-flight loop input is shared with another refining slot but remains protected from selling, feed and unspecified consumption', async () => {
    const x = setup({ stock: 4 }); x.configure(0); x.start(0); await x.step();
    x.h.CONFIG.selling.allowedItemIds = ['grape']; x.h.CONFIG.selling.defaultKeep = 0;
    const state = x.h.runtime.state;
    assert.equal(x.needs()[0].need, 2);
    assert.equal(x.h.refiningAvailableInputQty(state, 'grape', 1, 1), 2, 'the idle slot can use the active loop slot\'s next batch');
    assert.equal(x.h.safeUnspecifiedConsumeQty(state, 'grape', '', { applyDefaultKeep: false }), 0);
    assert.equal(x.h.feedFreeQuantity(state, { item_id: 'grape', quality: 1, units: 10 }), 0);
    assert.equal(x.h.computeSellables(state).length, 0);
    x.stop(0);
    assert.equal(x.h.safeUnspecifiedConsumeQty(state, 'grape', '', { applyDefaultKeep: false }), 2);
    assert.equal(x.h.feedFreeQuantity(state, { item_id: 'grape', quality: 1, units: 10 }), 2);
    assert.equal(x.h.computeSellables(state)[0].surplus, 2);
});

test('an in-flight finite run retains its remaining-round reservation against a later loop slot', async () => {
    const x = setup({ stock: 6 }); x.configure(0, { loop: false, times: 3 }); x.configure(1);
    x.start(0); x.start(1); await x.step();
    assert.deepEqual(x.starts().map(request => request.url), ['/api/red-leaf-town/refining/0/start']);
    assert.equal(x.needs().find(need => need.slotId === '0').need, 4);
    assert.equal(x.h.refiningAvailableInputQty(x.h.runtime.state, 'grape', 1, 1), 0);
    x.stop(0); await x.step();
    assert.equal(x.starts().length, 2); assert.ok(x.starts()[1].url.endsWith('/1/start'));
});

test('portal-reserved input is left intact and loop resumes after the tribute is complete', async () => {
    const x = setup({ stock: 4 }); x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'grape', quantity: 3, min_quality: 1 }] }]; x.sync();
    x.configure(); x.start(); await x.step(); assert.equal(x.calls.length, 0); assert.equal(x.backend.inventory[0].quantity, 4);
    x.backend.portals[0].completed = true; x.sync(); await x.step();
    assert.equal(x.starts().length, 1); assert.equal(x.backend.inventory[0].quantity, 2);
});

test('a new reservation in the collection response blocks replacement without losing progress', async () => {
    const x = setup({ stock: 4 }); x.configure(); x.start(); await x.step(); x.advance(60);
    x.after(request => { if (request.url.endsWith('/finish')) x.backend.portals = [{ unlocked: true,
        tributes: [{ item_id: 'grape', quantity: 2, min_quality: 1 }] }]; });
    await x.step(); assert.equal(x.run().done, 1); assert.equal(x.run().status, 'running'); assert.equal(x.starts().length, 1);
    assert.equal(x.backend.inventory[0].quantity, 2);
});

test('stop and continue preserve the same loop after its count has already exceeded times', async () => {
    const x = setup(); x.configure(); x.start(); await x.step();
    for (let batch = 0; batch < 2; batch++) { x.advance(60); await x.step(); }
    const id = x.run().id, taskId = x.run().flight.taskId; assert.equal(x.run().done, 2); assert.equal(x.stop(), true);
    x.advance(60); await x.step(); assert.equal(x.finishes().length, 2);
    assert.equal(x.start(), true); assert.equal(x.run().id, id); assert.equal(x.run().flight.taskId, taskId);
    await x.step(); assert.equal(x.run().done, 3); assert.equal(x.finishes().length, 3); assert.equal(x.starts().length, 4);
});

test('stopping an empty material-starved loop survives refresh and needs an explicit continue', async () => {
    const x = setup({ stock: 0 }); x.configure(); x.start(); const id = x.run().id; x.stop();
    const restored = x.reload(); restored.setStock('grape', 1, 2); await restored.step(); assert.equal(restored.calls.length, 0);
    assert.equal(restored.start(), true); assert.equal(restored.run().id, id); await restored.step(); assert.equal(restored.starts().length, 1);
});

test('refresh preserves a live loop and never collects early or resubmits its active batch', async () => {
    const x = setup(); x.configure(); x.start(); await x.step();
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0);
    restored.advance(60); await restored.step();
    assert.equal(restored.finishes().length, 1); assert.equal(restored.starts().length, 1);
    assert.equal(restored.run().id, x.run().id); assert.equal(restored.run().status, 'running');
});

test('adopting a manual batch forces a single collect-only run even with a saved loop preference', async () => {
    const x = setup(); x.configure(0, { times: 99 }); x.manual();
    assert.equal(x.h.adoptRefiningTask(x.h.runtime.state, 0), true);
    assert.equal(x.run().config.loop, false); assert.equal(x.run().config.times, 1); assert.equal(x.run().collectOnly, true);
    assert.equal(x.needs().length, 0); x.advance(60); await x.step(); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 0); assert.equal(x.run().done, 1);
    assert.equal(x.run().status, 'completed');
});

test('changing finite count alone leaves loop authorization and reservations unchanged', async () => {
    const x = setup({ stock: 0 }); x.configure(); x.start(); const id = x.run().id, sig = x.run().sig;
    x.configure(0, { times: 99 }); x.setStock('grape', 1, 2); await x.step();
    assert.equal(x.starts().length, 1); assert.equal(x.run().id, id); assert.equal(x.run().sig, sig); assert.equal(x.needs()[0].need, 2);
});

test('loop ignores the hidden finite count while finite mode still rejects counts above its limit', async () => {
    const x = setup(); x.configure(0, { times: 1000 }); assert.equal(x.start(), true); await x.step();
    assert.equal(x.starts().length, 1); assert.equal(x.needs()[0].need, 2);
    const finite = setup(); finite.configure(0, { loop: false, times: 1000 });
    assert.equal(finite.start(), false); await finite.step(); assert.equal(finite.calls.length, 0);
});

test('recipe, input quality, target quality and loop-mode changes revoke the prior configuration authorization', async () => {
    for (const change of [{ recipeId: 'cheese' }, { inputQuality: 2 }, { targetQuality: 2 }, { loop: false }]) {
        const x = setup(); x.configure(); x.start(); x.configure(0, change); await x.step();
        assert.equal(x.calls.length, 0, JSON.stringify(change)); assert.equal(x.needs().length, 0);
        assert.match(x.h.refiningBlockReason(x.h.runtime.state, 0), /配置已变化/);
    }
});

test('stopping during collection settles that batch but never starts its replacement', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60);
    x.after(request => { if (request.url.endsWith('/finish')) x.stop(); }); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 1); assert.equal(x.run().done, 1); assert.equal(x.run().status, 'stopped');
    await x.step(); assert.equal(x.starts().length, 1);
});

test('turning the master off during collection leaves the loop resumable without an extra start', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60);
    x.after(request => { if (request.url.endsWith('/finish')) x.h.CONFIG.refining.enabled = false; }); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 1); assert.equal(x.run().done, 1);
    assert.equal(x.run().status, 'running'); x.h.CONFIG.refining.enabled = true; await x.step(); assert.equal(x.starts().length, 2);
});

test('changing the recipe target during collection prevents an old-plan replacement', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60);
    x.after(request => { if (request.url.endsWith('/finish')) x.configure(0, { targetQuality: 4 }); }); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 1); assert.equal(x.run().done, 1);
    assert.equal(x.needs().length, 0); assert.match(x.h.refiningBlockReason(x.h.runtime.state, 0), /配置已变化/);
});

test('lowering new-batch capability still collects the old valid batch and waits to resume production', async () => {
    const x = setup(); x.configure(); x.start(); await x.step();
    x.room().max_quality = 1; x.advance(60); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 1); assert.equal(x.run().done, 1); assert.equal(x.run().status, 'running');
    assert.match(x.h.refiningBlockReason(x.h.runtime.state, 0), /超过当前可达上限/);
    x.room().max_quality = 4; x.sync(); await x.step(); assert.equal(x.starts().length, 2);
});

test('a pre-write refresh removing raw material clears an unsent journal and preserves the loop for retry', async () => {
    const x = setup(); x.configure(); x.start(); x.h.runtime.stateUncertain = true; x.backend.inventory[0].quantity = 0;
    await assert.rejects(x.step(), error => error.code === 'aborted' && error.writeNotSent);
    assert.deepEqual(x.calls.map(request => request.method), ['GET']); assert.equal(x.run().flight, null); assert.equal(x.run().status, 'running');
    x.setStock('grape', 1, 2); await x.step(); assert.equal(x.starts().length, 1);
});

test('a replacement uses the fresh collection state and never spends vanished input', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60);
    x.after(request => { if (request.url.endsWith('/finish')) x.backend.inventory[0].quantity = 0; }); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 1); assert.equal(x.run().done, 1); assert.equal(x.run().flight, null);
});

test('lost start response remains uncertain across refresh without duplicate production', async () => {
    const x = setup(); x.configure(); x.start();
    x.after(request => { if (request.url.endsWith('/start')) throw new Error('lost start response'); });
    await assert.rejects(x.step(), error => error.code === 'network_error'); assert.equal(x.run().flight.phase, 'uncertain');
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0); assert.equal(restored.run().done, 0);
    assert.equal(restored.h.resolveRefiningUncertain(restored.h.runtime.state, 0, 'adopt'), true);
    assert.equal(restored.run().status, 'stopped'); assert.equal(restored.start(), true);
    restored.advance(60); await restored.step(); assert.equal(restored.run().done, 1); assert.equal(restored.starts().length, 1);
});

test('lost collection response never renews a loop and manual settlement counts beyond the finite count', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60); await x.step();
    assert.equal(x.run().done, 1); x.advance(60);
    x.after(request => { if (request.url.endsWith('/finish')) throw new Error('lost finish response'); });
    await assert.rejects(x.step(), error => error.code === 'network_error');
    assert.equal(x.run().flight.phase, 'uncertain'); assert.equal(x.run().done, 1); assert.equal(x.starts().length, 2);
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0);
    assert.equal(restored.h.resolveRefiningUncertain(restored.h.runtime.state, 0, 'collected'), true);
    assert.equal(restored.run().done, 2); assert.equal(restored.run().status, 'stopped'); const id = restored.run().id;
    assert.equal(restored.start(), true); await restored.step(); assert.equal(restored.starts().length, 1); assert.equal(restored.run().id, id);
});

test('lost replacement response retains the preceding confirmed collection and blocks replay after refresh', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60);
    x.after(request => { if (request.url.endsWith('/start')) throw new Error('lost replacement response'); });
    await assert.rejects(x.step(), error => error.code === 'network_error');
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 2); assert.equal(x.run().done, 1);
    assert.equal(x.run().flight.phase, 'uncertain');
    const restored = x.reload(); restored.advance(60); await restored.step();
    assert.equal(restored.calls.length, 0); assert.equal(restored.run().done, 1);
    assert.equal(restored.h.resolveRefiningUncertain(restored.h.runtime.state, 0, 'adopt'), true);
    assert.equal(restored.start(), true); await restored.step();
    assert.equal(restored.finishes().length, 1); assert.equal(restored.starts().length, 1); assert.equal(restored.run().done, 2);
});

test('a definitive replacement rejection retains confirmed progress and retries only on a later pass', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60);
    x.before(request => request.url.endsWith('/start') ? reject400() : null); await x.step();
    assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 2); assert.equal(x.run().done, 1);
    assert.equal(x.run().flight, null); assert.equal(x.run().status, 'running');
    x.before(() => null); await x.step(); assert.equal(x.starts().length, 3); assert.equal(x.run().done, 1);
});

test('turning off automatic collection keeps an existing loop batch pending without replacing it', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.advance(60); x.h.CONFIG.refining.autoCollect = false;
    await x.step(); assert.equal(x.finishes().length, 0); assert.equal(x.starts().length, 1);
    assert.equal(x.h.refiningNextReadyAt(x.h.runtime.state), 0);
    x.h.CONFIG.refining.autoCollect = true; await x.step(); assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 2);
});
