const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, harness } = require('./red-leaf-town-v4.test.cjs');

// Deliberately fictional crops/prices: these tests exercise planning and requests,
// not assumptions about the live game's current balance data.
function crop(id, price, extra = {}) {
    return { id, name: id, seed_item_id: `${id}_seed`, produce_item_id: id,
        produce_sell_price: price, seed_price: 1, growth_seconds: 60,
        stamina_cost: 1, yield_min: 2, yield_max: 2, ...extra };
}
function item(item_id, quantity, quality = 0, sell_price) {
    return { item_id, name: item_id, quantity, quality, ...(sell_price == null ? {} : { sell_price }) };
}
function shop(job, price, extra = {}) {
    return { id: `${job.id}-shop`, item: { item_id: job.seed_item_id, name: job.seed_item_id }, price, ...extra };
}
function portal(itemId, quantity, minQuality = 0, extra = {}) {
    return { id: `${itemId}-portal`, unlocked: true,
        tributes: [{ item_id: itemId, name: itemId, quantity, min_quality: minQuality, delivered: 0 }], ...extra };
}
function farmState(slots = 1) {
    const state = fixture();
    state.player = { ...state.player, stamina: 100, stamina_cap: 100, coins: 100 };
    state.crops = [crop('wheat', 2), crop('corn', 3), crop('pumpkin', 20)];
    state.inventory = state.crops.map(job => item(job.seed_item_id, 10));
    state.shop = state.crops.map(job => shop(job, 1));
    state.plots = Array.from({ length: slots }, (_, slot) => ({ slot, empty: true, ready: false, assigned_partner_ids: [] }));
    state.crafting_stations = [];
    return state;
}
function growing(state, slot, cropId) {
    const plot = state.plots.find(plot => plot.slot === slot);
    Object.assign(plot, { empty: false, ready: false, crop: structuredClone(state.crops.find(job => job.id === cropId)),
        planted_at: state.server_time, ready_at: state.server_time + 60 });
}
function farmHarness(state = farmState()) {
    const x = harness(state);
    let afterWrite = () => {}, beforeRequest = () => null;
    x.afterWrite = callback => { afterWrite = callback; };
    x.beforeRequest = callback => { beforeRequest = callback; };
    x.setResponder(async req => {
        const overridden = await beforeRequest(req);
        if (overridden) return overridden;
        if (req.url.endsWith('/state')) return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        if (req.url.endsWith('/shop/buy')) {
            const entry = x.backend.shop.find(entry => entry.id === req.payload.shop_id);
            assert.ok(entry, `valid shop id: ${req.payload.shop_id}`);
            assert.equal(req.payload.quantity, 1, 'seed purchases remain one seed at a time');
            assert.ok(x.backend.player.coins >= Number(entry.price), 'never overspend the authoritative balance');
            x.backend.player.coins -= Number(entry.price);
            const seedId = entry.item?.item_id ?? entry.item_id ?? entry.id;
            let stack = x.backend.inventory.find(row => row.item_id === seedId && !row.quality);
            if (!stack) { stack = item(seedId, 0); x.backend.inventory.push(stack); }
            stack.quantity++;
        } else if (/\/plots\/\d+\/plant$/.test(req.url)) {
            const slot = Number(req.url.match(/\/plots\/(\d+)\/plant$/)[1]);
            const job = x.backend.crops.find(job => job.id === req.payload.crop_id);
            const seed = x.backend.inventory.find(row => row.item_id === job?.seed_item_id && row.quantity > 0);
            assert.ok(seed, 'plant only with an owned seed');
            assert.equal(x.backend.plots.find(plot => plot.slot === slot).empty, true);
            assert.ok(x.backend.player.stamina >= job.stamina_cost);
            seed.quantity--;
            x.backend.player.stamina -= job.stamina_cost;
            growing(x.backend, slot, job.id);
        } else if (/\/inventory\/[^/]+\/sell$/.test(req.url)) {
            const id = req.url.match(/\/inventory\/([^/]+)\/sell$/)[1];
            const stack = x.backend.inventory.find(row => row.item_id === id && row.quality === req.payload.quality);
            assert.ok(stack && stack.quantity >= req.payload.quantity, 'sell only an existing stack');
            stack.quantity -= req.payload.quantity;
            x.backend.player.coins += stack.sell_price * req.payload.quantity;
        } else assert.fail(`unexpected farm request ${req.method} ${req.url}`);
        await afterWrite(req);
        return x.response();
    });
    x.planted = () => x.calls.filter(req => /\/plots\/\d+\/plant$/.test(req.url))
        .map(req => ({ slot: Number(req.url.match(/\/plots\/(\d+)\/plant$/)[1]), crop: req.payload.crop_id }));
    x.bought = () => x.calls.filter(req => req.url.endsWith('/shop/buy')).map(req => req.payload.shop_id);
    x.needs = () => [...x.h.farmingPlantingNeeds(x.h.runtime.state)].map(row => ({
        item: row.need.itemId, quality: row.need.minQuality, shortage: row.shortage, pending: row.pending,
    }));
    return x;
}

