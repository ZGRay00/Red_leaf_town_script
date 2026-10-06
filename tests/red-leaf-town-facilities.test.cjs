const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function setup(state = fixture()) {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        const value = read.call(this, file, ...args);
        return file === sourcePath ? value.replace('if (CONFIG.ui.autoStart) start();', `
            const originalResourceRefiningNeeds = refiningMaterialNeeds;
            refiningMaterialNeeds = state => window.__resourceNeeds ?? originalResourceRefiningNeeds(state);
            window.__resourceAudit = { computeSellables, reservedStacksForItem, refiningAvailableInputQty,
                assignedCount, optimizePartnerAssignments, validateStateSchema, renderFacilitySettings };
            if (CONFIG.ui.autoStart) start();`) : value;
    };
    try { const x = harness(state); x.audit = x.context.window.__resourceAudit; return x; }
    finally { fs.readFileSync = read; }
}
function stateWithFacilities() {
    const state = fixture();
    state.inventory = [{ item_id: 'wood', name: 'wood', quality: 1, quantity: 20, sell_price: 2 }];
    state.facilities = { upgrades: [
        { id: 'farm2', kind: 'farm', name: 'Double plot', coins: 100, inputs: [{ item_id: 'wood', quantity: 6 }] },
        { id: 'feed2', kind: 'feed', name: 'Feed capacity', coins: 100, inputs: [{ item_id: 'wood', quantity: 4 }] },
    ] };
    return state;
}
function reserve(x, kind, id) { x.h.setOverride(`rlt-facility-reserve:${kind}`, id); }
function exact(x, needs) { x.context.window.__resourceNeeds = needs; x.sync(); }
const refineNeed = (slotId, need, quality = 1) => ({ source: 'refining', slotId, itemId: 'wood',
    minQuality: quality, exactQuality: quality, need });

test('only explicitly selected facility stages reserve materials; production needs remain commissions and portals', () => {
    const x = setup(stateWithFacilities());
    assert.equal(x.h.gatherNeeds(x.h.runtime.state).length, 0);
    reserve(x, 'farm', 'farm2');
    assert.equal(x.h.gatherNeeds(x.h.runtime.state).length, 1);
    assert.equal(x.h.gatherNeeds(x.h.runtime.state, { productionOnly: true }).length, 0);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wood'), 9); // 20 - 6 - default keep 5
});
test('facility projects and portal needs add up; surplus selling respects the combined reserve', () => {
    const state = stateWithFacilities();
    state.portals = [{ unlocked: true, tributes: [{ item_id: 'wood', quantity: 3 }] }];
    const x = setup(state); reserve(x, 'farm', 'farm2'); reserve(x, 'feed', 'feed2');
    x.h.CONFIG.selling.allowedItemIds = ['wood'];
    assert.equal(x.audit.computeSellables(x.h.runtime.state)[0].surplus, 2);
});

