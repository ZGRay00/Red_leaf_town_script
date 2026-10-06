const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function rawHarness(state, entries = []) {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        let source = originalRead.call(this, filename, ...args);
        if (filename !== sourcePath) return source;
        return source.replace('if (CONFIG.ui.autoStart) start();', `window.__refiningAudit = {
            refiningConfig, refiningRun, startRefiningRun, stopRefiningRun, adoptRefiningTask,
            resolveRefiningUncertain, refiningMaterialNeeds, refiningBlockReason, refiningNextReadyAt,
            doRefining, renderRefiningSettings, refiningAvailableInputQty,
            setBusy(value) { busy = value; }
        }; if (CONFIG.ui.autoStart) start();`);
    };
    try {
        const x = harness(state, entries);
        x.r = x.context.window.__refiningAudit;
        x.configure = (slot = 0, values = {}) => x.h.setOverride(`rlt-refining-config:${slot}`, JSON.stringify({ recipeId: 'wine', inputQuality: 1, targetQuality: 3, times: 1, ...values }));
        x.start = (slot = 0) => x.r.startRefiningRun(x.h.runtime.state, slot);
        x.run = (slot = 0) => x.r.refiningRun(slot);
        x.stop = (slot = 0) => x.r.stopRefiningRun(slot);
        x.step = async () => { x.h.runtime.actionCount = 0; await x.r.doRefining(); };
        x.advance = seconds => { x.backend.server_time += seconds; x.sync(); };
        x.starts = () => x.calls.filter(call => call.url.endsWith('/start'));
        x.finishes = () => x.calls.filter(call => call.url.endsWith('/finish'));
        x.respond = request => {
            if (request.url.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
            const room = x.backend.facilities.refining;
            if (request.url.endsWith('/partner')) {
                room.assigned_partner = { partner_id: request.payload.partner_id };
                return x.response();
            }
            const match = request.url.match(/\/refining\/(\d+)\/(start|finish)$/);
            assert.ok(match, `unexpected request: ${request.url}`);
            const slot = Number(match[1]);
            if (match[2] === 'start') {
                assert.equal(room.slots[slot], null);
                const recipe = room.recipes.find(recipe => recipe.id === request.payload.recipe_id);
                const input = x.backend.inventory.find(item => item.item_id === recipe.input_item.item_id && item.quality === request.payload.quality);
                assert.ok(input && input.quantity >= recipe.input_quantity);
                input.quantity -= recipe.input_quantity;
                room.slots[slot] = { task_id: `batch-${x.starts().length}`, item: recipe.item, max_quality: room.max_quality,
                    quality_times: [10, 30, 60, 90].slice(0, room.max_quality).map(delay => x.backend.server_time + delay) };
            } else {
                const task = room.slots[slot];
                assert.equal(request.payload.task_id, task.task_id);
                assert.equal(request.payload.cancel, false);
                assert.ok(task.quality_times[0] <= x.backend.server_time);
                room.slots[slot] = null;
            }
            return x.response();
        };
        x.setResponder(x.respond);
        return x;
    } finally { fs.readFileSync = originalRead; }
}
function setup({ stock = 20, slots = 2, entries = [] } = {}) {
    const state = fixture(), now = state.server_time;
    state.inventory = [{ item_id: 'grape', name: 'grape', quality: 1, quantity: stock, sell_price: 2 }];
    state.player.stamina = 0;
    state.player.stamina_restore_seconds = 0;
    state.partners = [{ partner_id: 'crafter', name: 'Crafter', assigned_refining: true,
        tendencies: [{ industry: 'crafting', current_ability: 100 }] }];
    state.industry_rules.crafting.partner_capacity = 2;
    state.facilities = { refining: { built: true, unlocked: true, locked: false, ability: 100, max_quality: 4,
        assigned_partner: { partner_id: 'crafter' }, slots: Array(slots).fill(null), recipes: [{ id: 'wine', unlocked: true,
            item: { item_id: 'wine', name: 'Wine' }, input_item: { item_id: 'grape', name: 'Grape' }, input_quantity: 2,
            options: [1, 2].map(quality => ({ quality, owned: stock, input_value: 4,
                quality_times: [10, 30, 60, 90].map(delay => now + delay) })), output_prices: [5, 10, 15, 20] }] } };
    return rawHarness(state, entries);
}
function manualTask(x, slot = 0, quality = 4) {
    x.backend.facilities.refining.slots[slot] = { task_id: 'manual', item: { item_id: 'wine', name: 'Wine' }, max_quality: quality,
        quality_times: [10, 30, 60, 90].slice(0, quality).map(delay => x.backend.server_time + delay) };
    x.sync();
}

