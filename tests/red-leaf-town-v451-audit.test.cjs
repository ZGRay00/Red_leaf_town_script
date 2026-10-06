const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function stateForProjects(stock = 20) {
    const state = fixture();
    state.player.stamina_restore_seconds = 0;
    state.inventory = [{ item_id: 'wood', name: 'Wood', quality: 1, quantity: stock, sell_price: 2 }];
    state.facilities = { upgrades: [{ id: 'shared', kind: 'farm', name: 'Farm merge', stage: 1,
        unlocked: true, affordable: true, coins: 10, inputs: [{ item_id: 'wood', quantity: 3 }] }] };
    state.plots = [0, 1].map(slot => ({ slot, size: 1, empty: true, ready: false, assigned_partner_ids: [] }));
    state.aquatic.buildable_ponds = [{ id: 'shared', name: 'Second pond', unlocked: true, affordable: true,
        build_cost: 20, build_materials: [{ item_id: 'wood', quantity: 4 }] }];
    return state;
}
function pond(id, species, stock = 0) {
    return { pond_id: id, definition: { name: id, species_id: species }, capacity: 40,
        stock, population: stock, fry: [], steady_stock: 30, assigned_partner_ids: [] };
}
function setup(state = stateForProjects(), entries = []) {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        const source = read.call(this, file, ...args);
        return file === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            `window.__v451Audit = { facilityUpgradeOptions, facilityMaterialNeeds, pondBuildPlan,
                doPonds, setPondSetting, collectReadyPlots, startRefiningRun,
                queueFacilityUpgrade: (...args) => {
                    const result = queueFacilityUpgrade(...args);
                    // The suite drives processing explicitly; do not leave the application tick scheduled.
                    clearTimeout(timer); timer = null;
                    return result;
                }, processFacilityUpgrade, facilityUpgradeBlock, farmUpgradePlots };
             if (CONFIG.ui.autoStart) start();`) : source;
    };
    let x;
    try { x = harness(state, entries); } finally { fs.readFileSync = read; }
    x.a = x.context.window.__v451Audit;
    x.reserve = (kind, id = 'shared') => x.h.setOverride(`rlt-facility-reserve:${kind}`, id);
    x.build = (id = 'shared') => x.h.setOverride(`rlt-pond-build:${id}`, 'on');
    x.available = project => x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wood', '',
        { applyDefaultKeep: false, excludeFacilityProject: project });
    let before = () => null, after = () => {};
    x.before = fn => { before = fn; }; x.after = fn => { after = fn; };
    const consume = amount => {
        let remaining = amount;
        for (const stack of [...x.backend.inventory].filter(row => row.item_id === 'wood').sort((a, b) => b.quality - a.quality)) {
            const used = Math.min(remaining, stack.quantity); stack.quantity -= used; remaining -= used;
        }
        assert.equal(remaining, 0, 'construction consumes only owned material');
    };
    x.respond = async req => {
        const response = await before(req); if (response) return response;
        if (req.url.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        const build = req.url.match(/\/ponds\/([^/]+)\/build$/), harvest = req.url.match(/\/ponds\/([^/]+)\/harvest$/),
            stock = req.url.match(/\/ponds\/([^/]+)\/stock$/), plotHarvest = req.url.match(/\/plots\/(\d+)\/harvest$/);
        if (build) {
            const site = x.backend.aquatic.buildable_ponds.find(row => String(row.id) === build[1]);
            consume(site.build_materials.reduce((sum, row) => sum + row.quantity, 0));
            x.backend.player.coins -= site.build_cost;
            x.backend.aquatic.ponds.push(pond(site.id, 'carp'));
            x.backend.aquatic.buildable_ponds = x.backend.aquatic.buildable_ponds.filter(row => row !== site);
        } else if (harvest) {
            const target = x.backend.aquatic.ponds.find(row => row.pond_id === harvest[1]);
            target.stock -= req.payload.quantity; target.population -= req.payload.quantity;
        } else if (stock) {
            const target = x.backend.aquatic.ponds.find(row => row.pond_id === stock[1]);
            const species = x.backend.aquatic.species.find(row => row.id === req.payload.species_id);
            assert.equal(species.id, target.definition.species_id, 'each pond uses its designated species');
            assert.ok(species.owned_fry >= req.payload.quantity);
            species.owned_fry -= req.payload.quantity; target.population += req.payload.quantity;
            target.fry.push({ count: req.payload.quantity });
        } else if (plotHarvest) {
            Object.assign(x.backend.plots.find(row => row.slot === Number(plotHarvest[1])), { empty: true, ready: false, crop: null });
        } else if (req.url.endsWith('/facilities/shared')) {
            const upgrade = x.backend.facilities.upgrades.find(row => row.id === 'shared');
            consume(upgrade.inputs.reduce((sum, row) => sum + row.quantity, 0)); x.backend.player.coins -= upgrade.coins;
            x.backend.plots = [{ slot: 0, size: 2, empty: true, ready: false,
                assigned_partner_ids: req.payload.partner_id ? [req.payload.partner_id] : [] }];
            x.backend.facilities.upgrades = [];
        } else assert.fail(`unexpected request ${req.url}`);
        await after(req); return x.response();
    };
    x.setResponder(x.respond);
    return x;
}
function authorizeCraft(x, times = 3) {
    const recipe = x.backend.crafting_stations[0].recipes[0];
    recipe.inputs = [{ item_id: 'wood', quantity: 1 }]; recipe.stamina_cost = 1; x.sync();
    x.h.setOverride('rlt-node-job:crafting:mill', recipe.id); x.h.setOverride('rlt-craft-lock-times:mill', String(times));
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
}
function authorizeRefining(x, quality = 1) {
    x.backend.facilities.refining = { built: true, unlocked: true, max_quality: 4,
        slots: [null], assigned_partner: { partner_id: 'refiner' }, recipes: [{ id: 'polish', unlocked: true,
            input_item: { item_id: 'wood', name: 'Wood' }, input_quantity: 2, item: { item_id: 'polished' },
            options: [{ quality, quality_times: [10, 20, 30, 40].map(delay => x.backend.server_time + delay) }] }] };
    x.sync();
    x.h.setOverride('rlt-refining-config:0', JSON.stringify({ recipeId: 'polish', inputQuality: quality, targetQuality: 3, times: 1 }));
    assert.equal(x.a.startRefiningRun(x.h.runtime.state, 0), true);
}

