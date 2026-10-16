const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');

// Reuse the existing server mock without registering its tests or modifying the
// shared harness, which also exercises unrelated concurrent-request changes.
const source = fs.readFileSync(path.join(__dirname, 'red-leaf-town-feed-mix.test.cjs'), 'utf8');
const boundary = source.indexOf("test('new feed defaults");
assert.ok(boundary > 0, 'the mixed-feed fixture is available independently of its tests');
const prefix = source.slice(0, boundary).replace('feedMode, feedSelection, feedGoal, feedPlan,',
    'renderFeedChoice, feedSettingsSignature, feedMode, feedSelection, feedGoal, feedPlan,');
const { setup: baseSetup, food, assertRatio } = new Function('require', '__dirname',
    `${prefix}\nreturn { setup, food, assertRatio };`)(require, __dirname);
const setup = options => baseSetup({ mode: 'smart', goal: 50, ...options });
const close = (actual, expected, label = 'quality') => assert.ok(Math.abs(actual - expected) < 1e-7,
    `${label}: expected ${expected}, received ${actual}`);
const parts = plan => Array.from(plan.deposits, row => [row.input.item_id, Number(row.input.quality), row.count]);
const text = node => [node.textContent || '', ...(node.children || []).map(text)].join('\n');
function preview(x) {
    const body = x.context.document.createElement('div');
    x.h.renderFeedChoice(body, x.h.runtime.state);
    return text(body);
}
const diluteFoods = () => [food('balanced', 10, 35), food('premium', 10, 150)];
const exactFoods = () => [food('balanced', 10, 35), food('premium', 10, 65)];
const buyFoods = () => [food('balanced', 0, 35, 100, { price: 5 }), food('premium', 10, 150)];

test('a high-quality slot uses available low-score feed to dilute toward the target', async () => {
    const x = setup({ units: 200, score: 100, target: 600, low: 200, foods: diluteFoods() });
    const plan = x.plan();
    assert.equal(plan.feasible, true); assert.equal(plan.units, 600);
    close(plan.quality, 170 / 3); assert.deepEqual(parts(plan), [['balanced', 1, 4]]);
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 170 / 3);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'premium').quantity, 10);
});