test('automatic plots satisfy the commission, unlocked tribute, then profit from fresh write responses', async () => {
    const state = farmState(3);
    state.commissions = { commission: { item_id: 'wheat', item: { name: 'wheat' }, quantity: 2 } };
    state.portals = [portal('corn', 2)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }, { slot: 1, crop: 'corn' }, { slot: 2, crop: 'pumpkin' }]);
});

test('settled commissions and locked or completed portals do not change the profit choice', async () => {
    const state = farmState();
    state.commissions = { commission: { item_id: 'wheat', quantity: 50, settled: true } };
    state.portals = [portal('wheat', 50, 0, { unlocked: false }), portal('corn', 50, 0, { completed: true })];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'pumpkin' }]);
});

test('profit mode still serves enabled commissions but ignores portal demand', async () => {
    const state = farmState(2);
    state.commissions = { commission: { item_id: 'wheat', quantity: 2 } };
    state.portals = [portal('corn', 2)];
    const x = farmHarness(state);
    x.h.CONFIG.farming.seedStrategy = 'profit';
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted().map(row => row.crop), ['wheat', 'pumpkin']);
});

test('locked crops and stamina costs beyond the usable maximum cannot displace a viable crop', async () => {
    const state = farmState();
    state.crops = [crop('locked', 1000, { locked: true }), crop('not-yet', 2000, { unlocked: false }),
        crop('impossible', 3000, { stamina_cost: 101 }), crop('wheat', 2)];
    state.inventory = state.crops.map(job => item(job.seed_item_id, 1));
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }]);
});

test('invalid or locked shop rows are never selected for a seed purchase', async () => {
    const state = farmState();
    state.inventory = [];
    const wheat = state.crops[0], pumpkin = state.crops[2];
    state.shop = [shop(pumpkin, 0, { id: 'locked', locked: true }), shop(pumpkin, 0, { id: 'not-yet', unlocked: false }),
        shop(pumpkin, 0, { id: undefined }), shop(pumpkin, 0, { id: '' }),
        ...[undefined, null, '', -1, 'bad', Infinity].map((price, index) => shop(pumpkin, price, { id: `invalid-${index}` })), shop(wheat, 1)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['wheat-shop']);
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }]);
});

test('profit and the actual purchase both use the cheapest valid matching shop price', async () => {
    const state = farmState();
    state.inventory = [];
    state.crops = [crop('wheat', 5, { seed_price: 0 }), crop('corn', 4)];
    state.shop = [shop(state.crops[0], 100, { id: 'wheat-expensive' }), shop(state.crops[0], 8, { id: 'wheat-cheap' }), shop(state.crops[1], 1)];
    const x = farmHarness(state);
    assert.equal(x.h.cropHourlyProfit(x.h.runtime.state, x.h.runtime.state.crops[0]), 120);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['corn-shop']);
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'corn' }]);
    const y = farmHarness({ ...state, crops: [state.crops[0]], shop: state.shop.slice(0, 2) });
    await y.h.plantEmptyPlots();
    assert.deepEqual(y.bought(), ['wheat-cheap']);
});

test('an explicit valid seed shop takes precedence and an invalid forced shop falls back safely', async () => {
    for (const forced of ['preferred', 'locked', 'foreign']) {
        const state = farmState();
        state.inventory = [];
        state.crops = [crop('wheat', 20)];
        state.shop = [shop(state.crops[0], 1, { id: 'cheap' }), shop(state.crops[0], 4, { id: 'preferred' }),
            shop(state.crops[0], 0, { id: 'locked', locked: true }), shop(crop('other', 5), 0, { id: 'foreign' })];
        const x = farmHarness(state);
        x.h.CONFIG.farming.seedShopId = forced;
        await x.h.plantEmptyPlots();
        assert.deepEqual(x.bought(), [forced === 'preferred' ? 'preferred' : 'cheap']);
    }
});

