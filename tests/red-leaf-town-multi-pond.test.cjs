const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const harnessSource = shared.slice(0, shared.indexOf('async function run()')).replace('doAquaticFeed, doSailing,',
    'doPonds, doAquaticPartners, pondSettings, setPondSetting, pondBuildEnabled, pondStockPlan, pondBuildPlan, renderPondSettings, doAquaticFeed, doSailing,');
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);

function setup(entries = []) {
    const state = fixture();
    state.inventory = [
        { item_id: 'carp-fry', name: '鲤鱼苗', quality: 1, quantity: 30 },
        { item_id: 'bass-fry', name: '鲈鱼苗', quality: 1, quantity: 80 },
        { item_id: 'wood', name: '木材', quality: 1, quantity: 20 },
    ];
    state.aquatic.species = [
        { id: 'carp', name: '鲤鱼', unlocked: true, owned_fry: 30, fry_item: { item_id: 'carp-fry', name: '鲤鱼苗' } },
        { id: 'bass', name: '鲈鱼', unlocked: true, owned_fry: 80, fry_item: { item_id: 'bass-fry', name: '鲈鱼苗' } },
    ];
    state.aquatic.ponds = [
        { pond_id: 'pond1', definition: { name: '第一鱼塘', species_id: 'carp' }, species_id: 'carp', stock: 40, population: 45,
            fry: [{ count: 5 }], capacity: 50, steady_stock: 30, assigned_partners: [], assigned_partner_ids: [] },
        { pond_id: 'pond2', definition: { name: '第二鱼塘', species_id: 'bass' }, species_id: null, stock: 0, population: 0,
            fry: [], capacity: 100, steady_stock: 30, assigned_partners: [], assigned_partner_ids: [] },
    ];
    state.aquatic.buildable_ponds = [];
    state.partners = ['p1', 'p2', 'p3'].map(partner_id => ({ partner_id, name: partner_id,
        tendencies: [{ industry: 'aquatic', effective_ability: 10 }] }));
    const x = harness(state, entries);
    x.h.CONFIG.aquatic.fishing = false;
    x.configure = (id, settings) => Object.entries(settings).forEach(([key, value]) => x.h.setPondSetting(id, key, value));
    x.authorize = (id, value = 'on') => x.h.setOverride(`rlt-pond-build:${id}`, value);
    x.step = async () => { x.h.runtime.actionCount = 0; await x.h.doPonds(); };
    x.assign = async () => { x.h.runtime.actionCount = 0; await x.h.doAquaticPartners(); };
    x.harvests = () => x.calls.filter(req => req.url.endsWith('/harvest'));
    x.stocks = () => x.calls.filter(req => req.url.endsWith('/stock'));
    x.builds = () => x.calls.filter(req => req.url.endsWith('/build'));
    x.respond = req => {
        if (req.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        const match = req.url.match(/\/ponds\/([^/]+)\/(harvest|stock|partner|build)$/);
        assert.ok(match, `unexpected network ${req.url}`);
        const [, id, action] = match;
        if (action === 'build') {
            const site = x.backend.aquatic.buildable_ponds.find(site => site.id === id);
            assert.ok(site); x.backend.player.coins -= site.build_cost || 0;
            for (const material of site.build_materials || []) {
                const stack = x.backend.inventory.find(item => item.item_id === material.item_id);
                assert.ok(stack && stack.quantity >= material.quantity); stack.quantity -= material.quantity;
            }
            x.backend.aquatic.buildable_ponds = x.backend.aquatic.buildable_ponds.filter(site => site.id !== id);
            x.backend.aquatic.ponds.push({ pond_id: id, definition: { name: site.name, species_id: site.species_id },
                stock: 0, population: 0, capacity: site.capacity, steady_stock: 30, assigned_partners: [] });
        } else {
            const pond = x.backend.aquatic.ponds.find(pond => pond.pond_id === id);
            assert.ok(pond);
            if (action === 'harvest') {
                assert.ok(req.payload.quantity <= pond.stock);
                pond.stock -= req.payload.quantity; pond.population -= req.payload.quantity;
            } else if (action === 'stock') {
                assert.equal(req.payload.species_id, pond.species_id ?? pond.definition.species_id);
                assert.ok(pond.population + req.payload.quantity <= pond.capacity);
                const species = x.backend.aquatic.species.find(species => species.id === req.payload.species_id);
                assert.ok(species.owned_fry >= req.payload.quantity);
                species.owned_fry -= req.payload.quantity;
                x.backend.inventory.find(item => item.item_id === species.fry_item.item_id).quantity -= req.payload.quantity;
                pond.population += req.payload.quantity; pond.species_id = species.id;
            } else {
                pond.assigned_partner_ids = [req.payload.partner_id];
                pond.assigned_partners = [x.backend.partners.find(partner => partner.partner_id === req.payload.partner_id)];
            }
        }
        return x.response();
    };
    x.setResponder(x.respond);
    return x;
}

test('both ponds inherit global defaults and the second empty pond uses its own defined fish', async () => {
    const x = setup(); await x.step();
    assert.deepEqual(x.harvests().map(req => req.payload.quantity), [10]);
    assert.deepEqual(x.stocks().map(req => [req.payload.species_id, req.payload.quantity]), [['carp', 2], ['bass', 37]]);
});

test('per-pond quantities and switches persist independently across reloads', async () => {
    const x = setup(); x.configure('pond1', { keepStock: 38, restockTarget: 45 }); x.configure('pond2', { restockTarget: 60 });
    const y = setup([...x.storage]); await y.step();
    assert.deepEqual(y.harvests().map(req => req.payload.quantity), [2]);
    assert.deepEqual(y.stocks().map(req => [req.payload.species_id, req.payload.quantity]), [['carp', 2], ['bass', 60]]);
});

test('disabling one pond stops harvesting stocking and assignment only for that pond', async () => {
    const x = setup(); x.configure('pond1', { enabled: false }); await x.assign(); await x.step();
    assert.ok(x.calls.length > 0); assert.ok(x.calls.every(req => req.url.includes('/pond2/')));
});

test('per-pond collection stocking and assignment may override disabled global defaults', async () => {
    const x = setup(); Object.assign(x.h.CONFIG.aquatic, { autoHarvestPonds: false, autoStockPonds: false, autoAssignPartner: false });
    x.configure('pond1', { autoHarvest: true, autoStock: true, autoAssignPartner: true });
    await x.assign(); await x.step();
    assert.deepEqual(x.calls.map(req => req.url.split('/').at(-1)), ['partner', 'harvest', 'stock']);
    assert.ok(x.calls.every(req => req.url.includes('/pond1/')));
});

test('global aquatic and pond masters still stop explicitly enabled per-pond settings', async () => {
    for (const key of ['enabled', 'ponds']) {
        const x = setup(); x.configure('pond1', { enabled: true, autoHarvest: true, autoStock: true, autoAssignPartner: true });
        x.h.CONFIG.aquatic[key] = false; await x.assign(); await x.step(); assert.equal(x.calls.length, 0);
    }
});

test('per-pond harvest never crosses the server steady-stock line', async () => {
    const x = setup(); x.configure('pond1', { keepStock: 0, autoStock: false }); x.configure('pond2', { enabled: false });
    await x.step(); assert.equal(x.harvests()[0].payload.quantity, 10); assert.equal(x.backend.aquatic.ponds[0].stock, 30);
});

test('a per-pond restock target of zero does not fill to capacity', async () => {
    const x = setup(); x.configure('pond2', { restockTarget: 0 }); await x.step();
    assert.ok(x.stocks().every(req => req.payload.species_id !== 'bass'));
});

test('a configured fish cannot replace an existing or fixed pond species', async () => {
    const x = setup(); x.configure('pond1', { autoHarvest: false, speciesId: 'bass' }); x.configure('pond2', { speciesId: 'carp' });
    await x.step(); assert.equal(x.calls.length, 0);
    assert.ok(x.h.logBox.children.some(row => /不会自动换种/.test(row.textContent)));
});

test('an empty pond with multiple species and missing pond definition waits instead of guessing', async () => {
    const x = setup(); x.backend.aquatic.ponds = [x.backend.aquatic.ponds[1]];
    delete x.backend.aquatic.ponds[0].definition.species_id; x.sync(); await x.step(); assert.equal(x.calls.length, 0);
});

test('the next pond uses the population from the previous response', async () => {
    const x = setup(); x.setResponder(req => {
        if (req.url.endsWith('/harvest')) x.backend.aquatic.ponds[1].population = 80;
        return x.respond(req);
    });
    await x.step(); assert.ok(x.stocks().every(req => req.payload.species_id !== 'bass'));
});

test('removing a later pond during an earlier response never sends a stale pond request', async () => {
    const x = setup(); x.setResponder(req => {
        if (req.url.endsWith('/harvest')) x.backend.aquatic.ponds = x.backend.aquatic.ponds.filter(pond => pond.pond_id !== 'pond2');
        return x.respond(req);
    });
    await x.step(); assert.ok(x.calls.every(req => !req.url.includes('/pond2/')));
});

test('a setting changed during harvest is honored before restocking the same pond', async () => {
    const x = setup(); x.configure('pond2', { enabled: false }); x.setResponder(req => {
        if (req.url.endsWith('/harvest')) x.configure('pond1', { autoStock: false });
        return x.respond(req);
    });
    await x.step(); assert.equal(x.harvests().length, 1); assert.equal(x.stocks().length, 0);
});

test('resynchronization before a write invalidates its old pond quantities', async () => {
    const x = setup(); x.h.runtime.stateUncertain = true;
    x.backend.aquatic.ponds[0].stock = 30; x.backend.aquatic.ponds[0].population = 37;
    await x.step(); assert.equal(x.calls.length, 1); assert.equal(x.calls[0].method, 'GET');
});

test('pond fry consumption also protects explicit inventory and tribute reservations', async () => {
    const x = setup(); x.configure('pond1', { enabled: false });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'bass-fry', quantity: 60, min_quality: 1 }] }];
    x.h.CONFIG.selling.keepByItemId['bass-fry'] = 15; x.sync();
    await x.step(); assert.equal(x.stocks()[0].payload.quantity, 5);
});

