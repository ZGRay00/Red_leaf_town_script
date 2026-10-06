const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const boundary = shared.indexOf('async function run()');
assert.ok(boundary > 0, 'shared browser harness is available');
const harnessSource = shared.slice(0, boundary).replace('doAquaticFeed, doSailing,',
    'feedMode, feedSelection, feedGoal, feedPlan, configuredFeedMix, feedChoices, feedBatch, clearFeedBatch, startRefiningRun, doAquaticFeed, doSailing,');
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);

const food = (id, quantity, score, units = 100, extra = {}) => ({
    id, name: id === 'balanced' ? '均衡饲料' : id === 'pumpkin' ? '南瓜' : `${id}饲料`,
    quality: 1, quantity, score, units, ...extra,
});
const pair = (quantity = 4) => [food('balanced', quantity, 35, 100, { price: 5 }), food('premium', quantity, 65, 100, { price: 10 })];
const mix = rows => JSON.stringify(rows.map(([itemId, weight]) => ({ itemId, weight })));
const defaultMix = [['balanced', 50], ['premium', 50]];
function setup({ foods = pair(), units = 0, score = 0, capacity = 1000, target = 400, low = 100,
    goal = 45, mode = 'mix', recipe = defaultMix, autoBuy = false, budget = 1000, coins = 20000,
    keep = 0, entries = [], configure = true } = {}) {
    const state = fixture(); state.player.coins = coins; state.inventory = []; state.shop = [];
    Object.assign(state.aquatic.feed_slot, { units, capacity, quality_score: score, inputs: [] });
    const metadata = new Map(), products = new Map();
    for (const row of foods) {
        const key = `${row.id}:${row.quality}`;
        metadata.set(key, { item_id: row.id, item: { name: row.name }, quality: row.quality,
            units: row.units, unit_score: row.score });
        state.inventory.push({ item_id: row.id, name: row.name, quality: row.quality, quantity: row.quantity });
        state.aquatic.feed_slot.inputs.push({ ...metadata.get(key), quantity: row.quantity });
        if (row.price != null && !products.has(row.id)) {
            state.shop.push({ id: `${row.id}-shop`, item: { item_id: row.id, name: row.name }, price: row.price });
            products.set(row.id, { ...row });
        }
    }
    const x = harness(state, entries, { feedDefaults: true });
    if (configure) Object.assign(x.h.CONFIG.feed, { enabled: true, mode, mix: mix(recipe),
        qualityTargetEnabled: true, qualityTarget: goal, target, low, thresholdMode: 'units',
        autoBuy, maxSpendPerTick: budget, coinReserve: 1000 });
    x.h.CONFIG.selling.defaultKeep = keep;
    x.products = products;
    x.updateInputs = () => {
        x.backend.aquatic.feed_slot.inputs = x.backend.inventory.filter(row => row.quantity > 0)
            .map(row => ({ ...metadata.get(`${row.item_id}:${row.quality}`), quantity: row.quantity }));
    };
    let after = () => {}, before = () => null;
    x.after = callback => { after = callback; }; x.before = callback => { before = callback; };
    x.respond = async req => {
        const overridden = await before(req); if (overridden) return overridden;
        if (req.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        if (req.url.endsWith('/shop/buy')) {
            const entry = x.backend.shop.find(row => row.id === req.payload.shop_id);
            assert.ok(entry, 'only an actual selected shop product is purchased');
            const item = products.get(entry.item.item_id);
            assert.ok(Number.isSafeInteger(req.payload.quantity) && req.payload.quantity > 0 && req.payload.quantity <= 99);
            let stack = x.backend.inventory.find(row => row.item_id === item.id && row.quality === item.quality);
            if (!stack) { stack = { item_id: item.id, name: item.name, quality: item.quality, quantity: 0 }; x.backend.inventory.push(stack); }
            stack.quantity += req.payload.quantity; x.backend.player.coins -= req.payload.quantity * entry.price;
            metadata.set(`${item.id}:${item.quality}`, { item_id: item.id, item: { name: item.name }, quality: item.quality,
                units: item.units, unit_score: item.score });
        } else {
            assert.ok(req.url.endsWith('/feed-slot/deposit'), `unexpected request ${req.url}`);
            const input = metadata.get(`${req.payload.item_id}:${req.payload.quality}`), slot = x.backend.aquatic.feed_slot;
            const stack = x.backend.inventory.find(row => row.item_id === req.payload.item_id && row.quality === req.payload.quality);
            assert.ok(input && stack && stack.quantity >= req.payload.count, 'each item/quality consumes its own actual inventory');
            assert.ok(Number.isSafeInteger(req.payload.count) && req.payload.count > 0);
            const added = req.payload.count * input.units, previous = slot.quality_score;
            assert.ok(slot.units + added <= slot.capacity, 'only whole pieces fitting the slot may be deposited');
            slot.quality_score = ((slot.units ? slot.units * previous : 0) + added * input.unit_score) / (slot.units + added);
            if (slot.units && previous + 1e-9 >= goal) assert.ok(slot.quality_score + 1e-9 >= goal, 'an interrupted mix never lowers an adequate slot below the target');
            else if (slot.units) assert.ok(slot.quality_score + 1e-9 >= previous, 'an already poor slot is never made worse');
            slot.units += added; stack.quantity -= req.payload.count;
        }
        x.updateInputs(); await after(req); return x.response();
    };
    x.setResponder(x.respond);
    x.run = () => { x.h.runtime.actionCount = 0; return x.h.doAquaticFeed(); };
    x.plan = () => x.h.feedPlan(x.h.runtime.state, target);
    x.buys = () => x.calls.filter(req => req.url.endsWith('/shop/buy'));
    x.deposits = () => x.calls.filter(req => req.url.endsWith('/feed-slot/deposit'));
    x.spent = () => coins - x.backend.player.coins;
    x.know = id => {
        const product = products.get(id);
        x.h.setOverride(`rlt-feed-quality-product:index-DCECfXs_.js:${id}:${id}-shop`, JSON.stringify({
            quality: product.quality, units: product.units, unit_score: product.score, attempted: true,
        }));
    };
    return x;
}
function addedByItem(deposits) {
    const units = new Map();
    for (const row of deposits) units.set(row.input.item_id, (units.get(row.input.item_id) || 0) + row.count * row.input.units);
    return units;
}
function assertRatio(plan, recipe) {
    const actual = addedByItem(plan.deposits), total = [...actual.values()].reduce((a, b) => a + b, 0);
    const weight = recipe.reduce((sum, [, value]) => sum + value, 0);
    for (const [id, value] of recipe) {
        assert.ok(actual.get(id) > 0, `positive component ${id} is represented`);
        const tolerance = Math.max(...plan.deposits.filter(row => row.input.item_id === id).map(row => row.input.units));
        assert.ok(Math.abs(actual.get(id) - total * value / weight) <= tolerance + 1e-9, `whole-piece ratio tolerance for ${id}`);
    }
}

test('new feed defaults select smart quality protection at 45 and record the policy migration', () => {
    const x = setup({ configure: false });
    assert.equal(x.h.feedMode(), 'smart'); assert.equal(x.h.CONFIG.feed.qualityTargetEnabled, true);
    assert.equal(x.h.feedGoal(), 45); assert.ok(x.storage.get('rlt-feed-policy:v6'));
});

test('migration preserves a legacy explicit item as single but upgrades unsafe disabled quality settings', () => {
    const x = setup({ configure: false, entries: [['rlt-setting:feed.itemId', '"pumpkin"'],
        ['rlt-setting:feed.qualityTargetEnabled', 'false'], ['rlt-setting:feed.qualityTarget', '35']] });
    assert.equal(x.h.feedMode(), 'single'); assert.equal(x.h.CONFIG.feed.itemId, 'pumpkin');
    assert.equal(x.h.CONFIG.feed.qualityTargetEnabled, true); assert.equal(x.h.feedGoal(), 45);
});

test('migration preserves an explicit mode and a safe goal, then never overrides subsequent user edits', () => {
    const x = setup({ configure: false, entries: [['rlt-setting:feed.mode', '"mix"'],
        ['rlt-setting:feed.itemId', '"pumpkin"'], ['rlt-setting:feed.qualityTarget', '60']] });
    assert.equal(x.h.feedMode(), 'mix'); assert.equal(x.h.feedGoal(), 60);
    x.h.CONFIG.feed.qualityTargetEnabled = false;
    const reloaded = setup({ configure: false, entries: [...x.storage] });
    assert.equal(reloaded.h.CONFIG.feed.qualityTargetEnabled, false);
    reloaded.h.CONFIG.feed.qualityTarget = 1; assert.equal(reloaded.h.feedGoal(), 41);
});

test('invalid, duplicate or out-of-range mix definitions cannot authorize a partial substitute', async () => {
    for (const value of ['{', '{}', '[]', mix([['balanced', 50], ['balanced', 50]]),
        mix([['balanced', 0]]), mix([['balanced', 0.5]]), mix([['balanced', 1.5]]), mix([['balanced', 101]]),
        mix(Array.from({ length: 7 }, (_, i) => [`feed-${i}`, 10]))]) {
        const x = setup({ foods: [food('balanced', 10, 100)] }); x.h.CONFIG.feed.mix = value;
        assert.equal(x.h.configuredFeedMix().valid, false, value);
        assert.equal(x.plan().feasible, false, value);
        await x.run(); assert.equal(x.calls.length, 0, value);
    }
});

test('smart mode uses confirmed feed products without consuming a high-score pumpkin', async () => {
    const x = setup({ mode: 'smart', foods: [food('balanced', 4, 50), food('pumpkin', 100, 200)], target: 200 });
    await x.run();
    assert.deepEqual(x.deposits().map(req => req.payload.item_id), ['balanced']);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'pumpkin').quantity, 100);
});