test('owned seeds have no new coin cost and are reconsidered after the last seed is planted', async () => {
    const state = farmState(2);
    state.crops = [crop('wheat', 10), crop('corn', 8)];
    state.inventory = [item('wheat_seed', 1), item('corn_seed', 1)];
    state.shop = [shop(state.crops[0], 19), shop(state.crops[1], 1)];
    const x = farmHarness(state);
    assert.equal(x.h.cropHourlyProfit(x.h.runtime.state, x.h.runtime.state.crops[0]), 1200);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted().map(row => row.crop), ['wheat', 'corn']);
    assert.deepEqual(x.bought(), []);
});

test('a high-quality inventory price does not inflate unknown future crop quality', async () => {
    const state = farmState();
    state.crops = [crop('wheat', undefined), crop('corn', 5)];
    state.inventory = [item('wheat', 1, 5, 500), item('wheat', 1, 0, 1), item('wheat_seed', 1), item('corn_seed', 1)];
    const x = farmHarness(state);
    assert.equal(x.h.cropHourlyProfit(x.h.runtime.state, x.h.runtime.state.crops[0]), 120);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'corn' }]);
});

test('unknown ordinary value permits owned seeds but does not authorize speculative seed buying', async () => {
    const state = farmState();
    state.crops = [crop('wheat', undefined)];
    state.inventory = [item('wheat', 1, 5, 500)];
    state.shop = [shop(state.crops[0], 1)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.equal(x.calls.length, 0);
    x.backend.inventory.push(item('wheat_seed', 1)); x.sync();
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }]);
});

test('pure profit does not buy known loss-making seeds while an explicit demand can justify them', async () => {
    const state = farmState();
    state.crops = [crop('wheat', 1)]; state.inventory = []; state.shop = [shop(state.crops[0], 5)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.equal(x.calls.length, 0);
    x.backend.portals = [portal('wheat', 1)]; x.sync();
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['wheat-shop']);
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }]);
});

test('a profitable but unaffordable seed does not block an affordable crop', async () => {
    const state = farmState();
    state.player.coins = 2; state.inventory = [];
    state.shop = [shop(state.crops[0], 2), shop(state.crops[2], 10)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['wheat-shop']);
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }]);
});

test('safe-sale affordability respects protected stock, the per-tick limit, and already sold units', async () => {
    const state = farmState();
    state.player.coins = 0;
    state.inventory = [item('wheat', 20, 0, 2)];
    state.portals = [portal('wheat', 18)];
    state.shop = [shop(state.crops[0], 3), shop(state.crops[2], 4)];
    const x = farmHarness(state);
    x.h.CONFIG.selling.defaultKeep = 0; x.h.CONFIG.selling.maxUnitsPerTick = 2;
    x.h.runtime.soldUnits = 1;
    await x.h.plantEmptyPlots();
    assert.equal(x.calls.length, 0, 'one remaining sale at 2 coins cannot fund either seed');
    x.h.runtime.soldUnits = 0;
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['pumpkin-shop']);
    const sold = x.calls.filter(req => req.url.endsWith('/sell'));
    assert.equal(sold.length, 1); assert.equal(sold[0].payload.quantity, 2);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'wheat').quantity, 18);
});

test('disabled seed buying or selling never authorizes their corresponding write', async () => {
    const state = farmState();
    state.player.coins = 0; state.inventory = [item('wheat', 20, 0, 2), item('corn_seed', 1)];
    for (const option of ['autoBuySeeds', 'autoSellForSeeds']) {
        const x = farmHarness(state); x.h.CONFIG.farming[option] = false;
        await x.h.plantEmptyPlots();
        assert.deepEqual(x.planted(), [{ slot: 0, crop: 'corn' }]);
        assert.equal(x.calls.some(req => /\/sell$|\/shop\/buy$/.test(req.url)), false);
    }
});

test('different crops for the same tribute select a usable seed source', async () => {
    const state = farmState();
    state.crops = [crop('missing', 20, { produce_item_id: 'wheat' }), crop('available', 1, { produce_item_id: 'wheat' }), crop('pumpkin', 20)];
    state.inventory = [item('available_seed', 1), item('pumpkin_seed', 1)];
    state.shop = []; state.portals = [portal('wheat', 2)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'available' }]);
});