test('configuration alone never authorizes refining or takes manual output', async () => {
    const x = setup(); x.configure(); manualTask(x); x.advance(100);
    await x.step(); assert.equal(x.calls.length, 0); assert.equal(x.start(), false);
});

test('one explicit round waits for target quality and completes without stamina or repetition', async () => {
    const x = setup(); x.configure(); assert.equal(x.start(), true); assert.equal(x.start(), false);
    await x.step(); assert.equal(x.starts().length, 1); assert.equal(x.h.runtime.state.player.stamina, 0);
    assert.equal(x.r.refiningNextReadyAt(x.h.runtime.state), x.backend.server_time + 60);
    x.advance(59); await x.step(); assert.equal(x.finishes().length, 0);
    x.advance(1); await x.step(); assert.equal(x.finishes().length, 1); assert.equal(x.run().done, 1);
    assert.equal(x.run().status, 'completed'); await x.step(); assert.equal(x.starts().length, 1);
});

test('finite count advances only on confirmed collection and never loops', async () => {
    const x = setup(); x.configure(0, { times: 2 }); assert.equal(x.start(), true);
    for (let index = 0; index < 2; index++) { await x.step(); assert.equal(x.run().done, index); x.advance(60); await x.step(); }
    await x.step(); assert.equal(x.starts().length, 2); assert.equal(x.finishes().length, 2); assert.equal(x.run().status, 'completed');
});

test('selected input quality never borrows another quality stack', async () => {
    const x = setup({ stock: 1 }); x.backend.inventory.push({ item_id: 'grape', quality: 2, quantity: 20 }); x.sync();
    x.configure(); assert.equal(x.start(), true); await x.step();
    assert.equal(x.calls.length, 0); assert.match(x.r.refiningBlockReason(x.h.runtime.state, 0), /原料不足/);
});

test('portal demand is protected before consuming the exact refining input stack', async () => {
    const x = setup({ stock: 4 }); x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'grape', quantity: 3, min_quality: 1 }] }]; x.sync();
    x.configure(); assert.equal(x.start(), true); await x.step(); assert.equal(x.calls.length, 0);
});

test('future material reservations exclude the confirmed current batch and release when stopped', async () => {
    const x = setup(); x.configure(0, { times: 3 }); assert.equal(x.start(), true);
    assert.equal(x.r.refiningMaterialNeeds(x.h.runtime.state)[0].need, 6);
    await x.step(); const needs = x.r.refiningMaterialNeeds(x.h.runtime.state);
    assert.equal(needs[0].need, 4); assert.equal(needs[0].exactQuality, 1); assert.equal(needs[0].slotId, '0');
    x.stop(); assert.equal(x.r.refiningMaterialNeeds(x.h.runtime.state).length, 0);
});

test('multiple slots receive scarce input in stable slot order without mutual future-reserve deadlock', async () => {
    const x = setup({ stock: 6 }); x.configure(0, { times: 3 }); x.configure(1, { times: 3 });
    assert.equal(x.start(0), true); assert.equal(x.start(1), true); await x.step();
    assert.equal(x.starts().length, 1); assert.ok(x.starts()[0].url.includes('/0/start'));
});

test('a target above facility cap is rejected and has an explanatory status', () => {
    const x = setup(); x.backend.facilities.refining.max_quality = 2; x.sync(); x.configure();
    assert.equal(x.start(), false); assert.equal(x.run(), null);
    assert.match(x.r.refiningBlockReason(x.h.runtime.state, 0), /超过当前可达上限/);
});

test('batch cap is fixed at submission even if current room capability changes', async () => {
    const x = setup(); x.configure(); x.start(); await x.step();
    x.backend.facilities.refining.max_quality = 1; x.advance(60); await x.step(); assert.equal(x.finishes().length, 1);
});