test('different foods sharing quality 1 stay separate and every mix component is deposited', async () => {
    const x = setup({ capacity: 400 }); const plan = x.plan();
    assert.equal(plan.feasible, true); assertRatio(plan, defaultMix);
    assert.deepEqual([...addedByItem(plan.deposits)].sort(), [['balanced', 200], ['premium', 200]]);
    await x.run();
    assert.deepEqual(x.deposits().map(req => [req.payload.item_id, req.payload.count]), [['premium', 2], ['balanced', 2]]);
    assert.equal(x.backend.aquatic.feed_slot.units, 400); assert.equal(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('mix weights describe new feed units rather than item counts and do not drift after the first deposit', async () => {
    const x = setup({ foods: [food('balanced', 4, 35), food('premium', 5, 65, 80)], target: 800, capacity: 800 });
    const plan = x.plan(); assert.equal(plan.feasible, true); assertRatio(plan, defaultMix);
    await x.run();
    assert.deepEqual(x.deposits().map(req => [req.payload.item_id, req.payload.count]), [['premium', 5], ['balanced', 4]]);
    assert.equal(x.backend.aquatic.feed_slot.units, 800);
});

test('whole-piece rounding remains within the actual piece size of every selected component', () => {
    const x = setup({ foods: [food('balanced', 5, 60), food('premium', 5, 60, 60)], target: 300, capacity: 400 });
    const plan = x.plan(); assert.equal(plan.feasible, true); assert.ok(plan.units >= 300); assertRatio(plan, defaultMix);
});

test('a low existing average can require a whole mixture beyond the water target', async () => {
    const x = setup({ foods: [food('balanced', 3, 35), food('premium', 3, 95)], units: 100, score: 10,
        target: 200, low: 50, capacity: 500 });
    const plan = x.plan(); assert.equal(plan.feasible, true); assert.ok(plan.units > 200); assertRatio(plan, defaultMix);
    await x.run(); assert.ok(x.backend.aquatic.feed_slot.quality_score >= 45);
    assert.equal(new Set(x.deposits().map(req => req.payload.item_id)).size, 2);
});

test('insufficient capacity for all positive components waits without consuming the available high-score food', async () => {
    const x = setup({ units: 100, score: 10, target: 200, capacity: 200 });
    assert.equal(x.plan().feasible, false); await x.run(); assert.equal(x.calls.length, 0);
});

test('a missing component or unconfirmed configured item never falls back to a partial or different recipe', async () => {
    for (const recipe of [defaultMix, [['balanced', 50], ['unseen', 50]]]) {
        const x = setup({ foods: [food('balanced', 10, 100), food('premium', 0, 100)], recipe });
        assert.equal(x.plan().feasible, false); await x.run(); assert.equal(x.calls.length, 0);
    }
});

test('a mix that cannot meet the quality floor leaves both inventories untouched', async () => {
    const x = setup({ foods: [food('balanced', 10, 35), food('premium', 10, 40)] });
    assert.equal(x.plan().feasible, false); await x.run(); assert.equal(x.calls.length, 0);
});

test('mixing pumpkin preserves its default keep independently of the balanced-feed exemption', async () => {
    const recipe = [['balanced', 50], ['pumpkin', 50]];
    const x = setup({ foods: [food('balanced', 1, 60), food('pumpkin', 6, 60)], recipe, keep: 5, target: 200 });
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 200);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'pumpkin').quantity, 5);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'balanced').quantity, 0);
});

