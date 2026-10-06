const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');

// Reuse the existing mock browser and HTTP fixture without running its scenario suite.
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const boundary = shared.indexOf('async function run()');
assert.ok(boundary > 0, 'shared harness boundary exists');
const harnessSource = shared.slice(0, boundary).replace('doAquaticFeed, doSailing,',
    'feedChoices, selectedFeed, renderFeedChoice, doAquaticFeed, doSailing,');
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);

function addFeed(state, id, name, quantity, units = 50) {
    state.inventory.push({ item_id: id, name, quality: 0, quantity });
    state.aquatic.feed_slot.inputs.push({ item_id: id, item: { name }, quality: 0, quantity, units });
}
function depositResponder(x) {
    x.setResponder(req => {
        assert.ok(req.url.endsWith('/feed-slot/deposit'), 'selected stock never purchases a substitute');
        const input = x.backend.aquatic.feed_slot.inputs.find(row => row.item_id === req.payload.item_id && row.quality === req.payload.quality);
        const stack = x.backend.inventory.find(row => row.item_id === req.payload.item_id && row.quality === req.payload.quality);
        assert.ok(stack.quantity >= req.payload.count);
        stack.quantity -= req.payload.count; input.quantity = stack.quantity;
        x.backend.aquatic.feed_slot.units += req.payload.count * input.units;
        assert.ok(x.backend.aquatic.feed_slot.units <= x.backend.aquatic.feed_slot.capacity);
        return x.response();
    });
}

test('unchanged dashboard snapshots reuse the feed catalogue without repeated storage reads', () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 9);
    const x = harness(state); let reads = 0;
    const read = x.context.localStorage.getItem;
    x.context.localStorage.getItem = key => { if (key === 'rlt-feed-catalog') reads++; return read(key); };
    const first = x.h.feedChoices(state), baseline = reads;
    for (let n = 0; n < 10; n++) assert.equal(x.h.feedChoices(state), first);
    assert.equal(reads, baseline);
    const next = structuredClone(state); addFeed(next, 'grain', '谷物饲料', 1);
    assert.equal(x.h.feedChoices(next).length, 2);
});

test('feed choices use actual server inputs and retain multiple qualities as one choice', () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 9); addFeed(state, 'grain', '谷物饲料', 3, 80);
    state.aquatic.feed_slot.inputs.push({ item_id: 'pumpkin', item: { name: '南瓜' }, quality: 2, quantity: 1, units: 100 });
    state.crafting_stations[0].recipes.push({ id: 'nutrition', item: { item_id: 'nutrition', name: '营养饲料' } });
    const { h } = harness(state);
    assert.deepEqual(Array.from(h.feedChoices(state), item => item.itemId), ['pumpkin', 'grain']);
    assert.equal(h.selectedFeed(state).name, '均衡饲料');
    assert.equal(h.selectedFeed(state).entry.id, 'balanced-shop');
});

test('confirmed feed identity persists after depletion and reload, but conversion is not cached', async () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 1, 77);
    const x = harness(state); x.h.feedChoices(state); x.h.CONFIG.feed.itemId = 'pumpkin';
    const empty = fixture(); const y = harness(empty, [...x.storage]);
    assert.equal(y.h.selectedFeed(empty).name, '南瓜');
    assert.equal(y.h.selectedFeed(empty).confirmed, true);
    assert.equal(y.h.feedInputs(empty, 'pumpkin').length, 0);
    y.h.CONFIG.feed.enabled = true; await y.h.doAquaticFeed();
    assert.equal(y.calls.length, 0);
});

test('new game build requires selected nondefault feed to be confirmed again', async () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 1);
    const x = harness(state); x.h.feedChoices(state); x.h.CONFIG.feed.itemId = 'pumpkin';
    x.context.document.scripts[0].src = 'https://chiyuki.diving-fish.com/red-leaf-town/assets/index-newbuild.js';
    x.backend.aquatic.feed_slot.inputs = []; x.sync(); x.h.CONFIG.feed.enabled = true;
    await x.h.doAquaticFeed(); assert.equal(x.calls.length, 0);
    assert.equal(x.h.selectedFeed(x.h.runtime.state).confirmed, false);
});

test('selected pumpkin respects the default keep and does not spend balanced feed', async () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 9); addFeed(state, 'balanced', '均衡饲料', 20, 100);
    const x = harness(state); Object.assign(x.h.CONFIG.feed, { enabled: true, itemId: 'pumpkin' }); depositResponder(x);
    await x.h.doAquaticFeed();
    assert.deepEqual(x.calls.map(req => req.payload), [{ item_id: 'pumpkin', quality: 0, count: 4 }]);
    assert.equal(x.backend.inventory.find(item => item.item_id === 'pumpkin').quantity, 5);
    assert.equal(x.backend.inventory.find(item => item.item_id === 'balanced').quantity, 20);
});

