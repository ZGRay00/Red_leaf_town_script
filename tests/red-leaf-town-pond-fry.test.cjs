const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const harnessSource = shared.slice(0, shared.indexOf('async function run()')).replace('doAquaticFeed, doSailing,',
    'doPonds, pondSettings, setPondSetting, pondStockPlan, doAquaticFeed, doSailing,');
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);

function setup({ stock = 0, population = 0, target = 37, capacity = 50, price = 5,
    coins = 20000, budget = 1000, reserve = 1000, autoBuy = true, entries = [], initial = null } = {}) {
    const state = initial ? structuredClone(initial) : fixture();
    if (!initial) {
        state.player.coins = coins;
        state.inventory = [
            { item_id: 'carp_fry', name: '鲤鱼苗', quality: 1, quantity: 0 },
            { item_id: 'green_carp_fry', name: '青鲤鱼苗', quality: 1, quantity: stock },
        ];
        state.aquatic.species = [
            { id: 'carp', name: '鲤鱼', unlocked: true, owned_fry: 0, fry_item: { item_id: 'carp_fry', name: '鲤鱼苗' } },
            { id: 'green_carp', name: '青鲤', unlocked: true, owned_fry: stock, fry_item: { item_id: 'green_carp_fry', name: '青鲤鱼苗' } },
        ];
        state.aquatic.ponds = [
            { pond_id: 'pond1', definition: { name: '第一鱼塘', species_id: 'carp' }, species_id: 'carp',
                stock: 30, population: 37, fry: [{ count: 7 }], capacity: 50, steady_stock: 30, assigned_partner_ids: [] },
            { pond_id: 'pond2', definition: { name: '第二鱼塘', species_id: 'green_carp' }, species_id: null,
                stock: 0, population, fry: population ? [{ count: population }] : [], capacity, steady_stock: 30, assigned_partner_ids: [] },
        ];
        state.aquatic.buildable_ponds = [];
        state.shop = [
            { id: 'carp-fry-shop', item: { item_id: 'carp_fry', name: '鲤鱼苗' }, price: 3 },
            { id: 'green-carp-fry-shop', item: { item_id: 'green_carp_fry', name: '青鲤鱼苗' }, price },
        ];
    }
    const x = harness(state, entries);
    if (!initial) {
        Object.assign(x.h.CONFIG.aquatic, { fishing: false, autoBuyFry: autoBuy,
            pondCoinReserve: reserve, pondMaxSpendPerTick: budget });
        x.h.setPondSetting('pond2', 'restockTarget', target);
    }
    x.configure = (id, values) => Object.entries(values).forEach(([key, value]) => x.h.setPondSetting(id, key, value));
    x.buys = () => x.calls.filter(req => req.url.endsWith('/shop/buy'));
    x.stocks = () => x.calls.filter(req => req.url.endsWith('/stock'));
    x.step = () => { x.h.runtime.actionCount = 0; return x.h.doPonds(); };
    x.pond = id => x.backend.aquatic.ponds.find(row => row.pond_id === id);
    x.intent = (id = 'pond2') => JSON.parse(x.h.getOverride(`rlt-pond-fry-intent:${id}`) || 'null');
    x.plan = (id = 'pond2') => x.h.pondStockPlan(x.h.runtime.state, x.h.runtime.state.aquatic.ponds.find(row => row.pond_id === id));
    x.soldQuality = 1;
    let before = () => null, after = () => {};
    x.before = fn => { before = fn; }; x.after = fn => { after = fn; };
    const updateOwned = () => {
        for (const species of x.backend.aquatic.species) {
            species.owned_fry = x.backend.inventory.filter(row => row.item_id === (species.fry_item?.item_id ?? species.fry_item?.id))
                .reduce((sum, row) => sum + row.quantity, 0);
        }
    };
    x.respond = async req => {
        const override = await before(req); if (override) return override;
        if (req.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        if (req.url.endsWith('/shop/buy')) {
            const shop = x.backend.shop.find(row => row.id === req.payload.shop_id);
            assert.ok(shop && !shop.locked && shop.unlocked !== false, 'buy only a current unlocked fry entry');
            assert.ok(Number.isSafeInteger(req.payload.quantity) && req.payload.quantity > 0 && req.payload.quantity <= 99);
            const itemId = shop.item?.item_id ?? shop.item_id, name = shop.item?.name ?? shop.name;
            let stack = x.backend.inventory.find(row => row.item_id === itemId && row.quality === x.soldQuality);
            if (!stack) { stack = { item_id: itemId, name, quality: x.soldQuality, quantity: 0 }; x.backend.inventory.push(stack); }
            stack.quantity += req.payload.quantity; x.backend.player.coins -= req.payload.quantity * shop.price;
        } else {
            const match = req.url.match(/\/ponds\/([^/]+)\/(stock|harvest)$/);
            assert.ok(match, `unexpected request ${req.url}`);
            const pond = x.pond(match[1]); assert.ok(pond);
            if (match[2] === 'harvest') {
                assert.ok(pond.stock >= req.payload.quantity); pond.stock -= req.payload.quantity; pond.population -= req.payload.quantity;
            } else {
                assert.equal(req.payload.species_id, pond.species_id ?? pond.definition.species_id, 'stock the fish designated for this pond');
                assert.ok(pond.population + req.payload.quantity <= pond.capacity);
                const species = x.backend.aquatic.species.find(row => row.id === req.payload.species_id);
                let remaining = req.payload.quantity;
                for (const stack of [...x.backend.inventory].filter(row => row.item_id === (species.fry_item.item_id ?? species.fry_item.id))
                    .sort((a, b) => b.quality - a.quality)) {
                    const used = Math.min(stack.quantity, remaining); stack.quantity -= used; remaining -= used;
                }
                assert.equal(remaining, 0, 'stocking consumes only actual inventory');
                pond.population += req.payload.quantity; pond.species_id = species.id;
                pond.fry.push({ count: req.payload.quantity });
            }
        }
        updateOwned(); await after(req); return x.response();
    };
    x.setResponder(x.respond);
    x.reload = () => setup({ entries: [...x.storage], initial: x.backend });
    return x;
}
const reject400 = () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({ message: '暂不可执行' }) });