test('portal protection of a required component blocks the complete mixture', async () => {
    const x = setup({ foods: pair(1), target: 200 });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'premium', quantity: 1, min_quality: 1 }] }]; x.sync();
    assert.equal(x.plan().feasible, false); await x.run(); assert.equal(x.calls.length, 0);
});

test('one mixture preserves combined portal, facility, crafting and exact-quality refining reservations', async () => {
    const x = setup({ foods: [food('balanced', 2, 35), food('premium', 8, 65)] });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'premium', quantity: 1, min_quality: 1 }] }];
    x.backend.facilities = {
        upgrades: [{ id: 'farm-project', kind: 'farm', unlocked: true, inputs: [{ item_id: 'premium', quantity: 1 }] }],
        refining: { built: true, unlocked: true, max_quality: 4, slots: [null],
            assigned_partner: { partner_id: 'refiner' }, recipes: [{ id: 'polish', unlocked: true,
                input_item: { item_id: 'premium', name: 'premium饲料' }, input_quantity: 2,
                item: { item_id: 'polished' }, options: [{ quality: 1,
                    quality_times: [10, 20, 30, 40].map(delay => x.backend.server_time + delay) }] }] },
    };
    x.backend.crafting_stations[0].recipes[0].inputs = [{ item_id: 'premium', quantity: 1 }]; x.sync();
    x.h.setOverride('rlt-facility-reserve:farm', 'farm-project');
    x.h.setOverride('rlt-node-job:crafting:mill', 'flour'); x.h.setOverride('rlt-craft-lock-times:mill', '2');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    x.h.setOverride('rlt-refining-config:0', JSON.stringify({ recipeId: 'polish', inputQuality: 1, targetQuality: 3, times: 1 }));
    assert.equal(x.h.startRefiningRun(x.h.runtime.state, 0), true);
    const plan = x.plan(); assert.equal(plan.feasible, true);
    assert.equal(addedByItem(plan.deposits).get('premium'), 200);
    await x.run(); assert.equal(x.backend.inventory.find(row => row.item_id === 'premium').quantity, 6);
    assert.equal(x.backend.aquatic.feed_slot.units, 400);
});