test('selected feed also protects explicit keep, tributes and configured crafting inputs', async () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 20);
    state.portals = [{ unlocked: true, tributes: [{ item_id: 'pumpkin', min_quality: 0, quantity: 4 }] }];
    state.crafting_stations[0].recipes[0].inputs = [{ item_id: 'pumpkin', quantity: 8 }];
    const x = harness(state); Object.assign(x.h.CONFIG.feed, { enabled: true, itemId: 'pumpkin', autoBuy: false });
    x.h.CONFIG.crafting.batchLimit = 1;
    x.h.CONFIG.selling.keepByItemId.pumpkin = 6;
    x.h.setOverride('rlt-node-job:crafting:mill', 'flour');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    depositResponder(x);
    await x.h.doAquaticFeed();
    assert.equal(x.calls[0].payload.count, 8); // 4 tribute + max(6 explicit, 8 recipe) remain.
    assert.equal(x.backend.inventory.find(item => item.item_id === 'pumpkin').quantity, 12);
});

test('selected grain feed buys only its own shop product and honors the shared budget', async () => {
    const state = fixture(); addFeed(state, 'grain', '谷物饲料', 0);
    state.shop.push({ id: 'grain-shop', item: { item_id: 'grain', name: '谷物饲料' }, price: 10 });
    const x = harness(state); Object.assign(x.h.CONFIG.feed, { enabled: true, itemId: 'grain', maxSpendPerTick: 100 });
    x.h.CONFIG.selling.defaultKeep = 0;
    x.setResponder(req => {
        const item = x.backend.inventory.find(row => row.item_id === 'grain'), input = x.backend.aquatic.feed_slot.inputs.find(row => row.item_id === 'grain');
        if (req.url.endsWith('/shop/buy')) {
            assert.equal(req.payload.shop_id, 'grain-shop'); item.quantity += req.payload.quantity; x.backend.player.coins -= req.payload.quantity * 10;
        } else {
            assert.ok(req.url.endsWith('/feed-slot/deposit')); assert.equal(req.payload.item_id, 'grain');
            item.quantity -= req.payload.count; x.backend.aquatic.feed_slot.units += req.payload.count * 50;
        }
        input.quantity = item.quantity; return x.response();
    });
    await x.h.doAquaticFeed();
    assert.deepEqual(x.calls.filter(req => req.url.endsWith('/shop/buy')).map(req => req.payload.quantity), [1, 9]);
    assert.equal(x.backend.player.coins, 19900); assert.equal(x.backend.aquatic.feed_slot.units, 600);
});

test('unconfirmed configured item cannot purchase arbitrary shop goods or fall back to balanced feed', async () => {
    const state = fixture(); state.shop.push({ id: 'rare-shop', item: { item_id: 'rare', name: '稀有材料' }, price: 1 });
    addFeed(state, 'balanced', '均衡饲料', 20, 100);
    const x = harness(state); Object.assign(x.h.CONFIG.feed, { enabled: true, itemId: 'rare' });
    await x.h.doAquaticFeed(); assert.equal(x.calls.length, 0);
});

test('conflicting feed conversion data is excluded and never deposited', async () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 20);
    state.aquatic.feed_slot.inputs.push({ item_id: 'pumpkin', quality: 0, quantity: 20, units: 90 });
    const x = harness(state); Object.assign(x.h.CONFIG.feed, { enabled: true, itemId: 'pumpkin' });
    await x.h.doAquaticFeed(); assert.equal(x.calls.length, 0);
});

test('changing selection during a purchase stops deposits for the old selection', async () => {
    const x = harness(); x.h.CONFIG.feed.enabled = true;
    x.setResponder(req => {
        assert.ok(req.url.endsWith('/shop/buy'));
        addFeed(x.backend, 'balanced', '均衡饲料', req.payload.quantity, 100);
        x.h.CONFIG.feed.itemId = 'pumpkin'; return x.response();
    });
    await x.h.doAquaticFeed(); assert.equal(x.calls.length, 1);
});

test('feed selector persists an explicit choice and resets the previous filling cycle', () => {
    const state = fixture(); addFeed(state, 'pumpkin', '南瓜', 10);
    const x = harness(state), body = x.context.document.createElement('div');
    x.h.setRunning(false);
    x.h.renderFeedChoice(body, state);
    const select = body.children.flatMap(row => row.children).find(child => child.tagName === 'SELECT' && child.getAttribute('aria-label') === '投喂物品');
    assert.ok(select.children.some(option => option.value === 'pumpkin' && option.textContent.includes('南瓜')));
    x.h.setOverride('rlt-feed-filling', '1'); select.value = 'pumpkin'; select.onchange();
    assert.equal(x.h.CONFIG.feed.itemId, 'pumpkin'); assert.equal(x.h.getOverride('rlt-feed-filling'), null);
    assert.equal(harness(state, [...x.storage]).h.CONFIG.feed.itemId, 'pumpkin');
});