test('pond assignment recalculates idle partners after each response', async () => {
    const x = setup(); x.setResponder(req => {
        if (req.url.endsWith('/pond1/partner')) {
            x.backend.partners.find(partner => partner.partner_id === 'p2').locked = true;
        }
        return x.respond(req);
    });
    await x.assign(); assert.deepEqual(x.calls.map(req => req.payload.partner_id), ['p1', 'p3']);
});

test('pending partners occupy their ponds and industry capacity', async () => {
    const x = setup(); x.backend.aquatic.ponds[1].pending_partner_ids = ['p2'];
    x.backend.industry_rules.aquatic = { partner_capacity: 1 }; x.sync();
    await x.assign(); assert.equal(x.calls.length, 0);
});

function site(id, overrides = {}) {
    return { id, name: `鱼塘 ${id}`, species_id: 'bass', capacity: 80, build_cost: 100, build_materials: [], unlocked: true, affordable: true, ...overrides };
}

test('new build sites are not authorized by default', async () => {
    const x = setup(); x.backend.aquatic.ponds = []; x.backend.aquatic.buildable_ponds = [site('new1'), site('new2')]; x.sync();
    await x.step(); assert.equal(x.builds().length, 0);
});

test('explicit site authorization builds only that site without enabling global automatic construction', async () => {
    const x = setup(); x.backend.aquatic.ponds = []; x.backend.aquatic.buildable_ponds = [site('new1'), site('new2')];
    x.authorize('new2'); x.sync(); await x.step();
    assert.equal(x.h.CONFIG.aquatic.autoBuildPonds, false);
    assert.deepEqual(x.builds().map(req => req.url), ['/api/red-leaf-town/ponds/new2/build']);
});