test('pond fry buying defaults on with a shared 1000-coin allowance and reserve', () => {
    const x = harness();
    assert.equal(x.h.CONFIG.aquatic.autoBuyFry, true);
    assert.equal(x.h.CONFIG.aquatic.pondCoinReserve, 1000); assert.equal(x.h.CONFIG.aquatic.pondMaxSpendPerTick, 1000);
});

test('the second empty pond purchases 青鲤鱼苗 by fry item identity then stocks 青鲤', async () => {
    const x = setup(); await x.step();
    assert.deepEqual(x.buys().map(req => req.payload), [{ shop_id: 'green-carp-fry-shop', quantity: 37 }]);
    assert.deepEqual(x.stocks().map(req => [req.url, req.payload]), [['/api/red-leaf-town/ponds/pond2/stock', { species_id: 'green_carp', quantity: 37 }]]);
    assert.equal(x.pond('pond2').population, 37); assert.equal(x.intent(), null);
});

test('the stock plan separates population, total need, safe owned fry and missing fry', () => {
    const x = setup({ stock: 5, population: 10 }); const plan = x.plan();
    assert.equal(plan.population, 10); assert.equal(plan.need, 27); assert.equal(plan.owned, 5);
    assert.equal(plan.fryId, 'green_carp_fry'); assert.equal(plan.quantity, 5); assert.equal(plan.missing, 22);
});

test('existing fry are combined with only the missing purchase in one stocking request', async () => {
    const x = setup({ stock: 5, population: 10 }); await x.step();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [22]);
    assert.deepEqual(x.stocks().map(req => req.payload.quantity), [27]); assert.equal(x.pond('pond2').population, 37);
});

test('enough inventory fills the pond without buying more fry', async () => {
    const x = setup({ stock: 50 }); await x.step();
    assert.equal(x.buys().length, 0); assert.equal(x.stocks()[0].payload.quantity, 37);
});

test('the target is capped by pond capacity and zero never becomes a full pond', async () => {
    const x = setup({ target: 60, capacity: 40, population: 35 }); await x.step();
    assert.equal(x.buys()[0].payload.quantity, 5); assert.equal(x.pond('pond2').population, 40);
    const empty = setup({ target: 0 }); await empty.step(); assert.equal(empty.calls.length, 0);
});