test('an empty slot chooses an exact adequate blend instead of using only high-score feed', async () => {
    const x = setup({ target: 400, foods: exactFoods() });
    close(x.plan().quality, 50);
    assert.deepEqual(parts(x.plan()), [['premium', 1, 2], ['balanced', 1, 2]]);
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 400);
    close(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('different qualities of one feed remain alternatives and the least adequate combination wins', async () => {
    const x = setup({ target: 400, foods: [food('balanced', 10, 35, 100, { quality: 1 }),
        food('balanced', 10, 65, 100, { quality: 4 })] });
    close(x.plan().quality, 50);
    assert.deepEqual(parts(x.plan()), [['balanced', 4, 2], ['balanced', 1, 2]]);
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('a custom mixture preserves item ratios while avoiding unnecessary higher-quality stacks', async () => {
    const recipe = [['balanced', 50], ['premium', 50]];
    const x = setup({ mode: 'mix', target: 400, recipe, foods: [food('balanced', 10, 35),
        food('balanced', 10, 150, 100, { quality: 3 }), food('premium', 10, 65)] });
    const plan = x.plan(); assertRatio(plan, recipe); close(plan.quality, 50);
    assert.ok(plan.deposits.every(row => row.input.quality !== 3));
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 50);
    assert.equal(x.backend.inventory.find(row => row.quality === 3).quantity, 10);
});

test('mixture pruning retains a higher-quality route when lower qualities alone cannot meet the floor', async () => {
    const recipe = [['balanced', 50], ['premium', 50]];
    const x = setup({ mode: 'mix', target: 400, recipe, foods: [food('balanced', 10, 35),
        food('balanced', 10, 65, 100, { quality: 3 }), food('premium', 10, 35)] });
    const plan = x.plan(); assert.equal(plan.feasible, true); assertRatio(plan, recipe);
    close(plan.quality, 50); assert.equal(plan.units, 400);
    assert.equal(plan.deposits.filter(row => row.input.item_id === 'balanced' && row.input.quality === 3)
        .reduce((sum, row) => sum + row.count, 0), 2);
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('large custom mixtures use the small high-quality portion needed for the goal instead of all high stock', () => {
    const recipe = [['balanced', 50], ['premium', 50]];
    const x = setup({ mode: 'mix', target: 80000, capacity: 100000, recipe,
        foods: [food('balanced', 1000, 35), food('balanced', 1000, 150, 100, { quality: 3 }), food('premium', 1000, 35)] });
    const plan = x.plan(); assert.equal(plan.feasible, true); assertRatio(plan, recipe);
    assert.equal(plan.units, 80000);
    const high = plan.deposits.filter(row => row.input.quality === 3).reduce((sum, row) => sum + row.count, 0);
    assert.equal(high, 105, '104 premium pieces are insufficient; 105 suffice with the low stock');
    close(plan.quality, 50.09375);
});

test('six-component large mixtures retain economical quality at both neighboring whole-piece amounts', () => {
    const ids = ['balanced', 'premium', 'grain', 'meal', 'pellet', 'ration'];
    const recipe = ids.map(id => [id, 1]);
    const foods = ids.flatMap(id => [35, 50, 80, 150].map((score, index) =>
        food(id, 100000, score, 1, { quality: index + 1 })));
    const x = setup({ mode: 'mix', target: 80000, capacity: 100000, recipe, foods });
    const plan = x.plan(); assert.equal(plan.feasible, true); assertRatio(plan, recipe);
    assert.equal(plan.units, 80000); close(plan.quality, 50);
});

test('a custom mixture also uses existing quality surplus to choose both lower-score components', async () => {
    const recipe = [['balanced', 50], ['premium', 50]];
    const x = setup({ mode: 'mix', units: 200, score: 100, target: 600, low: 200, recipe,
        foods: [food('balanced', 10, 35), food('balanced', 10, 150, 100, { quality: 3 }), food('premium', 10, 35)] });
    const plan = x.plan(); assertRatio(plan, recipe); close(plan.quality, 170 / 3);
    assert.ok(plan.deposits.every(row => row.input.quality !== 3));
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 170 / 3);
});

test('repeated consumption and refilling do not continually increase quality when low feed is available', async () => {
    const x = setup({ units: 100, score: 100, target: 500, low: 100,
        foods: [food('balanced', 50, 35), food('premium', 50, 150)] });
    const scores = [];
    for (let round = 0; round < 4; round++) {
        await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 500);
        const score = x.backend.aquatic.feed_slot.quality_score;
        assert.ok(score >= 50 - 1e-9 && score <= 73 + 1e-9, `round ${round}: ${score}`);
        scores.push(score);
        // Consumption changes the remaining amount, not the average score.
        x.backend.aquatic.feed_slot.units = 100; x.sync();
    }
    assert.ok(scores.every(score => score < 100));
    assert.ok(x.backend.inventory.find(row => row.item_id === 'premium').quantity >= 46,
        'at most one premium piece is needed in each of these refill cycles');
});

test('the planner does not expand the water target when the extra stock cannot usefully dilute it', async () => {
    const x = setup({ target: 800, capacity: 1000,
        foods: [food('balanced', 4, 35, 250), food('premium', 1, 65, 800)] });
    const plan = x.plan(); assert.equal(plan.units, 800); close(plan.quality, 65);
    assert.deepEqual(parts(plan), [['premium', 1, 1]]);
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 800,
        'the planner must not fill the extra capacity just to dilute quality');
});

test('one low-score 100-unit piece can beat two high-score 40-unit pieces for a 71.1-unit shortage', async () => {
    const x = setup({ units: 100, score: 100, target: 171.1, low: 100, capacity: 300,
        foods: [food('balanced', 10, 35, 100), food('premium', 10, 150, 40)] });
    const plan = x.plan(); assert.equal(plan.units, 200); close(plan.quality, 67.5);
    assert.deepEqual(parts(plan), [['balanced', 1, 1]]);
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 200);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'premium').quantity, 10);
});