test('site authorization persists while a local denial overrides the global build default', async () => {
    const x = setup(); x.authorize('new1', 'off'); x.h.CONFIG.aquatic.autoBuildPonds = true;
    const y = setup([...x.storage]); y.backend.aquatic.ponds = [];
    y.backend.aquatic.buildable_ponds = [site('new1'), site('new2')]; y.sync(); await y.step();
    assert.deepEqual(y.builds().map(req => req.url), ['/api/red-leaf-town/ponds/new2/build']);
});

test('building rechecks the current coin balance for each site even if affordable flags are stale', async () => {
    const x = setup(); x.backend.aquatic.ponds = []; x.backend.player.coins = 150;
    x.backend.aquatic.buildable_ponds = [site('new1'), site('new2')]; x.authorize('new1'); x.authorize('new2'); x.sync();
    await x.step(); assert.equal(x.builds().length, 1); assert.equal(x.backend.player.coins, 50);
});

test('duplicate build material rows are checked as one total and cannot bypass protection', async () => {
    const x = setup(); x.backend.aquatic.ponds = []; x.backend.aquatic.buildable_ponds = [site('new1', {
        build_materials: [{ item_id: 'wood', quantity: 12 }, { item_id: 'wood', quantity: 12 }],
    })]; x.authorize('new1'); x.sync(); await x.step(); assert.equal(x.builds().length, 0);
});