test('stop suspends collection and resume preserves the same batch and run id', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); const id = x.run().id;
    x.stop(); x.advance(60); await x.step(); assert.equal(x.finishes().length, 0);
    assert.equal(x.start(), true); assert.equal(x.run().id, id); await x.step(); assert.equal(x.run().done, 1);
});

test('refresh restores a confirmed batch without starting or collecting it early', async () => {
    const x = setup(); x.configure(); x.start(); await x.step();
    const y = rawHarness(x.backend, [...x.storage]); await y.step(); assert.equal(y.calls.length, 0);
    y.advance(60); await y.step(); assert.equal(y.finishes().length, 1); assert.equal(y.run().done, 1);
});

test('manual adoption authorizes only the current batch even when configured count is larger', async () => {
    const x = setup(); x.configure(0, { times: 5 }); manualTask(x);
    assert.equal(x.r.adoptRefiningTask(x.h.runtime.state, 0), true);
    assert.equal(x.r.refiningMaterialNeeds(x.h.runtime.state).length, 0);
    x.advance(60); await x.step(); await x.step(); assert.equal(x.finishes().length, 1); assert.equal(x.starts().length, 0); assert.equal(x.run().status, 'completed');
});

test('manual task with lower cap cannot be adopted with an unreachable target', () => {
    const x = setup(); x.configure(); manualTask(x, 0, 2);
    assert.equal(x.r.adoptRefiningTask(x.h.runtime.state, 0), false);
});

test('changed configuration invalidates the authorized run before any write', async () => {
    const x = setup(); x.configure(); x.start(); x.configure(0, { inputQuality: 2 });
    await x.step(); assert.equal(x.calls.length, 0); assert.equal(x.r.refiningMaterialNeeds(x.h.runtime.state).length, 0);
    assert.match(x.r.refiningBlockReason(x.h.runtime.state, 0), /配置已变化/);
});

test('pre-write state refresh invalidates old input plan and clears an unsent journal', async () => {
    const x = setup(); x.configure(); x.start(); x.h.runtime.stateUncertain = true; x.backend.inventory[0].quantity = 0;
    await assert.rejects(x.step(), /计划已变化/); assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/state'));
    assert.equal(x.run().flight, null); assert.equal(x.run().done, 0);
});

test('start response loss keeps uncertainty across refresh and prevents a duplicate start', async () => {
    const x = setup(); x.configure(); x.start();
    x.setResponder(request => { if (request.url.endsWith('/start')) { x.respond(request); throw new Error('response lost'); } return x.respond(request); });
    await assert.rejects(x.step()); assert.equal(x.run().flight.phase, 'uncertain'); assert.equal(x.starts().length, 1);
    const y = rawHarness(x.backend, [...x.storage]); await y.step(); assert.equal(y.calls.length, 0); assert.equal(y.run().done, 0);
    assert.equal(y.r.resolveRefiningUncertain(y.h.runtime.state, 0, 'adopt'), true); assert.equal(y.run().status, 'stopped');
    assert.equal(y.start(), true); y.advance(60); await y.step(); assert.equal(y.run().done, 1);
});

test('collection response loss never guesses completed count or repeats collection', async () => {
    const x = setup(); x.configure(0, { times: 2 }); x.start(); await x.step(); x.advance(60);
    x.setResponder(request => { if (request.url.endsWith('/finish')) { x.respond(request); throw new Error('response lost'); } return x.respond(request); });
    await assert.rejects(x.step()); assert.equal(x.run().flight.phase, 'uncertain'); assert.equal(x.run().done, 0);
    await x.step(); assert.equal(x.finishes().length, 1);
    assert.equal(x.r.resolveRefiningUncertain(x.h.runtime.state, 0, 'collected'), true);
    assert.equal(x.run().done, 1); assert.equal(x.run().status, 'stopped');
});

test('vanished task requires explicit manual settlement and is not counted as a success', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.backend.facilities.refining.slots[0] = null; x.sync();
    await x.step(); assert.equal(x.run().flight.phase, 'uncertain'); assert.equal(x.run().done, 0);
    assert.equal(x.r.resolveRefiningUncertain(x.h.runtime.state, 0, 'not-collected'), true); assert.equal(x.run().done, 0);
});