test('ordinary demand counts guaranteed yield once and stops sowing after its shared deficit is covered', async () => {
    const state = farmState(3);
    state.crops[0].yield_max = 20;
    state.portals = [portal('wheat', 3)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted().map(row => row.crop), ['wheat', 'wheat', 'pumpkin']);
    assert.equal(x.needs()[0].shortage, 0);
});

test('high-quality demand sends only one pending trial batch and retains the actual inventory shortage', async () => {
    const state = farmState(3);
    state.portals = [portal('wheat', 2, 3)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted().map(row => row.crop), ['wheat', 'pumpkin', 'pumpkin']);
    assert.deepEqual(x.needs(), [{ item: 'wheat', quality: 3, shortage: 2, pending: 2 }]);
    const need = x.h.gatherNeeds(x.h.runtime.state, { productionOnly: true })[0];
    assert.equal(x.h.needShortage(x.h.runtime.state, need), 2);
    x.backend.inventory.push(item('wheat', 2, 3, 5)); x.sync();
    x.h.CONFIG.selling.defaultKeep = 0;
    assert.equal(x.h.safeUnspecifiedConsumeQty(x.h.runtime.state, 'wheat'), 0, 'trial yield never releases protected quality stock');
});

test('one pending trial batch cannot be counted against two high-quality tributes', async () => {
    const state = farmState(3);
    growing(state, 0, 'wheat');
    state.portals = [portal('wheat', 2, 3), portal('wheat', 2, 4)];
    const x = farmHarness(state);
    assert.deepEqual(x.needs().map(row => [row.shortage, row.pending]), [[2, 2], [2, 0]]);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 1, crop: 'wheat' }, { slot: 2, crop: 'pumpkin' }]);
    assert.equal(x.needs().reduce((sum, row) => sum + row.pending, 0), 4);
});

test('ordinary demand consumes in-flight crops before any excess is assigned as a quality trial', async () => {
    const state = farmState(2);
    growing(state, 0, 'wheat');
    state.portals = [portal('wheat', 2, 3), portal('wheat', 2)];
    const x = farmHarness(state);
    assert.deepEqual(x.needs().map(row => [row.shortage, row.pending]), [[2, 0], [0, 0]]);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 1, crop: 'wheat' }]);
});

test('a harvested low-quality trial does not permanently suppress another attempt at a high-quality tribute', async () => {
    const state = farmState();
    growing(state, 0, 'wheat'); state.portals = [portal('wheat', 2, 3)];
    const x = farmHarness(state);
    assert.equal(x.needs()[0].pending, 2);
    Object.assign(x.backend.plots[0], { empty: true, crop: null });
    x.backend.inventory.push(item('wheat', 2, 0, 2)); x.sync();
    assert.deepEqual(x.needs(), [{ item: 'wheat', quality: 3, shortage: 2, pending: 0 }]);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }]);
});

test('manually locked plots sow first so their forthcoming yield informs automatic plots', async () => {
    const state = farmState(3); state.portals = [portal('wheat', 2)];
    const x = farmHarness(state);
    x.h.setOverride('rlt-plot-crop:2', 'wheat');
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 2, crop: 'wheat' }, { slot: 0, crop: 'pumpkin' }, { slot: 1, crop: 'pumpkin' }]);
});

test('an unavailable manually locked crop stays locked while unrelated automatic plots continue', async () => {
    const state = farmState(2);
    const x = farmHarness(state); x.h.setOverride('rlt-plot-crop:1', 'absent');
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'pumpkin' }]);
    assert.equal(x.h.getOverride('rlt-plot-crop:1'), 'absent');
});

test('turning off farming or planting while a seed purchase is pending prevents planting afterward', async () => {
    for (const setting of ['enabled', 'autoPlant']) {
        const state = farmState(); state.inventory = [];
        const x = farmHarness(state);
        x.afterWrite(async req => {
            if (req.url.endsWith('/shop/buy')) { await Promise.resolve(); x.h.CONFIG.farming[setting] = false; }
        });
        await x.h.plantEmptyPlots();
        assert.equal(x.bought().length, 1);
        assert.deepEqual(x.planted(), []);
    }
});