test('better quality cannot justify removable extra pieces beyond the water target', async () => {
    const x = setup({ target: 800, capacity: 1000, foods: diluteFoods() });
    const plan = x.plan(); assert.equal(plan.units, 800); close(plan.quality, 63.75);
    // Filling 900 or 1000 would dilute further, but a low-score piece could then
    // be removed while retaining both the 800-unit water target and quality 50.
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 800);
    close(x.backend.aquatic.feed_slot.quality_score, 63.75);
});

test('already adequate feed volume is not expanded solely to dilute a high average', async () => {
    const x = setup({ units: 800, score: 150, target: 800, low: 200, capacity: 1000, foods: diluteFoods(), autoBuy: true });
    await x.run(); assert.equal(x.calls.length, 0);
    assert.equal(x.backend.aquatic.feed_slot.units, 800); close(x.backend.aquatic.feed_slot.quality_score, 150);
});

test('only high-score stock still feeds animals and explains unavoidable overshoot in the preview', async () => {
    const x = setup({ target: 400, foods: [food('premium', 10, 150)] });
    const explanation = preview(x);
    assert.match(explanation, /150/);
    assert.match(explanation, /高于目标|超过目标|偏高|无法.*贴近|不能.*贴近|难以.*贴近|仅有高分|只有高分/,
        'the preview must explain why a target of 50 still produces 150');
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 400);
    close(x.backend.aquatic.feed_slot.quality_score, 150);
});

test('an exactly adequate feed is preferred over a higher-score stock at the same volume', async () => {
    const x = setup({ target: 400, foods: [food('balanced', 4, 50), food('premium', 4, 150)] });
    assert.deepEqual(parts(x.plan()), [['balanced', 1, 4]]);
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 50);
});

test('equal amount and score retain distinct ingredient sets with different removable-piece conditions', async () => {
    const x = setup({ target: 60, capacity: 200, low: 0, foods: [
        food('a', 1, 40, 10), food('b', 1, 60, 90),
        food('c', 1, 40, 50), food('d', 1, 76, 50),
    ] });
    // A+B and C+D both add 100 units and 5,800 score-points. A is removable
    // from A+B, but neither C nor D can be removed while reaching 60 units.
    const plan = x.plan(); assert.equal(plan.units, 100); close(plan.quality, 58);
    assert.deepEqual(parts(plan), [['d', 1, 1], ['c', 1, 1]]);
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 58);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'a').quantity, 1);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'b').quantity, 1);
});

test('small smart plans match exhaustive nonredundant whole-piece and closest-adequate-quality choices', () => {
    let seed = 27183;
    const random = limit => { seed = seed * 48271 % 2147483647; return seed % limit; };
    for (let sample = 0; sample < 32; sample++) {
        const units = random(4), score = random(151), capacity = units + 10 + random(8);
        const target = capacity - random(4);
        const foods = ['balanced', 'premium', 'grain'].map(id => food(id, 1 + random(4),
            [15, 35, 50, 65, 150][random(5)], 1 + random(5)));
        const x = setup({ units, score, capacity, target, low: 0, foods });
        let best = null;
        for (let a = 0; a <= foods[0].quantity; a++) for (let b = 0; b <= foods[1].quantity; b++)
            for (let c = 0; c <= foods[2].quantity; c++) {
                const counts = [a, b, c], added = counts.reduce((sum, n, i) => sum + n * foods[i].units, 0);
                const total = units + added; if (!total || total > capacity) continue;
                const quality = (units * score + counts.reduce((sum, n, i) => sum + n * foods[i].units * foods[i].score, 0)) / total;
                if (quality + 1e-9 < 50) continue;
                const filled = total >= target;
                if (filled && counts.some((count, i) => count > 0 && total - foods[i].units >= target &&
                    (quality * total - foods[i].units * foods[i].score) / (total - foods[i].units) + 1e-9 >= 50)) continue;
                if (!best || (filled && !best.filled) || (filled === best.filled &&
                    (filled ? quality < best.quality - 1e-9 || (Math.abs(quality - best.quality) <= 1e-9 && total < best.total)
                        : total > best.total || (total === best.total && quality < best.quality)))) {
                    best = { total, quality, filled };
                }
            }
        const plan = x.plan(); assert.equal(plan.feasible, !!best, `sample ${sample} feasibility`);
        if (best) {
            assert.equal(plan.units, best.total, `sample ${sample} volume`);
            close(plan.quality, best.quality, `sample ${sample} closest adequate quality`);
        }
    }
});