test('an unknown purchased quality is calibrated with one piece per product before shared-budget buying', async () => {
    const x = setup({ foods: pair(0), autoBuy: true, budget: 30 });
    await x.run();
    for (const id of ['balanced-shop', 'premium-shop']) assert.equal(x.buys().find(req => req.payload.shop_id === id)?.payload.quantity, 1);
    assert.ok(x.spent() <= 30); assert.equal(x.backend.aquatic.feed_slot.units, 400);
    assert.equal(new Set(x.deposits().map(req => req.payload.item_id)).size, 2);
});

test('known shop products buy only their missing planned pieces and share one coin budget', async () => {
    const x = setup({ foods: pair(0), autoBuy: true, budget: 30 }); x.know('balanced'); x.know('premium');
    await x.run();
    assert.deepEqual(x.buys().map(req => [req.payload.shop_id, req.payload.quantity]).sort(), [['balanced-shop', 2], ['premium-shop', 2]]);
    assert.equal(x.spent(), 30); assert.equal(x.backend.aquatic.feed_slot.units, 400);
});

test('known shop products may fill an empty slot with a mixture exactly equal to the quality goal', async () => {
    const x = setup({ foods: [food('balanced', 0, 35, 100, { price: 5 }), food('premium', 0, 55, 100, { price: 10 })],
        autoBuy: true, budget: 30 }); x.know('balanced'); x.know('premium');
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 400);
    assert.equal(x.backend.aquatic.feed_slot.quality_score, 45); assert.equal(x.spent(), 30);
});

test('known purchases use whole-piece ratio tolerance instead of buying a piece absent from the final plan', async () => {
    const x = setup({ foods: [food('balanced', 0, 60, 100, { price: 1 }), food('premium', 0, 60, 60, { price: 1 })],
        autoBuy: true, target: 300, capacity: 400 }); x.know('balanced'); x.know('premium');
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 320); assert.equal(x.spent(), 4);
    assert.equal(x.backend.inventory.reduce((sum, row) => sum + row.quantity, 0), 0);
});