test('facility UI exposes shared shortages including quality shortages instead of marking each project ready', () => {
    const content = element => [element.textContent || '', ...element.children.map(content)].join(' ');
    for (const highQuality of [false, true]) {
        const state = stateWithFacilities();
        state.inventory[0].quantity = highQuality ? 100 : 20;
        for (const upgrade of state.facilities.upgrades) upgrade.inputs[0].quantity = 20;
        if (highQuality) state.facilities.upgrades[1].inputs[0].min_quality = 3;
        const x = setup(state); reserve(x, 'farm', 'farm2'); reserve(x, 'feed', 'feed2');
        x.audit.renderFacilitySettings(x.h.runtime.state);
        const text = content(x.h.configBox);
        assert.match(text, /已选项目合计 40 件，尚缺 20 件/);
        assert.doesNotMatch(text, /项备齐/);
    }
});
test('switching off facility protection releases only facility needs', () => {
    const state = stateWithFacilities();
    state.portals = [{ unlocked: true, tributes: [{ item_id: 'wood', quantity: 3 }] }];
    const x = setup(state); reserve(x, 'farm', 'farm2'); x.h.setSetting('facilities.reserveMaterials', false);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wood'), 12);
});
test('finishing a stage does not silently reserve the next upgrade', () => {
    const x = setup(stateWithFacilities()); reserve(x, 'farm', 'farm2');
    x.backend.facilities.upgrades[0].id = 'farm3'; x.sync();
    assert.equal(x.h.gatherNeeds(x.h.runtime.state).length, 0);
});
test('missing facility data cannot silently release an active protection', () => {
    const x = setup(stateWithFacilities()); reserve(x, 'farm', 'farm2');
    delete x.backend.facilities;
    assert.throws(() => x.sync(), /facilities.upgrades/);
});
test('malformed selected facility materials reject the snapshot', () => {
    const x = setup(stateWithFacilities()); reserve(x, 'farm', 'farm2');
    x.backend.facilities.upgrades[0].inputs = [{ quantity: 10 }];
    assert.throws(() => x.sync(), /inputs/);
});
test('craft batch respects selected facility raw materials', () => {
    const state = stateWithFacilities();
    state.crafting_stations[0].recipes[0].inputs = [{ item_id: 'wood', quantity: 4 }];
    const x = setup(state); reserve(x, 'farm', 'farm2');
    const node = x.h.runtime.state.crafting_stations[0];
    assert.equal(x.h.craftBatchSize(x.h.runtime.state, node, { job: node.recipes[0] }), 3);
});
test('refining input consumption protects facility materials without applying the default selling floor', () => {
    const x = setup(stateWithFacilities()); reserve(x, 'farm', 'farm2');
    assert.equal(x.audit.refiningAvailableInputQty(x.h.runtime.state, 'wood', 1, 0), 14);
    x.h.CONFIG.selling.keepByItemId = { wood: 3 }; x.h.setSetting('selling.defaultKeep', 6);
    assert.equal(x.audit.refiningAvailableInputQty(x.h.runtime.state, 'wood', 1, 0), 11);
});
test('exact quality reservations do not substitute high quality stacks', () => {
    const state = stateWithFacilities(); state.inventory.push({ item_id: 'wood', quality: 3, quantity: 8 });
    const x = setup(state); exact(x, [refineNeed(0, 20)]);
    const rows = x.audit.reservedStacksForItem(x.h.runtime.state, x.h.runtime.state.inventory, null, { dedicatedFeed: true });
    assert.equal(rows.find(row => row.item.quality === 1).free, 0);
    assert.equal(rows.find(row => row.item.quality === 3).free, 8);
});
test('unspecified consumption stops before touching a reserved exact-quality stack', () => {
    const state = stateWithFacilities(); state.inventory = [
        { item_id: 'wood', quality: 1, quantity: 20 }, { item_id: 'wood', quality: 3, quantity: 5 },
        { item_id: 'wood', quality: 4, quantity: 2 },
    ];
    const x = setup(state); exact(x, [refineNeed(0, 5, 3)]);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wood', '', { applyKeep: false }), 2);
});
test('multiple refining slots get a stable priority rather than reserving each other into deadlock', () => {
    const state = stateWithFacilities(); state.inventory[0].quantity = 6;
    const x = setup(state); exact(x, [refineNeed(0, 6), refineNeed(1, 6)]);
    assert.equal(x.audit.refiningAvailableInputQty(x.h.runtime.state, 'wood', 1, 0), 6);
    assert.equal(x.audit.refiningAvailableInputQty(x.h.runtime.state, 'wood', 1, 1), 0);
});
test('authorized crafting has priority over refining while external consumption still protects refining', () => {
    const state = stateWithFacilities();
    state.crafting_stations[0].recipes[0].inputs = [{ item_id: 'wood', quantity: 4 }];
    const x = setup(state); exact(x, [refineNeed(0, 20)]);
    const node = x.h.runtime.state.crafting_stations[0];
    assert.equal(x.h.craftBatchSize(x.h.runtime.state, node, { job: node.recipes[0] }), 5);
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wood'), 0);
});
test('refining occupancy recognized both from partner flag and embedded room assignment', () => {
    for (const embedded of [false, true]) {
        const state = fixture(); const p = { partner_id: 'p', locked: false, assigned_refining: !embedded,
            tendencies: [{ industry: 'aquatic', effective_ability: 100 }] };
        state.partners = [p]; state.facilities = { refining: { assigned_partner: embedded ? p : null } };
        const x = setup(state);
        assert.equal(x.h.isPartnerIdle(p, x.h.runtime.state), false);
        assert.equal(x.h.sailingPartners(x.h.runtime.state, { required_voyages: 0 }).length, 0);
        assert.equal(x.audit.assignedCount(x.h.runtime.state, 'crafting'), 1);
    }
});
test('refining partner is counted once when both sources identify it', () => {
    const state = fixture(); const p = { partner_id: 'p', assigned_refining: true };
    state.partners = [p]; state.facilities = { refining: { assigned_partner: p } };
    const x = setup(state); assert.equal(x.audit.assignedCount(x.h.runtime.state, 'crafting'), 1);
});
test('production planner does not overfill a crafting roster occupied by refining', async () => {
    const state = fixture();
    state.industry_rules.crafting.partner_capacity = 1;
    state.partners = [{ partner_id: 'refiner', assigned_refining: true, locked: true },
        { partner_id: 'idle', tendencies: [{ industry: 'crafting', effective_ability: 100 }] }];
    const x = setup(state); await x.audit.optimizePartnerAssignments();
    assert.equal(x.calls.length, 0);
});

test('exact-quality safety holds against highest-quality-first consumption across small inventory combinations', () => {
    for (let low = 0; low <= 3; low++) for (let mid = 1; mid <= 3; mid++) for (let high = 0; high <= 3; high++) {
        const state = stateWithFacilities();
        state.inventory = [low, mid, high].map((quantity, i) => ({ item_id: 'wood', quality: i + 1, quantity }));
        const x = setup(state); exact(x, [refineNeed(0, 1, 2)]);
        const allowed = x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wood', '', { applyKeep: false });
        let consume = allowed; const remaining = [...state.inventory].reverse().map(row => {
            const take = Math.min(row.quantity, consume); consume -= take; return { ...row, quantity: row.quantity - take };
        });
        assert.ok(remaining.find(row => row.quality === 2).quantity >= 1);
    }
});