test('pre-send story block clears the start journal and permits retry after the story', async () => {
    const x = setup(); x.configure(); x.start();
    const story = x.context.document.querySelector('#app').__vue_app__._context.config.globalProperties.$pinia._s.get('story');
    story.active = true; await assert.rejects(x.step()); assert.equal(x.calls.length, 0); assert.equal(x.run().flight, null);
});

test('stop during an in-flight start preserves stopped status and the confirmed task', async () => {
    const x = setup(); x.configure(); x.start();
    x.setResponder(request => { if (request.url.endsWith('/start')) x.stop(); return x.respond(request); });
    await x.step(); assert.equal(x.run().status, 'stopped'); assert.equal(x.run().flight.phase, 'active');
    x.advance(60); await x.step(); assert.equal(x.finishes().length, 0);
});

test('a submitted finish can settle after stop without authorizing any next batch', async () => {
    const x = setup(); x.configure(0, { times: 2 }); x.start(); await x.step(); x.advance(60);
    x.setResponder(request => { if (request.url.endsWith('/finish')) x.stop(); return x.respond(request); });
    await x.step(); assert.equal(x.run().done, 1); assert.equal(x.run().status, 'stopped'); await x.step(); assert.equal(x.starts().length, 1);
});

test('master and collect switches preserve authorized tasks without early collection', async () => {
    const x = setup(); x.configure(); x.start(); x.h.CONFIG.refining.enabled = false;
    await x.step(); assert.equal(x.calls.length, 0); x.h.CONFIG.refining.enabled = true; await x.step();
    x.advance(60); x.h.CONFIG.refining.autoCollect = false; await x.step(); assert.equal(x.finishes().length, 0);
    assert.equal(x.r.refiningNextReadyAt(x.h.runtime.state), 0);
});

test('only an explicitly selected idle partner can be assigned and a current partner uses no additional capacity', async () => {
    const x = setup(); x.backend.facilities.refining.assigned_partner = null; x.backend.partners[0].assigned_refining = false; x.sync();
    x.h.CONFIG.refining.autoAssignPartner = true; await x.step(); assert.equal(x.calls.length, 0);
    x.h.CONFIG.refining.partnerId = 'crafter'; await x.step(); assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/partner'));
    await x.step(); assert.equal(x.calls.length, 1);
});

test('occupied slots prevent partner swaps and busy preferred partners are not stolen', async () => {
    const x = setup(); x.backend.facilities.refining.assigned_partner = null; x.backend.partners[0].assigned_refining = false;
    x.backend.partners[0].assigned_crafting_station_id = 'mill'; x.sync(); x.h.CONFIG.refining.autoAssignPartner = true; x.h.CONFIG.refining.partnerId = 'crafter';
    await x.step(); assert.equal(x.calls.length, 0);
    x.backend.partners[0].assigned_crafting_station_id = null; manualTask(x); await x.step(); assert.equal(x.calls.length, 0);
});

test('rendering and material inspection are read-only and expose explicit per-slot controls', () => {
    const x = setup(); x.configure(); const before = [...x.storage];
    x.r.renderRefiningSettings(x.h.runtime.state); x.r.refiningMaterialNeeds(x.h.runtime.state);
    assert.deepEqual([...x.storage], before); assert.equal(x.calls.length, 0);
    const text = element => [element.textContent || '', ...element.children.map(text)].join(' ');
    assert.match(text(x.h.configBox), /执行一轮/); assert.match(text(x.h.configBox), /领取目标/);
});

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
test('a previously focused editor cannot modify a run after another action starts it', () => {
    const x = setup(); x.configure(); x.r.renderRefiningSettings(x.h.runtime.state);
    const controls = descendants(x.h.configBox);
    const target = controls.find(control => control.tagName === 'SELECT' && control.attrs['aria-label'] === '领取目标品质');
    const count = controls.find(control => control.tagName === 'INPUT' && control.title === '本轮执行次数');
    assert.ok(target && count); assert.equal(x.start(), true);
    const snapshot = x.storage.get('rlt-refining-config:0');
    x.h.setRunning(false); // The old number control still calls wakeSoon; do not schedule the full browser loop in this unit test.
    target.value = '1'; target.onchange(); count.value = '8'; count.onchange();
    assert.equal(x.storage.get('rlt-refining-config:0'), snapshot);
});