test('ordinary fry reserved for a tribute remain intact while the exact unreserved deficit is purchased', async () => {
    const x = setup({ stock: 8 });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'green_carp_fry', quantity: 3, min_quality: 1 }] }]; x.sync();
    assert.equal(x.plan().owned, 5); assert.equal(x.plan().missing, 32);
    await x.step(); assert.equal(x.buys()[0].payload.quantity, 32);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'green_carp_fry').quantity, 3);
});

test('an inflated species owned count cannot replace actual safe inventory', async () => {
    const x = setup({ stock: 2 }); x.backend.aquatic.species[1].owned_fry = 999; x.sync();
    await x.step(); assert.equal(x.buys()[0].payload.quantity, 35); assert.equal(x.stocks()[0].payload.quantity, 37);
});

test('missing, null, blank or invalid owned-fry metadata cannot be interpreted as an empty stock to replenish', async () => {
    for (const owned of [undefined, null, '', NaN, -1, 0.5]) {
        const x = setup(); x.backend.aquatic.species[1].owned_fry = owned; x.sync();
        await x.step(); assert.equal(x.calls.length, 0, `owned_fry=${String(owned)}`);
    }
});

test('explicit fry_item.id and top-level shop item_id identify the same 青鲤鱼苗 product', async () => {
    const x = setup();
    x.backend.aquatic.species[1].fry_item = { id: 'green_carp_fry', name: '青鲤鱼苗' };
    x.backend.shop[1] = { id: 'green-carp-fry-shop', item_id: 'green_carp_fry', name: '青鲤鱼苗', price: 5 }; x.sync();
    await x.step(); assert.equal(x.buys()[0].payload.shop_id, 'green-carp-fry-shop');
    assert.equal(x.stocks()[0].payload.species_id, 'green_carp'); assert.equal(x.pond('pond2').population, 37);
});

test('an exact high-quality reservation cannot cause repeated useless ordinary-fry purchases', async () => {
    const x = setup();
    x.backend.inventory.push({ item_id: 'green_carp_fry', name: '青鲤鱼苗', quality: 3, quantity: 1 });
    x.backend.aquatic.species[1].owned_fry = 1;
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'green_carp_fry', quantity: 1, min_quality: 3 }] }]; x.sync();
    await x.step(); await x.step(); await x.step();
    assert.ok(x.buys().length <= 1, 'at most one purchase may discover that its ordinary quality cannot release the protected highest stack');
    assert.equal(x.stocks().length, 0);
    assert.equal(x.backend.inventory.find(row => row.quality === 3).quantity, 1);
});

test('a confirmed purchase newly protected by a keep setting stays confirmed and is not repeated after reload', async () => {
    const x = setup();
    x.after(req => {
        if (req.url.endsWith('/shop/buy')) x.h.CONFIG.selling.keepByItemId.green_carp_fry = 37;
    });
    await x.step();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [37]);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'green_carp_fry').quantity, 37);
    assert.equal(x.intent(), null, 'confirmed inventory delivery does not require manual uncertainty recovery');
    assert.equal(x.stocks().length, 0);
    for (let pass = 0; pass < 3; pass++) await x.step();
    assert.equal(x.buys().length, 1); assert.equal(x.stocks().length, 0); assert.equal(x.intent(), null);
    const restored = x.reload();
    // keepByItemId is script configuration rather than a persisted scalar setting.
    restored.h.CONFIG.selling.keepByItemId.green_carp_fry = 37;
    for (let pass = 0; pass < 3; pass++) await restored.step();
    assert.equal(restored.calls.length, 0); assert.equal(restored.intent(), null);
    assert.equal(restored.pond('pond2').population, 0);
});

test('confirmed ordinary fry held behind a protected high-quality stack resume stocking when the protection ends', async () => {
    const x = setup();
    x.backend.inventory.push({ item_id: 'green_carp_fry', name: '青鲤鱼苗', quality: 3, quantity: 1 });
    x.backend.aquatic.species[1].owned_fry = 1;
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'green_carp_fry', quantity: 1, min_quality: 3 }] }]; x.sync();
    await x.step();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [37]);
    assert.equal(x.intent(), null, 'a useless but confirmed purchase is separate from an unknown network result');
    assert.equal(x.stocks().length, 0);
    for (let pass = 0; pass < 3; pass++) await x.step();
    assert.equal(x.buys().length, 1); assert.equal(x.stocks().length, 0);
    const restored = x.reload(); await restored.step();
    assert.equal(restored.calls.length, 0); assert.equal(restored.intent(), null);
    assert.equal(restored.backend.inventory.find(row => row.quality === 3).quantity, 1);
    restored.backend.portals[0].completed = true; restored.sync();
    await restored.step();
    assert.equal(restored.buys().length, 0, 'existing confirmed inventory becomes usable without buying again');
    assert.deepEqual(restored.stocks().map(req => req.payload.quantity), [37]);
    assert.equal(restored.pond('pond2').population, 37); assert.equal(restored.intent(), null);
});

