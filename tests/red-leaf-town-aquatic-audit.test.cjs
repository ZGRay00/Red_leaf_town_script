const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const boundary = shared.indexOf('async function run()');
assert.ok(boundary > 0, 'shared harness boundary exists');
const harnessSource = shared.slice(0, boundary).replace('doAquaticFeed, doSailing,',
    'doAquaticPartners, doPonds, doLivestock, doFishing, doAquaticFeed, doSailing,');
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);
const partner = (id, industry) => ({ partner_id: id, name: id, tendencies: [{ industry, effective_ability: 10 }] });

test('disabled fishing and pond management cannot assign aquatic partners', async () => {
    const state = fixture(); state.partners = [partner('p1', 'aquatic')]; state.aquatic.ponds = [{ pond_id: 'pond1' }];
    const x = harness(state); Object.assign(x.h.CONFIG.aquatic, { fishing: false, ponds: false });
    await x.h.doAquaticPartners(); assert.equal(x.calls.length, 0);
});

test('fishing may assign a companion while pond management is disabled', async () => {
    const state = fixture(); state.partners = [partner('p1', 'aquatic'), partner('p2', 'aquatic')]; state.aquatic.ponds = [{ pond_id: 'pond1' }];
    const x = harness(state); x.h.CONFIG.aquatic.ponds = false; x.setResponder(() => x.response());
    await x.h.doAquaticPartners(); assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/fishing/companion']);
});

test('zero aquatic capacity allows neither companion nor pond assignment', async () => {
    const state = fixture(); state.partners = [partner('p1', 'aquatic')]; state.industry_rules.aquatic = { partner_capacity: 0 };
    state.aquatic.ponds = [{ pond_id: 'pond1' }];
    const x = harness(state); await x.h.doAquaticPartners(); assert.equal(x.calls.length, 0);
});

test('zero livestock capacity prevents facility assignment', async () => {
    const state = fixture(); state.partners = [partner('p1', 'livestock')]; state.industry_rules.livestock = { partner_capacity: 0 };
    state.livestock.facilities = [{ facility_id: 'barn1' }];
    const x = harness(state); await x.h.doLivestock(); assert.equal(x.calls.length, 0);
});

test('omitted capacity retains assignment support for both industries', async () => {
    const state = fixture(); state.partners = [partner('p1', 'aquatic'), partner('p2', 'livestock')];
    state.livestock.facilities = [{ facility_id: 'barn1' }];
    const x = harness(state); x.setResponder(() => x.response()); await x.h.doAquaticPartners(); await x.h.doLivestock();
    assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/fishing/companion', '/api/red-leaf-town/livestock/facilities/barn1/partner']);
});

test('a newly assigned companion consumes the last aquatic capacity', async () => {
    const state = fixture(); state.partners = [partner('p1', 'aquatic'), partner('p2', 'aquatic')]; state.industry_rules.aquatic = { partner_capacity: 1 };
    state.aquatic.ponds = [{ pond_id: 'pond1' }];
    const x = harness(state); x.setResponder(() => x.response()); await x.h.doAquaticPartners();
    assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/fishing/companion'));
});

test('pending pond assignments already consume aquatic capacity', async () => {
    const state = fixture(); state.partners = [partner('p1', 'aquatic'), partner('p2', 'aquatic')]; state.industry_rules.aquatic = { partner_capacity: 1 };
    state.aquatic.ponds = [{ pond_id: 'pond1', pending_partner_ids: ['p1'] }, { pond_id: 'pond2' }];
    const x = harness(state); await x.h.doAquaticPartners(); assert.equal(x.calls.length, 0);
});

test('disabling pond management while companion assignment is pending stops further assignments', async () => {
    const state = fixture(); state.partners = [partner('p1', 'aquatic'), partner('p2', 'aquatic')]; state.aquatic.ponds = [{ pond_id: 'pond1' }];
    const x = harness(state); x.setResponder(() => { x.h.CONFIG.aquatic.ponds = false; return x.response(); });
    await x.h.doAquaticPartners(); assert.equal(x.calls.length, 1);
});

test('disabling livestock assignment during the first request prevents the next assignment', async () => {
    const state = fixture(); state.partners = [partner('p1', 'livestock'), partner('p2', 'livestock')];
    state.livestock.facilities = [{ facility_id: 'barn1' }, { facility_id: 'barn2' }];
    const x = harness(state); x.setResponder(() => { x.h.CONFIG.livestock.autoAssignPartner = false; return x.response(); });
    await x.h.doLivestock(); assert.equal(x.calls.length, 1);
});

test('a restock target of zero cannot turn into filling the entire pond', async () => {
    const state = fixture(); state.aquatic.ponds = [{ pond_id: 'pond1', stock: 0, population: 0, capacity: 50 }];
    state.aquatic.species = [{ id: 'fish1', unlocked: true, owned_fry: 50 }];
    const x = harness(state); x.h.CONFIG.aquatic.pondRestockTarget = 0;
    await x.h.doPonds(); assert.equal(x.calls.length, 0);
});

test('positive restock target is still bounded by capacity and current population', async () => {
    const state = fixture(); state.aquatic.ponds = [{ pond_id: 'pond1', stock: 5, population: 10, capacity: 30 }];
    state.aquatic.species = [{ id: 'fish1', unlocked: true, owned_fry: 50 }];
    const x = harness(state); x.h.CONFIG.aquatic.pondRestockTarget = 37; x.setResponder(() => x.response());
    await x.h.doPonds(); assert.equal(x.calls.length, 1); assert.equal(x.calls[0].payload.quantity, 20);
});