test('limited high-score stock only justifies purchases used by a feasible partial mixture', async () => {
    const x = setup({ foods: [food('balanced', 1, 100, 100, { quality: 3 }),
        food('balanced', 0, 35, 100, { price: 1 }), food('premium', 0, 35, 100, { price: 1 })],
        autoBuy: true, target: 1000, capacity: 2000 }); x.know('balanced'); x.know('premium');
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 600); assert.equal(x.spent(), 5);
    assert.equal(x.backend.inventory.reduce((sum, row) => sum + row.quantity, 0), 0);
    await x.run(); assert.equal(x.spent(), 5, 'no purchase is useful after the limited high-score stock is spent');
});

test('protected high-score stock cannot justify buying a known low-score mixture that will never be usable', async () => {
    const x = setup({ foods: [food('balanced', 1, 100, 100, { quality: 3 }),
        food('balanced', 0, 35, 100, { price: 1 }), food('premium', 0, 35, 100, { price: 1 })],
        autoBuy: true, target: 1000, capacity: 2000 }); x.know('balanced'); x.know('premium');
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'balanced', quantity: 1, min_quality: 3 }] }]; x.sync();
    await x.run(); assert.equal(x.buys().length, 0); assert.equal(x.deposits().length, 0);
});

test('an insufficient shared budget or coin floor cannot authorize the second purchase or a bad partial deposit', async () => {
    for (const options of [{ budget: 14 }, { budget: 100, coins: 1014 }]) {
        const x = setup({ foods: pair(0), autoBuy: true, ...options }); x.know('balanced'); x.know('premium');
        await x.run(); assert.ok(x.spent() <= 14); assert.equal(x.deposits().length, 0);
        assert.ok(x.backend.player.coins >= 1000);
    }
});

test('zero purchase budget does not calibrate free products', async () => {
    const x = setup({ foods: pair(0).map(row => ({ ...row, price: 0 })), autoBuy: true, budget: 0 });
    await x.run(); assert.equal(x.calls.length, 0);
});

test('changing mode or weights during calibration prevents further purchases and old-plan deposits', async () => {
    for (const change of [x => { x.h.CONFIG.feed.mode = 'single'; }, x => { x.h.CONFIG.feed.mix = mix([['balanced', 20], ['premium', 80]]); }]) {
        const x = setup({ foods: pair(0), autoBuy: true });
        x.after(req => { if (req.url.endsWith('/shop/buy')) change(x); });
        await x.run(); assert.equal(x.buys().length, 1); assert.equal(x.deposits().length, 0);
    }
});

test('changing the mix after its high-score deposit stops the remaining low-score write', async () => {
    const x = setup();
    x.after(req => { if (req.url.endsWith('/feed-slot/deposit')) x.h.CONFIG.feed.mix = mix([['balanced', 100]]); });
    await x.run(); assert.equal(x.deposits().length, 1); assert.equal(x.deposits()[0].payload.item_id, 'premium');
    assert.ok(x.backend.aquatic.feed_slot.quality_score >= 45);
});

test('pre-write synchronization invalidates a mixture computed for an obsolete slot', async () => {
    const x = setup(); x.h.runtime.stateUncertain = true;
    x.backend.aquatic.feed_slot.units = 1000; x.backend.aquatic.feed_slot.quality_score = 45;
    await x.run(); assert.deepEqual(x.calls.map(req => req.method), ['GET']);
});

test('large capacities use bounded planning while respecting the same ratio and quality constraints', () => {
    const x = setup({ foods: [food('balanced', 100000, 35, 1), food('premium', 100000, 65, 1)],
        target: 80000, capacity: 100000 });
    const plan = x.plan(); assert.equal(plan.feasible, true); assert.equal(plan.units, 80000); assertRatio(plan, defaultMix);
});

test('a definite rejection of the second component resumes only that remainder after reload', async () => {
    const x = setup();
    x.before(req => req.url.endsWith('/feed-slot/deposit') && req.payload.item_id === 'balanced'
        ? { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ message: '暂不可投入' }) } : null);
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 200);
    assert.equal(x.h.feedBatch().phase, 'ready');
    assert.deepEqual(Array.from(x.h.feedBatch().remaining, row => [row.itemId, row.count]), [['balanced', 2]]);
    const restored = setup({ configure: false, entries: [...x.storage] });
    restored.backend = structuredClone(x.backend); restored.sync(); await restored.run();
    assert.deepEqual(restored.deposits().map(req => [req.payload.item_id, req.payload.count]), [['balanced', 2]]);
    assert.equal(restored.backend.aquatic.feed_slot.units, 400); assert.equal(restored.h.feedBatch(), null);
});