test('changing the selected crop while buying a seed prevents stale planting and preserves the bought seed', async () => {
    const state = farmState(); state.inventory = [];
    const x = farmHarness(state);
    x.afterWrite(async req => {
        if (req.url.endsWith('/shop/buy')) { await Promise.resolve(); x.h.setOverride('rlt-plot-crop:0', 'wheat'); }
    });
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['pumpkin-shop']);
    assert.deepEqual(x.planted(), []);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'pumpkin_seed').quantity, 1);
});

test('each automatic plot recomputes affordability from the latest remaining coins', async () => {
    const state = farmState(2);
    state.player.coins = 5; state.inventory = [];
    state.shop = [shop(state.crops[0], 1), shop(state.crops[2], 4)];
    const x = farmHarness(state);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['pumpkin-shop', 'wheat-shop']);
    assert.deepEqual(x.planted().map(row => row.crop), ['pumpkin', 'wheat']);
    assert.equal(x.backend.player.coins, 0);
});

test('changing sale authorization or the selected crop during a sale stops the old sale-buy-plant chain', async () => {
    for (const change of ['disable-selling', 'change-crop']) {
        const state = farmState();
        state.player.coins = 0;
        state.inventory = [item('wheat', 1, 0, 3), item('corn', 1, 0, 2)];
        state.shop = [shop(state.crops[2], 5)];
        const x = farmHarness(state);
        x.h.CONFIG.selling.defaultKeep = 0;
        x.afterWrite(async req => {
            if (req.url.endsWith('/sell')) {
                await Promise.resolve();
                if (change === 'disable-selling') x.h.CONFIG.farming.autoSellForSeeds = false;
                else x.h.setOverride('rlt-plot-crop:0', 'corn');
            }
        });
        await x.h.plantEmptyPlots();
        assert.equal(x.calls.length, 1, 'no second sale, seed purchase, or planting after the change');
        assert.ok(x.calls[0].url.endsWith('/inventory/wheat/sell'));
        assert.equal(x.backend.inventory.find(row => row.item_id === 'corn').quantity, 1);
        assert.equal(x.backend.player.coins, 3);
    }
});

test('a pre-write uncertainty refresh invalidates a stale planting plan without issuing a write', async () => {
    const x = farmHarness(farmState());
    x.h.runtime.stateUncertain = true;
    growing(x.backend, 0, 'corn'); // A manual action is first visible in the mandatory state refresh.
    await assert.rejects(x.h.plantEmptyPlots(), error => error.code === 'aborted');
    assert.deepEqual(x.calls.map(req => [req.method, req.url.split('/').at(-1)]), [['GET', 'state']]);
    assert.equal(x.h.runtime.state.plots[0].crop.id, 'corn');
    assert.equal(x.backend.inventory.find(row => row.item_id === 'pumpkin_seed').quantity, 10);
});

test('a rejected purchase for a locked plot does not prevent planting another plot with owned seeds', async () => {
    const state = farmState(2);
    state.inventory = [item('pumpkin_seed', 1)];
    const x = farmHarness(state);
    x.h.setOverride('rlt-plot-crop:0', 'wheat');
    x.beforeRequest(req => req.url.endsWith('/shop/buy') ? {
        ok: false, status: 400, headers: { get: () => null },
        json: async () => ({ code: 'unavailable', message: 'Seed unavailable' }),
    } : null);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.bought(), ['wheat-shop']);
    assert.deepEqual(x.planted(), [{ slot: 1, crop: 'pumpkin' }]);
    assert.equal(x.backend.plots[0].empty, true);
    assert.equal(x.h.getOverride('rlt-plot-crop:0'), 'wheat');
});

test('unsettled gathering output never satisfies a high-quality tribute or counts as a crop quality trial', async () => {
    const state = farmState();
    const gatheringTask = { id: 'gather-wheat', item_id: 'wheat', item: { item_id: 'wheat', name: 'wheat' },
        yield_min: 2, yield_max: 2, duration_seconds: 60 };
    state.gathering_sites = [{ site_id: 'forest', empty: false, ready: false, available_tasks: [gatheringTask],
        task: gatheringTask, task_snapshot: { ready_at: state.server_time + 60 } }];
    state.portals = [portal('wheat', 2, 3)];
    const x = farmHarness(state);
    assert.deepEqual(x.needs(), [{ item: 'wheat', quality: 3, shortage: 2, pending: 0 }]);
    await x.h.plantEmptyPlots();
    assert.deepEqual(x.planted(), [{ slot: 0, crop: 'wheat' }]);
    assert.equal(x.needs()[0].shortage, 2);
});