test('pond building projects preserve source identity and release after their pond is built', () => {
    const x = setup(); x.reserve('pond');
    const [need] = x.a.facilityMaterialNeeds(x.h.runtime.state);
    assert.equal(need.projectKind, 'pond'); assert.equal(need.projectId, 'shared'); assert.equal(need.need, 4);
    const project = x.a.facilityUpgradeOptions(x.h.runtime.state).find(row => row.kind === 'pond');
    assert.equal(project.coins, 20); assert.equal(project.inputs[0].item_id, 'wood');
    x.backend.aquatic.ponds.push(pond('shared', 'carp')); x.sync();
    assert.equal(x.a.facilityMaterialNeeds(x.h.runtime.state).length, 0);
});

test('excluding a project consumes only its own reservation even when another kind has the same id', () => {
    const x = setup(stateForProjects(7)); x.reserve('farm'); x.reserve('pond');
    assert.equal(x.available(), 0);
    assert.equal(x.available({ kind: 'pond', id: 'shared' }), 4);
    assert.equal(x.available({ kind: 'farm', id: 'shared' }), 3);
    assert.equal(x.available({ kind: 'pond', id: 'another' }), 0);
    assert.equal(x.available({ kind: 'feed', id: 'shared' }), 0);
});

test('selected pond reservation rejects missing or malformed project arrays without releasing its previous state', () => {
    for (const change of [state => { delete state.aquatic.buildable_ponds; }, state => { state.aquatic.buildable_ponds = {}; },
        state => { delete state.aquatic.ponds; }, state => { state.aquatic.ponds = {}; }]) {
        const x = setup(); x.reserve('pond'); const previous = x.h.runtime.state;
        change(x.backend);
        assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /pond_projects/.test(error.message));
        assert.equal(x.h.runtime.state, previous);
    }
});

test('selected pond reservation requires explicit valid construction material metadata', () => {
    for (const materials of [undefined, null, {}, [null], [{ item_id: 'wood', quantity: 2, min_quality: 9 }]]) {
        const x = setup(); x.reserve('pond'); x.backend.aquatic.buildable_ponds[0].build_materials = materials;
        assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /inputs/.test(error.message));
    }
    const x = setup(); x.reserve('pond'); x.backend.aquatic.buildable_ponds[0].build_materials = []; x.sync();
    assert.equal(x.a.facilityMaterialNeeds(x.h.runtime.state).length, 0);
});