test('present but malformed building materials prevent construction', async () => {
    for (const build_materials of [null, {}, [{ item_id: 'wood', quantity: 1.5 }], [{ quantity: 1 }], [{ item_id: 'wood', quantity: -1 }]]) {
        const x = setup(); x.backend.aquatic.ponds = []; x.backend.aquatic.buildable_ponds = [site('new1', { build_materials })];
        x.authorize('new1'); x.sync(); await x.step(); assert.equal(x.builds().length, 0);
    }
});

test('build authorization revoked during a previous construction prevents the next one', async () => {
    const x = setup(); x.backend.aquatic.ponds = []; x.backend.aquatic.buildable_ponds = [site('new1'), site('new2')];
    x.authorize('new1'); x.authorize('new2'); x.sync();
    x.setResponder(req => {
        if (req.url.endsWith('/new1/build')) x.authorize('new2', 'off');
        return x.respond(req);
    });
    await x.step(); assert.equal(x.builds().length, 1);
});

test('each existing pond and each build site has its own rendered controls', () => {
    const x = setup(); x.backend.aquatic.buildable_ponds = [site('new1'), site('new2')]; x.sync();
    x.h.renderPondSettings(x.h.runtime.state);
    const all = element => [element, ...element.children.flatMap(all)];
    const rows = all(x.h.configBox), labels = label => rows.filter(row => row.attrs?.['aria-label'] === label);
    assert.equal(labels('本塘管理').length, 2); assert.equal(labels('自动收鱼').length, 2);
    assert.equal(labels('自动补苗').length, 2); assert.equal(labels('投苗鱼种').length, 2);
    assert.equal(labels('自动建造本塘').length, 2);
    x.h.setRunning(false);
    const controls = labels('自动收鱼'); controls[1].value = 'off'; controls[1].onchange();
    assert.equal(x.h.pondSettings('pond2').autoHarvest, false); assert.equal(x.h.pondSettings('pond1').autoHarvest, true);
});

test('a site also listed among already built ponds cannot be built again', async () => {
    const x = setup(); x.configure('pond1', { enabled: false }); x.configure('pond2', { enabled: false });
    x.backend.aquatic.buildable_ponds = [site('pond2')]; x.authorize('pond2'); x.sync();
    x.setResponder(() => x.response());
    await x.step(); assert.equal(x.builds().length, 0); assert.equal(x.calls.length, 0);
});

test('authorized pond management rejects a missing built-pond array before constructing anything', () => {
    const x = setup(); x.backend.aquatic.ponds = null;
    x.backend.aquatic.buildable_ponds = [site('new1')]; x.authorize('new1');
    assert.throws(() => x.sync(), error => error.code === 'invalid_state' && /aquatic\.ponds/.test(error.message));
    assert.equal(x.calls.length, 0);
    x.h.CONFIG.aquatic.ponds = false;
    assert.doesNotThrow(() => x.sync(), 'disabled pond management does not require its unused state');
});