test('unknown and invalid scores are never treated as free low-quality dilution', async () => {
    for (const score of [undefined, null, '', NaN, -1]) {
        const x = setup({ units: 200, score: 100, target: 600, low: 200,
            foods: [food('balanced', 10, score), food('premium', 10, 150)] });
        const plan = x.plan(); assert.equal(plan.feasible, true);
        assert.ok(plan.deposits.every(row => row.input.item_id === 'premium'));
        await x.run(); assert.ok(x.deposits().every(row => row.payload.item_id === 'premium'));
    }
});

test('conflicting conversion metadata cannot provide a cheap dilution ingredient', async () => {
    const x = setup({ target: 400, foods: exactFoods() });
    x.backend.aquatic.feed_slot.inputs.push({ ...x.backend.aquatic.feed_slot.inputs[0], unit_score: 5 }); x.sync();
    assert.ok(x.plan().deposits.every(row => row.input.item_id === 'premium'));
    await x.run(); assert.ok(x.deposits().every(row => row.payload.item_id === 'premium'));
});

test('protected high-quality stock cannot make otherwise inadequate low feed eligible', async () => {
    const x = setup({ target: 400, foods: [food('balanced', 10, 35), food('premium', 2, 150, 100, { quality: 4 })] });
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'premium', quantity: 2, min_quality: 4 }] }]; x.sync();
    assert.equal(x.plan().feasible, false);
    await x.run(); assert.equal(x.calls.length, 0);
});

test('explicit inventory keep remains protected when its low-score feed would be more economical', async () => {
    const x = setup({ units: 200, score: 100, target: 600, low: 200, foods: diluteFoods() });
    x.h.CONFIG.selling.keepByItemId.balanced = 8;
    await x.run(); assert.equal(x.backend.aquatic.feed_slot.units, 600);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'balanced').quantity, 8);
    close(x.backend.aquatic.feed_slot.quality_score, 95);
});

test('whole pieces that cannot fit do not authorize fractional dilution or overfilling', async () => {
    const x = setup({ units: 190, capacity: 200, score: 100, target: 200, low: 190,
        foods: [food('balanced', 10, 35, 20), food('premium', 10, 150, 20)] });
    await x.run(); assert.equal(x.calls.length, 0); assert.equal(x.backend.aquatic.feed_slot.units, 190);
});

test('known low-score purchases improve a full high-score inventory plan without spending unused pieces', async () => {
    const x = setup({ units: 200, score: 100, target: 600, low: 200, foods: buyFoods(), autoBuy: true });
    x.know('balanced'); await x.run();
    assert.deepEqual(x.buys().map(row => [row.payload.shop_id, row.payload.quantity]), [['balanced-shop', 4]]);
    assert.equal(x.spent(), 20); close(x.backend.aquatic.feed_slot.quality_score, 170 / 3);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'balanced').quantity, 0);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'premium').quantity, 10);
});

test('a full-capacity water target still permits economical purchases using actual remaining space', async () => {
    const x = setup({ units: 200, score: 100, target: 1000, capacity: 1000, low: 200,
        foods: buyFoods(), autoBuy: true, budget: 35, coins: 1035 });
    x.know('balanced');
    assert.equal(x.plan().room, 0, 'the existing high-score plan would fill the slot');
    await x.run();
    assert.deepEqual(x.buys().map(row => [row.payload.shop_id, row.payload.quantity]), [['balanced-shop', 7]]);
    assert.equal(x.spent(), 35); assert.equal(x.backend.player.coins, 1000);
    assert.equal(x.backend.aquatic.feed_slot.units, 1000); close(x.backend.aquatic.feed_slot.quality_score, 59.5);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'balanced').quantity, 0);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'premium').quantity, 9);
});

