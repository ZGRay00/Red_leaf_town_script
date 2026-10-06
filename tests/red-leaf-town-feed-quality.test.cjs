const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const harnessSource = shared.slice(0, shared.indexOf('async function run()')).replace('doAquaticFeed, doSailing,',
    'feedQualityPlan, renderFeedChoice, selectedFeed, doAquaticFeed, doSailing,');
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);

function setup({ units = 100, capacity = 1000, score = 10, goal = 50, target = 800, low = 200,
    stocks = [], autoBuy = false, budget = 1000, coins = 20000, keep = 0, itemId = 'balanced', entries = [] } = {}) {
    const state = fixture();
    state.player.coins = coins;
    state.inventory = [];
    Object.assign(state.aquatic.feed_slot, { units, capacity, quality_score: score, inputs: [] });
    const metadata = new Map();
    for (const stock of stocks) {
        const [quality, quantity, units, unit_score] = stock;
        metadata.set(quality, { item_id: itemId, item: { name: itemId === 'balanced' ? '均衡饲料' : '南瓜' }, quality, units, unit_score });
        state.inventory.push({ item_id: itemId, name: itemId === 'balanced' ? '均衡饲料' : '南瓜', quality, quantity });
        state.aquatic.feed_slot.inputs.push({ ...metadata.get(quality), quantity });
    }
    const x = harness(state, entries);
    Object.assign(x.h.CONFIG.feed, { enabled: true, qualityTargetEnabled: true, qualityTarget: goal,
        target, low, thresholdMode: 'units', autoBuy, maxSpendPerTick: budget, itemId: itemId === 'balanced' ? '' : itemId });
    x.h.CONFIG.selling.defaultKeep = keep;
    x.sold = { quality: 0, units: 100, unit_score: 100 };
    x.updateInputs = () => {
        x.backend.aquatic.feed_slot.inputs = x.backend.inventory.filter(item => item.item_id === itemId && item.quantity > 0)
            .map(item => ({ ...metadata.get(item.quality), quantity: item.quantity }));
    };
    x.respond = req => {
        if (req.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        if (req.url.endsWith('/shop/buy')) {
            assert.equal(req.payload.shop_id, 'balanced-shop');
            let stack = x.backend.inventory.find(row => row.item_id === itemId && row.quality === x.sold.quality);
            if (!stack) { stack = { item_id: itemId, name: '均衡饲料', quality: x.sold.quality, quantity: 0 }; x.backend.inventory.push(stack); }
            stack.quantity += req.payload.quantity;
            x.backend.player.coins -= req.payload.quantity * 5;
            metadata.set(x.sold.quality, { item_id: itemId, item: { name: '均衡饲料' }, ...x.sold });
        } else {
            assert.ok(req.url.endsWith('/feed-slot/deposit'), `unexpected request ${req.url}`);
            assert.equal(req.payload.item_id, itemId);
            const input = metadata.get(req.payload.quality), slot = x.backend.aquatic.feed_slot;
            const stack = x.backend.inventory.find(row => row.item_id === itemId && row.quality === req.payload.quality);
            assert.ok(stack && stack.quantity >= req.payload.count);
            const added = req.payload.count * input.units;
            assert.ok(slot.units + added <= slot.capacity, 'whole items must fit');
            slot.quality_score = ((slot.units > 0 ? slot.units * slot.quality_score : 0) + added * (input.unit_score ?? 0)) / (slot.units + added);
            slot.units += added; stack.quantity -= req.payload.count;
        }
        x.updateInputs(); return x.response();
    };
    x.setResponder(x.respond);
    x.plan = () => x.h.feedQualityPlan(x.h.runtime.state, x.h.feedInputs(x.h.runtime.state, itemId), target);
    x.run = () => { x.h.runtime.actionCount = 0; return x.h.doAquaticFeed(); };
    x.buys = () => x.calls.filter(req => req.url.endsWith('/shop/buy'));
    x.deposits = () => x.calls.filter(req => req.url.endsWith('/feed-slot/deposit'));
    x.log = () => x.h.logBox.children.map(row => row.textContent).join('\n');
    return x;
}

test('explicit legacy volume mode preserves feeding when score metadata is absent', async () => {
    const plain = harness(); assert.equal(plain.h.CONFIG.feed.qualityTargetEnabled, false);
    const x = setup({ stocks: [[0, 7, 100, undefined]] });
    x.h.CONFIG.feed.qualityTargetEnabled = false;
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 800);
});