test('a local buy switch can override the global setting and persists after reload', async () => {
    const x = setup({ autoBuy: false }); x.configure('pond2', { autoBuyFry: true });
    const restored = x.reload(); assert.equal(restored.h.pondSettings('pond2').autoBuyFry, true);
    await restored.step(); assert.equal(restored.buys().length, 1);
});

test('disabling local purchases still permits existing safe fry to be stocked', async () => {
    const x = setup({ stock: 5 }); x.configure('pond2', { autoBuyFry: false });
    await x.step(); assert.equal(x.buys().length, 0); assert.equal(x.stocks()[0].payload.quantity, 5);
});

test('pond masters and local stock permission override explicit buy authorization', async () => {
    for (const change of [x => { x.h.CONFIG.aquatic.enabled = false; }, x => { x.h.CONFIG.aquatic.ponds = false; },
        x => x.configure('pond2', { enabled: false }), x => x.configure('pond2', { autoStock: false })]) {
        const x = setup(); x.configure('pond2', { autoBuyFry: true }); change(x);
        await x.step(); assert.equal(x.calls.length, 0);
    }
});

test('missing, locked, mismatched or invalid-price shop items cannot be purchased as fry', async () => {
    for (const change of [state => { state.shop = []; }, state => { state.shop[1].locked = true; },
        state => { state.shop[1].unlocked = false; }, state => { state.shop[1].item.item_id = 'green_carp'; },
        state => { state.shop[1].price = -1; }, state => { state.shop[1].price = NaN; }, state => { state.shop[1].price = null; },
        state => { state.shop[1].price = ''; }, state => { delete state.shop[1].price; }, state => { delete state.shop[1].id; },
        state => { delete state.aquatic.species[1].fry_item; }]) {
        const x = setup(); change(x.backend); x.sync(); await x.step(); assert.equal(x.calls.length, 0);
    }
});

test('budget shortage buys only the affordable part and still stocks that together with existing fry', async () => {
    const x = setup({ stock: 5, budget: 25 }); await x.step();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [5]);
    assert.equal(x.stocks()[0].payload.quantity, 10); assert.equal(x.pond('pond2').population, 10);
});

test('the coin floor limits buying independently of a larger tick budget', async () => {
    const x = setup({ coins: 1017, reserve: 1000, budget: 1000 }); await x.step();
    assert.equal(x.buys()[0].payload.quantity, 3); assert.equal(x.backend.player.coins, 1002);
    assert.equal(x.stocks()[0].payload.quantity, 3);
});

test('two ponds share one allowance and use their own species products', async () => {
    const x = setup({ budget: 35 }); x.pond('pond1').population = 30; x.pond('pond1').fry = []; x.sync();
    await x.step();
    assert.deepEqual(x.buys().map(req => req.payload), [
        { shop_id: 'carp-fry-shop', quantity: 7 }, { shop_id: 'green-carp-fry-shop', quantity: 2 },
    ]);
    assert.equal(20000 - x.backend.player.coins, 31); assert.equal(x.pond('pond1').population, 37); assert.equal(x.pond('pond2').population, 2);
});

test('zero budget forbids purchases even when the shop price is zero but still permits inventory stocking', async () => {
    const x = setup({ stock: 3, price: 0, budget: 0 }); await x.step();
    assert.equal(x.buys().length, 0); assert.equal(x.stocks()[0].payload.quantity, 3);
});

test('large needs are filled by requests of at most 99 and never exceed the remaining target', async () => {
    const x = setup({ target: 250, capacity: 300, price: 1 });
    for (let i = 0; i < 5; i++) await x.step();
    assert.equal(x.buys().reduce((sum, req) => sum + req.payload.quantity, 0), 250);
    assert.ok(x.buys().every(req => req.payload.quantity <= 99)); assert.equal(x.pond('pond2').population, 250);
});