test('a previously focused editor cannot change the recipe when a manual task occupies the slot', () => {
    const x = setup(); x.configure(); x.r.renderRefiningSettings(x.h.runtime.state);
    const select = descendants(x.h.configBox).find(control => control.tagName === 'SELECT' && control.attrs['aria-label'] === '精制配方');
    const snapshot = x.storage.get('rlt-refining-config:0'); manualTask(x);
    select.value = ''; select.onchange(); assert.equal(x.storage.get('rlt-refining-config:0'), snapshot);
});

test('a stopped batch can resume against its own fixed cap despite lower capability for future batches', async () => {
    const x = setup(); x.configure(); x.start(); await x.step(); x.stop();
    x.backend.facilities.refining.max_quality = 1; x.advance(60);
    assert.equal(x.start(), true); await x.step(); assert.equal(x.finishes().length, 1);
});

test('an active run refuses a state snapshot that has lost its refining facility or recipe', () => {
    const x = setup(); x.configure(); x.start(); const state = structuredClone(x.backend);
    delete state.facilities;
    assert.throws(() => x.h.acceptState(state), /facilities.refining.active_run/);
    const withoutRecipe = structuredClone(x.backend); withoutRecipe.facilities.refining.recipes = [];
    assert.throws(() => x.h.acceptState(withoutRecipe), /facilities.refining.recipes.active_run/);
    assert.equal(x.h.runtime.state.facilities.refining.recipes.length, 1);
});

test('refresh of a write journal left in submitting never assumes the task was started', async () => {
    const x = setup(); x.configure(); x.start(); const run = x.run(); run.flight = { phase: 'submitting', taskId: null };
    x.h.setOverride('rlt-refining-run:0', JSON.stringify(run));
    const y = rawHarness(x.backend, [...x.storage]); await y.step();
    assert.equal(y.calls.length, 0); assert.equal(y.run().flight.phase, 'uncertain'); assert.equal(y.run().done, 0);
});

test('a definitive business rejection clears the unsent batch intent without making progress', async () => {
    const x = setup(); x.configure(); x.start();
    x.setResponder(() => ({ ok: false, status: 400, headers: { get() { return null; } }, json: async () => ({ message: 'not enough material' }) }));
    await x.step(); assert.equal(x.starts().length, 1); assert.equal(x.run().flight, null); assert.equal(x.run().done, 0);
});

test('an empty or unreachable configuration visibly disables execution', () => {
    const x = setup(); x.r.renderRefiningSettings(x.h.runtime.state);
    let buttons = descendants(x.h.configBox).filter(control => control.tagName === 'BUTTON' && control.textContent === '执行一轮');
    assert.ok(buttons.length > 0); assert.ok(buttons.every(button => button.disabled));
    x.h.configBox.replaceChildren(); x.configure(); x.backend.facilities.refining.max_quality = 2; x.sync(); x.r.renderRefiningSettings(x.h.runtime.state);
    buttons = descendants(x.h.configBox).filter(control => control.tagName === 'BUTTON' && control.textContent === '执行一轮');
    assert.ok(buttons.every(button => button.disabled));
});

test('clearing a configured recipe persists the empty choice and prevents execution of the old recipe', () => {
    const x = setup(); x.configure(); x.h.setRunning(false); x.r.renderRefiningSettings(x.h.runtime.state);
    const select = descendants(x.h.configBox).find(control => control.tagName === 'SELECT' && control.attrs['aria-label'] === '精制配方');
    select.value = ''; select.onchange();
    assert.equal(x.r.refiningConfig(0).recipeId, ''); assert.equal(x.start(), false); assert.equal(x.run(), null);
    x.h.configBox.replaceChildren(); x.r.renderRefiningSettings(x.h.runtime.state);
    const buttons = descendants(x.h.configBox).filter(control => control.tagName === 'BUTTON' && control.textContent === '执行一轮');
    assert.ok(buttons.length > 0); assert.ok(buttons.every(button => button.disabled)); assert.equal(x.calls.length, 0);
});