test('quality uses units-weighted unit_score rather than quality numbers or item counts', async () => {
    const x = setup({ units: 100, score: 0, goal: 60, target: 500, stocks: [[1, 1, 100, 200], [5, 3, 100, 20]] });
    const plan = x.plan();
    assert.equal(plan.units, 400); assert.equal(plan.quality, 60);
    await x.run();
    assert.deepEqual(x.deposits().map(req => [req.payload.quality, req.payload.count]), [[1, 1], [5, 2]]);
    assert.equal(x.backend.aquatic.feed_slot.quality_score, 60);
});

test('an adequate existing average permits lower-scoring feed only until the target floor', async () => {
    const x = setup({ score: 90, target: 800, stocks: [[0, 20, 50, 10]] });
    await x.run();
    assert.equal(x.backend.aquatic.feed_slot.units, 200);
    assert.equal(x.backend.aquatic.feed_slot.quality_score, 50);
    assert.equal(x.deposits()[0].payload.count, 2);
});

test('a quality deficit triggers above the low watermark and may exceed the volume target', async () => {
    const x = setup({ units: 600, score: 30, low: 200, target: 700, stocks: [[3, 3, 100, 100]] });
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 900);
    assert.ok(x.backend.aquatic.feed_slot.quality_score >= 50);
});

test('adequate quality and volume do not trigger unnecessary feeding', async () => {
    const x = setup({ units: 800, score: 60, stocks: [[3, 3, 100, 100]], autoBuy: true });
    await x.run(); assert.equal(x.calls.length, 0);
});

test('quality disabled still honors the original low watermark hysteresis', async () => {
    const x = setup({ units: 600, score: 0, stocks: [[3, 3, 100, 100]] });
    x.h.CONFIG.feed.qualityTargetEnabled = false;
    await x.run(); assert.equal(x.calls.length, 0);
});

test('integer combination search finds a valid mix that a highest-score-first greedy plan misses', async () => {
    const x = setup({ units: 80, capacity: 180, score: 0, goal: 50, target: 180, low: 80,
        stocks: [[4, 1, 70, 100], [2, 2, 50, 90]] });
    const plan = x.plan(); assert.equal(plan.feasible, true);
    assert.deepEqual(Array.from(plan.deposits, row => [row.input.quality, row.count]), [[2, 2]]);
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('an unreachable target leaves every stock untouched instead of filling with inadequate quality', async () => {
    const x = setup({ units: 800, capacity: 1000, score: 0, goal: 50, target: 900,
        stocks: [[4, 20, 100, 100], [0, 20, 100, 10]] });
    await x.run(); assert.equal(x.calls.length, 0); assert.match(x.log(), /容量|品质/);
});

test('full capacity with a quality deficit waits without probing a shop or dumping feed', async () => {
    const x = setup({ units: 1000, capacity: 1000, score: 1, autoBuy: true });
    await x.run(); await x.run(); assert.equal(x.calls.length, 0); assert.match(x.log(), /已满/);
});

test('insufficient room for a whole piece cannot be mistaken for fractional quality repair', async () => {
    const x = setup({ units: 190, capacity: 200, score: 10, target: 200, low: 100, stocks: [[3, 10, 20, 999]] });
    await x.run(); assert.equal(x.calls.length, 0);
});

test('an empty slot ignores its previous quality and computes the fresh weighted average', async () => {
    const x = setup({ units: 0, capacity: 500, score: NaN, target: 400, low: 100, stocks: [[2, 4, 100, 50]] });
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 400);
    assert.equal(x.deposits()[0].payload.count, 4);
    assert.equal(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('missing unit scores and malformed slot quality cannot be guessed', async () => {
    for (const options of [{ stocks: [[3, 10, 100, undefined]] }, { score: undefined, stocks: [[3, 10, 100, 100]] }]) {
        const x = setup(options);
        if (options.score === undefined && Object.hasOwn(options, 'score')) { x.backend.aquatic.feed_slot.quality_score = undefined; x.sync(); }
        await x.run(); assert.equal(x.calls.length, 0); assert.match(x.log(), /确认/);
    }
});

test('conflicting scores for the same inventory quality cannot be deposited', async () => {
    const x = setup({ stocks: [[3, 10, 100, 100]] });
    x.backend.aquatic.feed_slot.inputs.push({ ...x.backend.aquatic.feed_slot.inputs[0], unit_score: 10 }); x.sync();
    await x.run(); assert.equal(x.calls.length, 0);
});

test('quality planning protects portal materials and explicit inventory keep', async () => {
    const x = setup({ units: 0, target: 500, low: 100, stocks: [[3, 5, 100, 100]] });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'balanced', quantity: 3, min_quality: 3 }] }];
    x.h.CONFIG.selling.keepByItemId.balanced = 2; x.sync();
    await x.run(); assert.equal(x.calls.length, 0);
});