test('turning off local stocking while a purchase returns prevents the following stock request', async () => {
    const x = setup(); x.after(req => { if (req.url.endsWith('/shop/buy')) x.configure('pond2', { autoStock: false }); });
    await x.step(); assert.equal(x.buys().length, 1); assert.equal(x.stocks().length, 0);
});

test('the purchase response population is used before calculating how many fry to stock', async () => {
    for (const stock of [0, 5]) {
        const x = setup({ stock }); x.after(req => { if (req.url.endsWith('/shop/buy')) x.pond('pond2').population = 35; });
        await x.step(); assert.equal(x.stocks()[0].payload.quantity, 2); assert.equal(x.pond('pond2').population, 37);
        assert.equal(x.intent(), null, 'a confirmed purchase is not uncertain merely because the pond now needs fewer fry');
    }
});

test('changing the target to zero or locking the wrong fish after a confirmed buy stops stocking without an uncertainty lock', async () => {
    for (const change of [{ restockTarget: 0 }, { speciesId: 'carp' }]) {
        const x = setup(); x.after(req => { if (req.url.endsWith('/shop/buy')) x.configure('pond2', change); });
        await x.step(); assert.equal(x.buys().length, 1); assert.equal(x.stocks().length, 0);
        assert.equal(x.intent(), null, JSON.stringify(change));
        assert.equal(x.backend.inventory.find(row => row.item_id === 'green_carp_fry').quantity, 37);
    }
});

test('a pre-write authoritative refresh invalidates old purchase authorization and quantity', async () => {
    const x = setup(); x.h.runtime.stateUncertain = true;
    x.before(req => { if (req.method === 'GET') x.configure('pond2', { autoBuyFry: false }); return null; });
    await x.step(); assert.deepEqual(x.calls.map(req => req.method), ['GET']); assert.equal(x.intent(), null);
});

test('a definite purchase rejection leaves no uncertainty lock and can succeed on a later pass', async () => {
    const x = setup(); x.before(req => req.url.endsWith('/shop/buy') ? reject400() : null);
    await x.step(); assert.equal(x.intent(), null); assert.equal(x.stocks().length, 0);
    x.before(() => null); await x.step(); assert.equal(x.pond('pond2').population, 37);
});

test('a local action limit records no ambiguous fry purchase and leaves the next pass available', async () => {
    const x = setup(); x.h.runtime.actionCount = x.h.CONFIG.maxActionsPerTick;
    await assert.rejects(x.h.doPonds(), error => error.code === 'action_limit' && error.writeNotSent);
    assert.equal(x.calls.length, 0); assert.equal(x.intent(), null);
    await x.step(); assert.equal(x.pond('pond2').population, 37);
});

test('an applied purchase whose response is lost blocks buying and stocking for that pond across reload', async () => {
    const x = setup(); x.after(req => { if (req.url.endsWith('/shop/buy')) throw new Error('buy response lost'); });
    await assert.rejects(x.step(), error => error.code === 'network_error');
    assert.equal(x.intent().phase, 'uncertain'); assert.equal(x.intent().action, 'buy');
    x.after(() => {}); await x.step(); assert.equal(x.buys().length, 1); assert.equal(x.stocks().length, 0);
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0);
});

test('an applied stock whose response is lost never buys or stocks a second time after reload', async () => {
    const x = setup({ stock: 37 }); x.after(req => { if (req.url.endsWith('/stock')) throw new Error('stock response lost'); });
    await assert.rejects(x.step(), error => error.code === 'network_error');
    assert.equal(x.intent().phase, 'uncertain'); assert.equal(x.intent().action, 'stock');
    assert.equal(x.pond('pond2').population, 37);
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0);
});

test('an HTTP-success purchase without an inventory increase does not trigger repeated purchases', async () => {
    const x = setup(); x.before(req => req.url.endsWith('/shop/buy') ? x.response() : null);
    await x.step(); assert.equal(x.buys().length, 1); assert.equal(x.intent().phase, 'uncertain');
    await x.step(); assert.equal(x.buys().length, 1); assert.equal(x.stocks().length, 0);
});

test('an HTTP-success stock without a population increase remains uncertain across another pass', async () => {
    const x = setup({ stock: 37 }); x.before(req => req.url.endsWith('/stock') ? x.response() : null);
    await x.step(); assert.equal(x.stocks().length, 1); assert.equal(x.intent().phase, 'uncertain');
    await x.step(); assert.equal(x.stocks().length, 1); assert.equal(x.buys().length, 0);
});