test('an applied deposit with a lost response remains uncertain across another pass and reload', async () => {
    const x = setup();
    x.after(req => { if (req.url.endsWith('/feed-slot/deposit')) throw new Error('response lost after applying deposit'); });
    await assert.rejects(x.run(), error => error.code === 'network_error');
    assert.equal(x.backend.aquatic.feed_slot.units, 200); assert.equal(x.h.feedBatch().phase, 'uncertain');
    x.after(() => {}); await x.run(); assert.equal(x.deposits().length, 1);
    const restored = setup({ configure: false, entries: [...x.storage] });
    restored.backend = structuredClone(x.backend); restored.sync(); await restored.run();
    assert.equal(restored.calls.length, 0); assert.equal(restored.h.feedBatch().phase, 'uncertain');
});

test('switching to single mode cannot bypass an unresolved combination deposit', async () => {
    const x = setup();
    x.after(req => { if (req.url.endsWith('/feed-slot/deposit')) throw new Error('response lost'); });
    await assert.rejects(x.run(), error => error.code === 'network_error');
    x.after(() => {}); x.h.CONFIG.feed.mode = 'single'; x.h.CONFIG.feed.itemId = 'balanced';
    await x.run(); assert.equal(x.deposits().length, 1);
    assert.equal(x.h.feedBatch().phase, 'uncertain');
});

test('the local action limit preserves a ready mix for a later pass instead of marking it uncertain', async () => {
    const x = setup(); x.h.runtime.actionCount = x.h.CONFIG.maxActionsPerTick;
    await assert.rejects(x.h.doAquaticFeed(), error => error.code === 'action_limit' && error.writeNotSent);
    assert.equal(x.calls.length, 0); assert.equal(x.h.feedBatch().phase, 'ready');
    await x.run(); assert.equal(x.deposits().length, 2); assert.equal(x.h.feedBatch(), null);
});

test('changed conversion or score metadata prevents the remaining component from using a stale batch', async () => {
    for (const change of [input => { input.units = 200; }, input => { input.unit_score = 5; }]) {
        const x = setup();
        x.after(req => { if (req.url.endsWith('/feed-slot/deposit')) change(x.backend.aquatic.feed_slot.inputs.find(row => row.item_id === 'balanced')); });
        await x.run(); assert.equal(x.deposits().length, 1); assert.equal(x.h.feedBatch().phase, 'ready');
        await x.run(); assert.equal(x.deposits().length, 1);
    }
});

test('the actual returned slot quality gates the remainder even when the original arithmetic was sufficient', async () => {
    const x = setup();
    x.after(req => { if (req.url.endsWith('/feed-slot/deposit')) x.backend.aquatic.feed_slot.quality_score = 40; });
    await x.run(); assert.equal(x.deposits().length, 1);
    x.after(() => {}); await x.run(); assert.equal(x.deposits().length, 1);
    assert.equal(x.h.feedBatch().remaining[0].itemId, 'balanced');
});

test('an explicit new mixture invalidates a ready remainder instead of adding its old component', async () => {
    const x = setup();
    x.after(req => { if (req.url.endsWith('/feed-slot/deposit')) x.h.setRunning(false); });
    await x.run(); assert.equal(x.deposits().length, 1); assert.equal(x.h.feedBatch().phase, 'ready');
    x.after(() => {}); x.h.CONFIG.feed.mix = mix([['premium', 100]]); x.h.setRunning();
    await x.run(); assert.deepEqual(x.deposits().map(req => req.payload.item_id), ['premium', 'premium']);
    assert.equal(x.backend.aquatic.feed_slot.units, 400); assert.equal(x.h.feedBatch(), null);
});

test('a successful response without a confirmed volume increase pauses the batch instead of repeating it', async () => {
    const x = setup(); x.before(req => req.url.endsWith('/feed-slot/deposit') ? x.response() : null);
    await x.run(); assert.equal(x.deposits().length, 1); assert.equal(x.h.feedBatch().phase, 'uncertain');
    await x.run(); assert.equal(x.deposits().length, 1);
});