test('selected nondefault feed respects its default keep and never substitutes balanced feed', async () => {
    const x = setup({ itemId: 'pumpkin', keep: 5, units: 0, target: 500, low: 100, stocks: [[3, 7, 100, 100]] });
    x.backend.inventory.push({ item_id: 'balanced', quality: 3, quantity: 100 }); x.sync();
    await x.run(); assert.equal(x.deposits()[0].payload.count, 2);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'pumpkin').quantity, 5);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'balanced').quantity, 100);
});

test('unknown shop quality receives one probe and then buys the confirmed useful batch', async () => {
    const x = setup({ autoBuy: true, units: 100, score: 0, target: 300, low: 100 });
    await x.run();
    assert.deepEqual(x.buys().map(req => req.payload.quantity), [1, 1]);
    assert.equal(x.backend.aquatic.feed_slot.units, 300); assert.ok(x.backend.aquatic.feed_slot.quality_score >= 50);
});

test('a confirmed low-score shop product is not repeatedly purchased across ticks or reloads', async () => {
    const x = setup({ autoBuy: true }); x.sold.unit_score = 10;
    await x.run(); await x.run();
    assert.equal(x.buys().length, 1); assert.equal(x.deposits().length, 0);
    const y = harness(x.backend, [...x.storage]);
    await y.h.doAquaticFeed(); assert.equal(y.calls.length, 0);
});

test('unconfirmed score metadata never causes repeated probe purchases after reload', async () => {
    const x = setup({ autoBuy: true }); x.sold.unit_score = undefined;
    await x.run(); await x.run(); assert.equal(x.buys().length, 1);
    const y = harness(x.backend, [...x.storage]);
    await y.h.doAquaticFeed(); assert.equal(y.calls.length, 0);
});

test('delayed score metadata resumes the already identified product without another probe', async () => {
    const x = setup({ autoBuy: true, target: 200, low: 100, score: 0 }); x.sold.unit_score = undefined;
    await x.run(); assert.equal(x.buys().length, 1);
    x.backend.aquatic.feed_slot.inputs[0].unit_score = 100; x.sync();
    await x.run(); assert.equal(x.buys().length, 1); assert.equal(x.deposits().length, 1);
});