test('an economical 100-unit purchase replaces two 40-unit high-score pieces without stockpiling', async () => {
    const x = setup({ units: 100, score: 100, target: 171.1, capacity: 200, low: 100,
        foods: [food('balanced', 0, 35, 100, { price: 5 }), food('premium', 10, 150, 40)],
        autoBuy: true, budget: 5, coins: 1005 });
    x.know('balanced'); await x.run();
    assert.deepEqual(x.buys().map(row => [row.payload.shop_id, row.payload.quantity]), [['balanced-shop', 1]]);
    assert.deepEqual(x.deposits().map(row => [row.payload.item_id, row.payload.count]), [['balanced', 1]]);
    assert.equal(x.spent(), 5); assert.equal(x.backend.player.coins, 1000);
    assert.equal(x.backend.aquatic.feed_slot.units, 200); close(x.backend.aquatic.feed_slot.quality_score, 67.5);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'balanced').quantity, 0);
    assert.equal(x.backend.inventory.find(row => row.item_id === 'premium').quantity, 10);
});

test('unknown balanced-feed quality is calibrated once before economical purchases', async () => {
    const x = setup({ units: 200, score: 100, target: 600, low: 200, foods: buyFoods(), autoBuy: true });
    await x.run(); assert.equal(x.buys()[0]?.payload.quantity, 1);
    assert.equal(x.buys().reduce((sum, row) => sum + row.payload.quantity, 0), 4);
    close(x.backend.aquatic.feed_slot.quality_score, 170 / 3);
});

test('an economy-only purchase does not calibrate arbitrary unknown goods when stock can fill the slot', async () => {
    const x = setup({ target: 400, foods: [food('grain', 0, 35, 100, { price: 5 }), food('premium', 10, 150)], autoBuy: true });
    await x.run(); assert.equal(x.buys().length, 0); assert.equal(x.backend.aquatic.feed_slot.units, 400);
});

test('an uneconomic known product does not replace usable inventory', async () => {
    const x = setup({ target: 400, foods: [food('balanced', 0, 160, 100, { price: 5 }), food('premium', 10, 150)], autoBuy: true });
    x.know('balanced'); await x.run(); assert.equal(x.buys().length, 0);
    close(x.backend.aquatic.feed_slot.quality_score, 150);
});

test('a restricted shared budget still permits a useful affordable dilution before stock fills the rest', async () => {
    const x = setup({ units: 200, score: 100, target: 600, low: 200, foods: buyFoods(), autoBuy: true, budget: 10 });
    x.know('balanced'); await x.run();
    assert.equal(x.spent(), 10); assert.equal(x.backend.aquatic.feed_slot.units, 600);
    close(x.backend.aquatic.feed_slot.quality_score, 95);
});

test('zero budget or the coin floor prevents economy purchases but does not starve available inventory', async () => {
    for (const options of [{ budget: 0 }, { coins: 1000 }]) {
        const x = setup({ units: 200, score: 100, target: 600, low: 200, foods: buyFoods(), autoBuy: true, ...options });
        x.know('balanced'); await x.run(); assert.equal(x.buys().length, 0);
        assert.equal(x.backend.aquatic.feed_slot.units, 600); assert.ok(x.backend.player.coins >= 1000);
    }
});

test('single mode never replaces the explicitly selected high-score feed with another item', async () => {
    const x = setup({ mode: 'single', target: 400, foods: exactFoods(), autoBuy: true });
    x.h.CONFIG.feed.itemId = 'premium'; await x.run();
    assert.equal(x.backend.aquatic.feed_slot.units, 400);
    assert.ok(x.deposits().every(row => row.payload.item_id === 'premium'));
    assert.equal(x.backend.inventory.find(row => row.item_id === 'balanced').quantity, 10);
});