test('pond-only restocking requires portal data even when its local switch overrides a disabled global switch', () => {
    const state = stateForProjects(); state.aquatic.buildable_ponds = [];
    state.portals = [{ unlocked: true, tributes: [{ item_id: 'wood', quantity: 20, min_quality: 1 }] }];
    state.aquatic.ponds = [pond('second', 'trout')];
    state.aquatic.species = [{ id: 'trout', unlocked: true, owned_fry: 20, fry_item: { item_id: 'wood' } }];
    const x = setup(state);
    for (const key of ['farming', 'gathering', 'mining', 'crafting', 'commissions', 'refining', 'livestock', 'feed', 'sailing']) {
        x.h.CONFIG[key].enabled = false;
    }
    x.h.CONFIG.aquatic.autoStockPonds = false;
    x.h.CONFIG.aquatic.autoBuildPonds = false;
    x.a.setPondSetting('second', 'autoStock', true);
    const previous = x.h.runtime.state; delete x.backend.portals;
    assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /portals/.test(error.message));
    assert.equal(x.h.runtime.state, previous, 'a missing protection source cannot replace the last confirmed state');
});

test('a locally authorized pond partner assignment requires partner records when every global assignment is disabled', () => {
    const state = stateForProjects(); state.aquatic.buildable_ponds = [];
    state.aquatic.ponds = [pond('second', 'trout')];
    const x = setup(state);
    for (const key of ['farming', 'gathering', 'mining', 'crafting', 'commissions', 'refining', 'livestock', 'feed', 'sailing']) {
        x.h.CONFIG[key].enabled = false;
    }
    x.h.CONFIG.aquatic.autoAssignPartner = false;
    x.a.setPondSetting('second', 'autoAssignPartner', true);
    const previous = x.h.runtime.state; delete x.backend.partners;
    assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /partners/.test(error.message));
    assert.equal(x.h.runtime.state, previous);
    x.a.setPondSetting('second', 'enabled', false);
    assert.doesNotThrow(() => x.sync(), 'a paused pond must not create a partner-data requirement by its local switch alone');
});

test('building a pond uses its own four materials while preserving tasks, another facility, crafting and refining', async () => {
    const state = stateForProjects(15);
    state.portals = [{ unlocked: true, tributes: [{ item_id: 'wood', quantity: 2, min_quality: 1 }] }];
    state.commissions = { commission: { item_id: 'wood', quantity: 1 } };
    const x = setup(state); x.reserve('farm'); x.reserve('pond'); authorizeCraft(x); authorizeRefining(x); x.build();
    assert.equal(x.available({ kind: 'pond', id: 'shared' }), 4);
    await x.a.doPonds();
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/ponds/shared/build'));
    assert.equal(x.backend.inventory[0].quantity, 11);
    assert.equal(x.available(), 0, 'all remaining wood belongs to the other purposes');
});

test('a one-unit construction shortfall cannot consume another task or project reserve', async () => {
    const x = setup(stateForProjects(6)); x.reserve('farm'); x.reserve('pond'); x.build();
    await x.a.doPonds(); assert.equal(x.calls.length, 0);
    assert.equal(x.available({ kind: 'pond', id: 'shared' }), 3);
});

test('unspecified construction consumption preserves an exact high-quality refining input stack', async () => {
    const x = setup(stateForProjects(20)); x.backend.inventory.push({ item_id: 'wood', quality: 2, quantity: 2 });
    authorizeRefining(x, 2); x.reserve('pond'); x.build();
    assert.equal(x.available({ kind: 'pond', id: 'shared' }), 0);
    await x.a.doPonds(); assert.equal(x.calls.length, 0);
});

test('turning off another construction after the first build prevents paying for that second pond', async () => {
    const state = stateForProjects();
    state.aquatic.buildable_ponds.push({ ...state.aquatic.buildable_ponds[0], id: 'third' });
    const x = setup(state); x.build(); x.build('third');
    x.after(req => { if (req.url.endsWith('/ponds/shared/build')) x.h.setOverride('rlt-pond-build:third', 'off'); });
    await x.a.doPonds();
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/ponds/shared/build'));
});

test('pre-write refresh revokes an obsolete construction authorization before any build request', async () => {
    const x = setup(); x.build(); x.h.runtime.stateUncertain = true;
    x.before(req => { if (req.url.endsWith('/state')) x.h.setOverride('rlt-pond-build:shared', 'off'); return null; });
    await x.a.doPonds(); assert.deepEqual(x.calls.map(req => req.method), ['GET']);
});

test('turning off pond management during harvest preserves the new state and prevents restocking', async () => {
    const state = stateForProjects(); state.aquatic.buildable_ponds = [];
    state.aquatic.ponds = [pond('second', 'trout', 35)];
    state.aquatic.species = [{ id: 'carp', unlocked: true, owned_fry: 50 }, { id: 'trout', unlocked: true, owned_fry: 50 }];
    const x = setup(state);
    x.after(req => { if (req.url.endsWith('/harvest')) x.a.setPondSetting('second', 'enabled', false); });
    await x.a.doPonds(); assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/harvest'));
    assert.equal(x.backend.aquatic.ponds[0].population, 30);
    assert.equal(x.backend.aquatic.species[1].owned_fry, 50);
});