test('low shop quality can still be used when existing quality surplus safely covers it', async () => {
    const x = setup({ autoBuy: true, score: 90, target: 300, low: 100 }); x.sold.unit_score = 10;
    await x.run(); await x.run();
    assert.equal(x.buys().length, 1); assert.equal(x.backend.aquatic.feed_slot.units, 200);
    assert.equal(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('budget and coin floor limit purchases without depositing a known inadequate partial repair', async () => {
    const x = setup({ autoBuy: true, score: 0, target: 200, low: 100, budget: 5 }); x.sold.units = 50;
    await x.run(); assert.equal(x.buys().length, 1); assert.equal(x.deposits().length, 0);
    await x.run(); assert.equal(x.buys().length, 2); assert.equal(x.backend.aquatic.feed_slot.units, 200);
    assert.equal(x.backend.player.coins, 19990);
    const y = setup({ autoBuy: true, budget: 100, coins: 1000 });
    await y.run(); assert.equal(y.calls.length, 0);
});

test('zero purchase budget never probes even a free product', async () => {
    const x = setup({ autoBuy: true, budget: 0 }); x.backend.shop[0].price = 0; x.sync();
    await x.run(); assert.equal(x.calls.length, 0);
});

test('disabling batch buying keeps all quality-aware purchases at one item', async () => {
    const x = setup({ autoBuy: true, units: 0, target: 500, low: 100 }); x.h.CONFIG.feed.batchBuy = false;
    await x.run(); assert.equal(x.buys().length, 5);
    assert.ok(x.buys().every(req => req.payload.quantity === 1));
    assert.equal(x.backend.aquatic.feed_slot.units, 500);
});

test('changing item selection or target during a purchase prevents the old plan from depositing', async () => {
    for (const change of [x => { x.h.CONFIG.feed.itemId = 'pumpkin'; }, x => { x.h.CONFIG.feed.qualityTarget = 200; },
        x => { x.h.CONFIG.feed.qualityTargetEnabled = false; }]) {
        const x = setup({ autoBuy: true, target: 200, low: 100 });
        x.setResponder(req => { const response = x.respond(req); change(x); return response; });
        await x.run(); assert.equal(x.calls.length, 1); assert.equal(x.deposits().length, 0);
    }
});

test('enabling the quality target during a legacy purchase also stops the old deposit plan', async () => {
    const x = setup({ autoBuy: true }); x.h.CONFIG.feed.qualityTargetEnabled = false;
    x.setResponder(req => { const response = x.respond(req); x.h.CONFIG.feed.qualityTargetEnabled = true; return response; });
    await x.run(); assert.equal(x.calls.length, 1); assert.equal(x.deposits().length, 0);
});

test('pre-write resynchronization invalidates a quality deposit based on the old slot state', async () => {
    const x = setup({ score: 0, target: 200, low: 100, stocks: [[3, 1, 100, 100]] });
    x.h.runtime.stateUncertain = true;
    x.backend.aquatic.feed_slot.units = 1000;
    await x.run(); assert.deepEqual(x.calls.map(req => req.method), ['GET']);
});

test('feed UI shows current and predicted quality, endurance and useful waiting reasons', () => {
    const text = node => [node.textContent || '', ...(node.children || []).map(text)].join('\n');
    const x = setup({ score: 0, target: 200, low: 100, stocks: [[3, 1, 100, 100]] });
    const body = x.context.document.createElement('div');
    x.h.renderFeedChoice(body, x.h.runtime.state);
    const lines = text(body);
    assert.match(lines, /品质分\s*0\s*→\s*50/); assert.match(lines, /目标\s*≥\s*50/); assert.match(lines, /续航/);
    const y = setup({ score: 0, target: 200, low: 100, stocks: [[0, 1, 100, 10]] });
    const empty = y.context.document.createElement('div'); y.h.renderFeedChoice(empty, y.h.runtime.state);
    assert.match(text(empty), /无法.*品质目标/);
});

test('quality plans match exhaustive whole-piece combinations for varied capacities and scores', () => {
    let seed = 7919;
    const random = limit => { seed = (seed * 48271) % 2147483647; return seed % limit; };
    for (let sample = 0; sample < 70; sample++) {
        const units = random(5), capacity = units + 10 + random(10), score = random(100), goal = Math.max(41, random(80));
        const target = Math.max(1, capacity - random(6));
        const stocks = [0, 1, 2].map(quality => [quality, 1 + random(3), 1 + random(7), random(120)]);
        const x = setup({ units, capacity, score, goal, target, low: 0, stocks }), plan = x.plan();
        let best = null;
        for (let a = 0; a <= stocks[0][1]; a++) for (let b = 0; b <= stocks[1][1]; b++) for (let c = 0; c <= stocks[2][1]; c++) {
            const counts = [a, b, c];
            const added = counts.reduce((sum, n, i) => sum + n * stocks[i][2], 0), total = units + added;
            if (total > capacity) continue;
            const result = total ? (units * score + counts.reduce((sum, n, i) => sum + n * stocks[i][2] * stocks[i][3], 0)) / total : 0;
            if (result + 1e-9 < goal) continue;
            const filled = total >= target;
            if (!best || (filled && !best.filled) || (filled === best.filled && (filled ? total < best.total : total > best.total))) best = { total, filled };
        }
        assert.equal(plan.feasible, !!best, `sample ${sample}`);
        if (best) { assert.equal(plan.units, best.total, `sample ${sample}`); assert.ok(plan.quality + 1e-9 >= goal); }
    }
});

test('a cached purchased score cannot override newly conflicting official inputs', async () => {
    const x = setup({ autoBuy: true, score: 0, target: 500, low: 100, budget: 5 });
    await x.run(); assert.equal(x.buys().length, 1);
    x.backend.aquatic.feed_slot.units = 100; x.backend.aquatic.feed_slot.quality_score = 0;
    x.backend.inventory.push({ item_id: 'balanced', name: '均衡饲料', quality: 0, quantity: 1 });
    x.backend.aquatic.feed_slot.inputs = [100, 10].map(unit_score => ({ item_id: 'balanced', quality: 0, units: 100, quantity: 1, unit_score }));
    x.sync(); await x.run();
    assert.equal(x.buys().length, 1); assert.equal(x.deposits().length, 1);
});

test('an unconfirmed later purchase pauses the previously known product instead of buying again', async () => {
    const x = setup({ autoBuy: true, score: 0, target: 500, low: 100, budget: 5 });
    await x.run(); assert.equal(x.buys().length, 1);
    x.setResponder(req => { assert.ok(req.url.endsWith('/shop/buy')); return x.response(); });
    await x.run(); assert.equal(x.buys().length, 2);
    await x.run(); assert.equal(x.buys().length, 2);
    assert.match(x.log(), /尚未确认|待确认/);
});

test('one usable quality fills a hundred-thousand-unit slot without enumerating every piece', async () => {
    const x = setup({ units: 0, capacity: 100000, target: 80000, stocks: [[3, 100000, 1, 100]] });
    const plan = x.plan();
    assert.equal(plan.feasible, true); assert.equal(plan.units, 80000);
    assert.equal(plan.deposits[0].count, 80000);
    await x.run(); assert.equal(x.deposits().length, 1); assert.equal(x.backend.aquatic.feed_slot.units, 80000);
});

test('large single-quality plans still subtract protected inventory', async () => {
    const x = setup({ units: 0, capacity: 100000, target: 80000, stocks: [[3, 100000, 1, 100]] });
    x.h.CONFIG.selling.keepByItemId.balanced = 90000;
    const plan = x.plan();
    assert.equal(plan.feasible, true); assert.equal(plan.units, 10000); assert.equal(plan.missing, 70000);
    await x.run(); assert.equal(x.backend.inventory[0].quantity, 90000);
});

test('large single-quality plans cannot repair a deficit without sufficient capacity', async () => {
    const x = setup({ units: 80000, score: 20, capacity: 100000, target: 90000,
        stocks: [[3, 100000, 1, 100]] });
    assert.equal(x.plan().feasible, false);
    await x.run(); assert.equal(x.calls.length, 0);
});

test('quality equal to or below target cannot repair a negative existing quality margin', async () => {
    for (const score of [0, 49, 50]) {
        const x = setup({ units: 100, score: 10, capacity: 100000, target: 80000,
            stocks: [[3, 100000, 1, score]] });
        assert.equal(x.plan().feasible, false);
        await x.run(); assert.equal(x.calls.length, 0);
    }
});

test('a large positive quality margin only admits the exact safe count of lower-scoring feed', async () => {
    const x = setup({ units: 80000, score: 90, capacity: 200000, target: 180000, low: 80000,
        stocks: [[0, 200000, 1, 10]] });
    const plan = x.plan();
    assert.equal(plan.deposits[0].count, 80000); assert.equal(plan.units, 160000); assert.equal(plan.quality, 50);
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 160000);
    assert.equal(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('a calibration rejected by the local action limit remains available on the next tick', async () => {
    const x = setup({ autoBuy: true, units: 100, score: 0, target: 300, low: 100 });
    x.h.runtime.actionCount = x.h.CONFIG.maxActionsPerTick;
    await assert.rejects(x.h.doAquaticFeed(), error => error.code === 'action_limit' && error.writeNotSent);
    assert.equal(x.calls.length, 0);
    assert.equal([...x.storage.keys()].some(key => key.startsWith('rlt-feed-quality-product:')), false);
    await x.run(); assert.equal(x.buys().length, 2); assert.equal(x.backend.aquatic.feed_slot.units, 300);
});

test('a definite purchase rejection restores calibration evidence before a later retry', async () => {
    const x = setup({ autoBuy: true, units: 100, score: 0, target: 300, low: 100 });
    x.setResponder(() => ({ ok: false, status: 400, headers: { get() { return null; } },
        json: async () => ({ message: '商品暂不可购买' }) }));
    await x.run();
    assert.equal([...x.storage.keys()].some(key => key.startsWith('rlt-feed-quality-product:')), false);
    x.setResponder(x.respond); await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 300);
});

test('an ambiguous purchase keeps its calibration marker across the next tick', async () => {
    const x = setup({ autoBuy: true, units: 100, score: 0, target: 300, low: 100 });
    x.setResponder(req => {
        if (req.url.endsWith('/shop/buy')) throw new Error('response lost');
        return x.respond(req);
    });
    await assert.rejects(x.run(), error => error.code === 'network_error');
    assert.equal(x.buys().length, 1);
    x.setResponder(x.respond); await x.run(); assert.equal(x.buys().length, 1);
});

test('purchase rejection cannot overwrite newer evidence for the same product', async () => {
    const x = setup({ autoBuy: true, units: 100, score: 0, target: 300, low: 100 });
    const replacement = JSON.stringify({ quality: 4, units: 100, unit_score: 150, attempted: true });
    let savedKey;
    x.setResponder(() => {
        savedKey = [...x.storage.keys()].find(key => key.startsWith('rlt-feed-quality-product:'));
        x.h.setOverride(savedKey, replacement);
        return { ok: false, status: 400, headers: { get() { return null; } }, json: async () => ({ message: '已拒绝' }) };
    });
    await x.run(); assert.equal(x.storage.get(savedKey), replacement);
});