test('big-catch rate limiting stops the chain without recasting over the unresolved catch', async () => {
    const state = fixture(); state.aquatic.spots = [{ id: 'spot1', unlocked: true, stamina_cost: 1 }];
    const x = harness(state); Object.assign(x.h.CONFIG.aquatic, { chainCasts: 1, castIntervalMs: 0 });
    x.setResponder(req => {
        if (req.url.endsWith('/cast')) {
            x.backend.aquatic.pending_big_catch = { name: 'fish', chance: 1, stamina_cost: 1 }; return x.response({ big_catch: true });
        }
        return { ok: false, status: 429, headers: { get: () => '2' }, json: async () => ({ message: 'rate limited' }) };
    });
    await assert.rejects(x.h.doFishing(), error => error.status === 429);
    assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/fishing/spots/spot1/cast', '/api/red-leaf-town/fishing/big-catch']);
    assert.ok(x.h.runtime.state.aquatic.pending_big_catch);
});

test('disabling automatic building during the first request prevents paying for a second pond', async () => {
    const state = fixture(); state.aquatic.buildable_ponds = [{ id: 'pond1', unlocked: true, affordable: true }, { id: 'pond2', unlocked: true, affordable: true }];
    const x = harness(state); x.h.CONFIG.aquatic.autoBuildPonds = true;
    x.setResponder(() => { x.h.CONFIG.aquatic.autoBuildPonds = false; return x.response(); });
    await x.h.doPonds(); assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/ponds/pond1/build']);
});

test('disabling pond management after harvesting prevents restocking and processing other ponds', async () => {
    const state = fixture(); state.aquatic.ponds = [
        { pond_id: 'pond1', stock: 40, population: 40, capacity: 50 }, { pond_id: 'pond2', stock: 40, population: 40, capacity: 50 },
    ];
    state.aquatic.species = [{ id: 'fish1', unlocked: true, owned_fry: 50 }];
    const x = harness(state);
    x.setResponder(() => {
        x.backend.aquatic.ponds[0].stock = x.backend.aquatic.ponds[0].population = 30;
        x.h.CONFIG.aquatic.ponds = false; return x.response();
    });
    await x.h.doPonds(); assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/ponds/pond1/harvest']);
});

test('disabling stocking while harvest is pending prevents the next stock request', async () => {
    const state = fixture(); state.aquatic.ponds = [{ pond_id: 'pond1', stock: 40, population: 40, capacity: 50 }];
    state.aquatic.species = [{ id: 'fish1', unlocked: true, owned_fry: 50 }];
    const x = harness(state);
    x.setResponder(() => {
        x.backend.aquatic.ponds[0].stock = x.backend.aquatic.ponds[0].population = 30;
        x.h.CONFIG.aquatic.autoStockPonds = false; return x.response();
    });
    await x.h.doPonds(); assert.equal(x.calls.length, 1); assert.ok(x.calls[0].url.endsWith('/harvest'));
});

test('livestock collection rechecks its switch before each facility request', async () => {
    const state = fixture(); state.livestock.facilities = [{ facility_id: 'barn1', pending_total: 1 }, { facility_id: 'barn2', pending_total: 1 }];
    const x = harness(state); x.setResponder(() => { x.h.CONFIG.livestock.autoCollect = false; return x.response(); });
    await x.h.doLivestock(); assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/livestock/facilities/barn1/collect']);
});

test('livestock care rechecks its switch before each animal request', async () => {
    const state = fixture(); state.livestock.facilities = [{ facility_id: 'barn1', animals: ['a1', 'a2'].map(id => ({
        animal_id: id, care_daily_limit: 1, cared_today: 0, affection: 0, affection_cap: 100,
    })) }];
    const x = harness(state); x.h.CONFIG.livestock.autoCare = true;
    x.setResponder(() => { x.h.CONFIG.livestock.autoCare = false; return x.response(); });
    await x.h.doLivestock(); assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/livestock/animals/a1/care']);
});

test('livestock master switch stops remaining assignments, collection and care', async () => {
    const state = fixture(); state.partners = [partner('p1', 'livestock'), partner('p2', 'livestock')];
    state.livestock.facilities = ['barn1', 'barn2'].map(id => ({ facility_id: id, pending_total: 1, animals: [{
        animal_id: `${id}-animal`, care_daily_limit: 1, cared_today: 0, affection: 0, affection_cap: 100,
    }] }));
    const x = harness(state); x.h.CONFIG.livestock.autoCare = true;
    x.setResponder(() => { x.h.CONFIG.livestock.enabled = false; return x.response(); });
    await x.h.doLivestock(); assert.deepEqual(x.calls.map(row => row.url), ['/api/red-leaf-town/livestock/facilities/barn1/partner']);
});

test('zero cast interval still waits at least 1500 ms after throttling and honors Retry-After', async () => {
    for (const [retryHeader, expectedDelay] of [[null, 1500], ['5', 5000]]) {
        const state = fixture(); state.aquatic.spots = [{ id: 'spot1', unlocked: true, stamina_cost: 1 }];
        const x = harness(state); Object.assign(x.h.CONFIG.aquatic, { chainCasts: 1, castIntervalMs: 0 });
        const waits = []; let requests = 0;
        x.context.setTimeout = (callback, delay) => {
            if (delay === x.h.CONFIG.requestTimeout) return setTimeout(callback, delay);
            waits.push(delay); return setTimeout(callback, 0);
        };
        x.setResponder(() => ++requests === 1
            ? { ok: false, status: 429, headers: { get: () => retryHeader }, json: async () => ({ message: 'rate limited' }) }
            : x.response());
        await x.h.doFishing(); assert.equal(requests, 2); assert.deepEqual(waits, [expectedDelay]);
    }
});