test('pond and plot settings changed during another plot harvest are respected later in the same pass', async () => {
    const state = stateForProjects();
    state.plots.forEach(plot => Object.assign(plot, { empty: false, ready: true }));
    state.aquatic.buildable_ponds = []; state.aquatic.ponds = [pond('second', 'trout')];
    state.aquatic.species = [{ id: 'trout', unlocked: true, owned_fry: 50 }];
    const x = setup(state);
    x.after(req => {
        if (req.url.endsWith('/plots/0/harvest')) {
            x.h.setOverride('rlt-plot-mode:1', 'manual'); x.a.setPondSetting('second', 'enabled', false);
        }
    });
    await x.a.collectReadyPlots(); await x.a.doPonds();
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/plots/0/harvest'));
    assert.equal(x.backend.plots[1].ready, true);
});

test('a manual farm upgrade is a single request and may spend its own reservation', async () => {
    const x = setup(stateForProjects(3)); x.reserve('farm');
    assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared'), true);
    assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared'), false);
    await x.a.processFacilityUpgrade(); await x.a.processFacilityUpgrade();
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/facilities/shared'));
    assert.equal(x.backend.plots[0].size, 2); assert.equal(x.backend.inventory[0].quantity, 0);
    assert.equal(x.h.runtime.facilityUpgrade, null); assert.equal(x.h.getOverride('rlt-facility-upgrade-intent'), null);
});

test('manual farm construction preserves a pond project even when both project ids are equal', () => {
    const x = setup(stateForProjects(6)); x.reserve('farm'); x.reserve('pond');
    assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared'), false);
    assert.equal(x.h.runtime.facilityUpgrade, undefined);
    assert.equal(x.calls.length, 0);
});

test('a queued farm upgrade cannot keep a partner from another plot', async () => {
    const state = stateForProjects();
    state.plots[0].assigned_partner_ids = ['first']; state.plots[1].assigned_partner_ids = ['second'];
    state.plots.push({ slot: 2, size: 1, empty: true, assigned_partner_ids: ['outsider'] });
    const x = setup(state);
    assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared', 'outsider'), false);
    assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared', 'second'), true);
    await x.a.processFacilityUpgrade();
    assert.equal(x.calls[0].payload.partner_id, 'second');
});

test('a farm upgrade whose two plots or retained partner changed is rejected before sending', async () => {
    for (const change of [state => { state.plots[0].empty = false; }, state => { state.plots[0].assigned_partner_ids = []; }]) {
        const state = stateForProjects(); state.plots[0].assigned_partner_ids = ['first'];
        const x = setup(state); assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared', 'first'), true);
        change(x.backend); x.sync(); await x.a.processFacilityUpgrade();
        assert.equal(x.calls.length, 0); assert.equal(x.h.runtime.facilityUpgrade, null);
    }
});

test('a pre-write refresh cannot submit the old farm upgrade fingerprint', async () => {
    const x = setup(); assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared'), true);
    x.h.runtime.stateUncertain = true; x.backend.facilities.upgrades[0].coins = 30;
    await assert.rejects(x.a.processFacilityUpgrade(), error => error.code === 'aborted');
    assert.deepEqual(x.calls.map(req => req.method), ['GET']);
    assert.equal(x.h.getOverride('rlt-facility-upgrade-intent'), null);
});

test('a lost farm upgrade response leaves an uncertainty journal and cannot be queued again after refresh', async () => {
    const x = setup(); assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared'), true);
    x.before(req => { if (req.url.endsWith('/facilities/shared')) throw new Error('response lost'); return null; });
    await assert.rejects(x.a.processFacilityUpgrade(), error => error.code === 'network_error');
    assert.equal(JSON.parse(x.h.getOverride('rlt-facility-upgrade-intent')).phase, 'uncertain');
    assert.equal(x.calls.filter(req => req.method === 'POST').length, 1);
    const restored = setup(x.backend, [...x.storage]);
    assert.equal(restored.a.queueFacilityUpgrade(restored.h.runtime.state, 'shared'), false);
    await restored.a.processFacilityUpgrade(); assert.equal(restored.calls.length, 0);
});

test('a successful HTTP response without the merged plot remains uncertain instead of claiming completion', async () => {
    const x = setup(); assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared'), true);
    x.before(req => req.url.endsWith('/facilities/shared') ? x.response() : null);
    await assert.rejects(x.a.processFacilityUpgrade(), error => error.code === 'invalid_state');
    assert.equal(JSON.parse(x.h.getOverride('rlt-facility-upgrade-intent')).phase, 'uncertain');
    assert.equal(x.a.queueFacilityUpgrade(x.h.runtime.state, 'shared'), false);
});