test('an incomplete custom mix does not use an unselected economical substitute', async () => {
    const x = setup({ mode: 'mix', target: 400,
        foods: [food('balanced', 0, 35), food('premium', 10, 65), food('grain', 10, 35)] });
    await x.run(); assert.equal(x.calls.length, 0);
});

test('changing the selection during an economy purchase prevents old-plan deposits', async () => {
    const x = setup({ units: 200, score: 100, target: 600, low: 200, foods: buyFoods(), autoBuy: true });
    x.know('balanced'); x.after(req => {
        if (req.url.endsWith('/shop/buy')) { x.h.CONFIG.feed.mode = 'single'; x.h.CONFIG.feed.itemId = 'premium'; }
    });
    await x.run(); assert.equal(x.buys().length, 1); assert.equal(x.deposits().length, 0);
});

test('a ready smart batch from the previous planning policy is recomputed before any deposit', async () => {
    const x = setup({ target: 400, foods: exactFoods() });
    x.h.setOverride('rlt-feed-batch:v1', JSON.stringify({ version: 1, signature: JSON.stringify(x.h.CONFIG.feed),
        build: 'index-DCECfXs_.js', phase: 'ready', remaining: [{ itemId: 'premium', quality: 1, count: 4, units: 100, score: 65 }] }));
    await x.run(); close(x.backend.aquatic.feed_slot.quality_score, 50);
    assert.equal(x.h.feedBatch(), null);
});

test('a previous-policy custom mixture that already added its high component finishes its recorded remainder', async () => {
    const x = setup({ mode: 'mix', units: 200, score: 65, target: 400, low: 100, foods: exactFoods() });
    x.h.setOverride('rlt-feed-batch:v1', JSON.stringify({ version: 1, signature: JSON.stringify(x.h.CONFIG.feed),
        build: 'index-DCECfXs_.js', phase: 'ready', remaining: [{ itemId: 'balanced', quality: 1, count: 2, units: 100, score: 35 }] }));
    await x.run(); assert.deepEqual(x.deposits().map(row => [row.payload.item_id, row.payload.count]), [['balanced', 2]]);
    close(x.backend.aquatic.feed_slot.quality_score, 50); assert.equal(x.h.feedBatch(), null);
});

test('a planning-policy change never clears an uncertain deposit and repeats it after reload', async () => {
    const x = setup({ target: 400, foods: exactFoods() });
    x.h.setOverride('rlt-feed-batch:v1', JSON.stringify({ version: 1, signature: JSON.stringify(x.h.CONFIG.feed),
        build: 'index-DCECfXs_.js', phase: 'uncertain', remaining: [{ itemId: 'premium', quality: 1, count: 4, units: 100, score: 65 }] }));
    await x.run(); assert.equal(x.calls.length, 0);
    const restored = setup({ configure: false, entries: [...x.storage], foods: exactFoods() });
    restored.backend = structuredClone(x.backend); restored.sync(); await restored.run();
    assert.equal(restored.calls.length, 0); assert.equal(restored.h.feedBatch().phase, 'uncertain');
});

test('a lost economy deposit response preserves the batch across subsequent passes and reload', async () => {
    const x = setup({ target: 400, foods: exactFoods() });
    x.after(req => { if (req.url.endsWith('/feed-slot/deposit')) throw new Error('applied but response lost'); });
    await assert.rejects(x.run(), error => error.code === 'network_error');
    assert.equal(x.h.feedBatch().phase, 'uncertain');
    x.after(() => {}); await x.run(); assert.equal(x.deposits().length, 1);
    const restored = setup({ configure: false, entries: [...x.storage], foods: exactFoods() });
    restored.backend = structuredClone(x.backend); restored.sync(); await restored.run();
    assert.equal(restored.calls.length, 0); assert.equal(restored.h.feedBatch().phase, 'uncertain');
});
