const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
// Reuse the established synthetic two-pond fixture without registering its tests.
// The mock resolves its known species independently of the helper's metadata parser.
let fixtureSource = fs.readFileSync(path.join(__dirname, 'red-leaf-town-pond-fry.test.cjs'), 'utf8');
fixtureSource = fixtureSource.slice(0, fixtureSource.indexOf("test('pond fry buying defaults"))
    .replace('pondStockPlan, doAquaticFeed,', 'pondStockPlan, pondFryPurchasePlan, pondFryHoldSignature, doAquaticFeed,')
    .replace('shop.item?.item_id ?? shop.item_id', 'shop.item_id ?? shop.item?.item_id ?? shop.item?.id')
    .replaceAll('(species.fry_item?.item_id ?? species.fry_item?.id)', "(species.id === 'green_carp' ? 'green_carp_fry' : 'carp_fry')")
    .replaceAll('(species.fry_item.item_id ?? species.fry_item.id)', "(species.id === 'green_carp' ? 'green_carp_fry' : 'carp_fry')");
const { setup } = new Function('require', '__dirname', `${fixtureSource}\nreturn { setup };`)(require, __dirname);
const itemId = 'green_carp_fry';
const fry = x => x.backend.inventory.find(row => row.item_id === itemId && row.quality === 1);
const hold = x => JSON.parse(x.h.getOverride('rlt-pond-fry-hold:pond2') || 'null');
const totalBought = x => x.buys().reduce((sum, request) => sum + request.payload.quantity, 0);
const expectSettled = x => assert.equal(x.intent(), null, 'known successful purchases must not require manual uncertainty recovery');

test('a normal tribute larger than the first purchase is filled over finite passes without a permanent hold', async () => {
    const x = setup(); x.backend.portals = [{ unlocked: true,
        tributes: [{ item_id: itemId, quantity: 40, min_quality: 1 }] }]; x.sync();
    await x.step(); assert.equal(totalBought(x), 37); assert.equal(x.stocks().length, 0); expectSettled(x);
    for (let pass = 0; pass < 4; pass++) await x.step();
    assert.equal(x.pond('pond2').population, 37); assert.equal(fry(x).quantity, 40); assert.equal(totalBought(x), 77);
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0); expectSettled(restored);
});

test('small per-pass budgets can accumulate a normal keep before filling the pond without overbuying', async () => {
    const x = setup({ budget: 25 }); x.h.CONFIG.selling.keepByItemId[itemId] = 10;
    for (let pass = 0; pass < 12; pass++) { await x.step(); expectSettled(x); }
    assert.ok(x.buys().every(request => request.payload.quantity <= 5));
    assert.equal(totalBought(x), 47); assert.equal(fry(x).quantity, 10); assert.equal(x.pond('pond2').population, 37);
});

test('a legacy hold without quality evidence is reevaluated instead of permanently blocking normal replenishment', async () => {
    const x = setup({ stock: 5 }); x.h.CONFIG.selling.keepByItemId[itemId] = 10;
    x.h.setOverride('rlt-pond-fry-hold:pond2', JSON.stringify({ itemId, speciesId: 'green_carp',
        signature: x.h.pondFryHoldSignature(x.h.runtime.state, itemId) }));
    await x.step(); assert.equal(x.buys().length, 1); expectSettled(x);
    for (let pass = 0; pass < 3; pass++) await x.step();
    assert.equal(x.pond('pond2').population, 37); assert.equal(fry(x).quantity, 10); assert.equal(totalBought(x), 42);
});

test('a genuinely protected high-quality stack still permits at most one ordinary-fry purchase to establish evidence', async () => {
    const x = setup(); x.backend.inventory.push({ item_id: itemId, name: '青鲤鱼苗', quality: 3, quantity: 1 });
    x.backend.aquatic.species[1].owned_fry = 1;
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: itemId, quantity: 1, min_quality: 3 }] }]; x.sync();
    await x.step(); assert.equal(x.buys().length, 1); expectSettled(x);
    assert.equal(hold(x)?.kind, 'quality');
    for (let pass = 0; pass < 3; pass++) await x.step();
    assert.equal(x.buys().length, 1); assert.equal(x.stocks().length, 0);
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0);
    assert.equal(restored.backend.inventory.find(row => row.quality === 3).quantity, 1);
});

test('a legacy hold still blocks repeated ordinary purchases when the preserved inventory proves a high-quality constraint', async () => {
    const x = setup({ stock: 37 });
    x.backend.inventory.push({ item_id: itemId, name: '青鲤鱼苗', quality: 3, quantity: 1 });
    x.backend.aquatic.species[1].owned_fry = 38;
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: itemId, quantity: 1, min_quality: 3 }] }]; x.sync();
    x.h.setOverride('rlt-pond-fry-hold:pond2', JSON.stringify({ itemId, speciesId: 'green_carp',
        signature: x.h.pondFryHoldSignature(x.h.runtime.state, itemId) }));
    for (let pass = 0; pass < 3; pass++) await x.step();
    assert.equal(x.calls.length, 0); assert.equal(fry(x).quantity, 37); expectSettled(x);
});

test('a quality hold from one shop does not block a replacement shop delivering useful higher-quality fry', async () => {
    const x = setup(); x.backend.inventory.push({ item_id: itemId, name: '青鲤鱼苗', quality: 3, quantity: 1 });
    x.backend.aquatic.species[1].owned_fry = 1;
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: itemId, quantity: 1, min_quality: 3 }] }]; x.sync();
    await x.step(); assert.equal(hold(x)?.kind, 'quality');
    x.backend.shop[1] = { id: 'new-green-fry-shop', item_id: itemId, item: { name: '青鲤鱼苗' }, price: 5 };
    x.soldQuality = 3; x.sync(); await x.step();
    assert.deepEqual(x.buys().map(request => request.payload.shop_id), ['green-carp-fry-shop', 'new-green-fry-shop']);
    assert.equal(x.pond('pond2').population, 37);
    assert.equal(x.backend.inventory.find(row => row.quality === 3).quantity, 1); expectSettled(x);
});

test('a quality hold releases automatically when its high-quality tribute ends', async () => {
    const x = setup(); x.backend.inventory.push({ item_id: itemId, name: '青鲤鱼苗', quality: 3, quantity: 1 });
    x.backend.aquatic.species[1].owned_fry = 1;
    x.backend.portals = [{ unlocked: true, tributes: [{ item_id: itemId, quantity: 1, min_quality: 3 }] }]; x.sync();
    await x.step(); assert.equal(hold(x)?.kind, 'quality');
    x.backend.portals[0].completed = true; x.sync(); await x.step();
    assert.equal(x.buys().length, 1); assert.equal(x.pond('pond2').population, 37); expectSettled(x);
});

test('a confirmed purchase with delayed owned metadata records sync waiting and immediately replans when owned catches up', async () => {
    const x = setup({ budget: 10 });
    x.after(request => { if (request.url.endsWith('/shop/buy')) x.backend.aquatic.species[1].owned_fry = 0; });
    await x.step(); assert.equal(totalBought(x), 2); assert.equal(fry(x).quantity, 2); expectSettled(x);
    assert.equal(hold(x)?.kind, 'sync'); assert.equal(x.stocks().length, 0);
    for (let pass = 0; pass < 3; pass++) await x.step(); assert.equal(x.buys().length, 1);
    const restored = x.reload(); await restored.step(); assert.equal(restored.calls.length, 0);
    restored.backend.aquatic.species[1].owned_fry = 2; restored.sync(); await restored.step();
    assert.equal(restored.buys().length, 1, 'owned recovery removes the stale hold before planning this pass');
    assert.equal(restored.stocks()[0].payload.quantity, 4); assert.equal(restored.pond('pond2').population, 4); expectSettled(restored);
});

test('shop.item.id identifies the correct fry product even when the shop purchase id is different', async () => {
    const x = setup(); x.backend.shop[1].item = { id: itemId, name: '青鲤鱼苗' }; x.sync(); await x.step();
    assert.deepEqual(x.buys().map(request => request.payload), [{ shop_id: 'green-carp-fry-shop', quantity: 37 }]);
    assert.equal(x.pond('pond2').population, 37); expectSettled(x);
});

test('species.fry_item_id explicitly identifies fry even when the display item has only a name', async () => {
    const x = setup(); x.backend.aquatic.species[1].fry_item_id = itemId;
    x.backend.aquatic.species[1].fry_item = { name: '青鲤鱼苗' }; x.sync(); await x.step();
    assert.equal(x.buys().length, 1); assert.equal(x.pond('pond2').population, 37); expectSettled(x);
});

test('top-level shop.item_id takes priority over a conflicting nested item identity', async () => {
    const x = setup(); x.backend.shop[1] = { id: 'green-carp-fry-shop', item_id: itemId,
        item: { item_id: 'outdated_fry', name: '青鲤鱼苗' }, price: 5 }; x.sync(); await x.step();
    assert.equal(x.buys().length, 1); assert.equal(x.pond('pond2').population, 37);
    assert.equal(x.backend.inventory.some(row => row.item_id === 'outdated_fry'), false); expectSettled(x);
});

test('a name-only fry definition resolves one exact matching item identity from the shop', async () => {
    const x = setup(); x.backend.aquatic.species[1].fry_item = { name: '青鲤鱼苗' };
    x.backend.inventory = x.backend.inventory.filter(row => row.item_id !== itemId); x.sync(); await x.step();
    assert.equal(x.buys().length, 1); assert.equal(x.stocks()[0].payload.species_id, 'green_carp');
    assert.equal(x.pond('pond2').population, 37); expectSettled(x);
});

test('a name-only fry definition can use uniquely identified inventory when buying is disabled', async () => {
    const x = setup({ stock: 5, autoBuy: false }); x.backend.aquatic.species[1].fry_item = { name: '青鲤鱼苗' };
    x.backend.shop = []; x.sync(); await x.step();
    assert.equal(x.buys().length, 0); assert.equal(x.stocks()[0].payload.quantity, 5); expectSettled(x);
});

test('multiple shops for the same exact fry identity are unambiguous and choose the cheapest valid offer', async () => {
    const x = setup(); x.backend.aquatic.species[1].fry_item = { name: '青鲤鱼苗' };
    x.backend.shop.push({ id: 'green-carp-discount', item_id: itemId, item: { name: '青鲤鱼苗' }, price: 3 }); x.sync();
    await x.step(); assert.equal(x.buys()[0].payload.shop_id, 'green-carp-discount');
    assert.equal(20000 - x.backend.player.coins, 37 * 3); assert.equal(x.pond('pond2').population, 37);
});

test('same-name different item ids are ambiguous and authorize neither purchasing nor inventory stocking', async () => {
    const x = setup({ stock: 5 }); x.backend.aquatic.species[1].fry_item = { name: '青鲤鱼苗' };
    x.backend.shop.push({ id: 'other-shop', item_id: 'different_fry', item: { name: '青鲤鱼苗' }, price: 1 });
    x.backend.inventory.push({ item_id: 'different_fry', name: '青鲤鱼苗', quality: 1, quantity: 5 }); x.sync();
    await x.step(); assert.equal(x.calls.length, 0); assert.equal(fry(x).quantity, 5);
});

test('an explicit fry item id cannot be replaced by a different shop item that happens to share its name', async () => {
    const x = setup({ stock: 5 }); x.backend.aquatic.species[1].fry_item = { item_id: 'explicit_other_fry', name: '青鲤鱼苗' }; x.sync();
    await x.step(); assert.equal(x.calls.length, 0); assert.equal(fry(x).quantity, 5);
});

test('conflicting explicit fry identities pause both buying and stocking rather than selecting an arbitrary alias', async () => {
    for (const change of [species => { species.fry_item_id = 'conflicting_fry'; },
        species => { species.fry_item.id = 'conflicting_fry'; }]) {
        const x = setup({ stock: 5 }); change(x.backend.aquatic.species[1]); x.sync(); await x.step();
        assert.equal(x.calls.length, 0); assert.equal(fry(x).quantity, 5); assert.equal(x.plan().quantity, 0);
    }
});

test('shop purchase ids and species display names never substitute for unconfirmed fry item identities', async () => {
    const x = setup(); x.backend.shop[1] = { id: itemId, item: { name: '青鲤鱼苗' }, price: 5 }; x.sync();
    await x.step(); assert.equal(x.calls.length, 0, 'shop.id is only the purchase route identifier');
    const named = setup({ stock: 5 }); named.backend.aquatic.species[1].name = '青鲤鱼苗';
    named.backend.aquatic.species[1].fry_item = {}; named.sync(); await named.step();
    assert.equal(named.calls.length, 0, 'species.name cannot replace an absent fry_item.name');
});

test('unresolved name-only fry cannot bypass reserves by trusting owned_fry alone', async () => {
    const x = setup({ stock: 5, autoBuy: false }); x.backend.aquatic.species[1].fry_item = { name: 'unrecognized fry' };
    x.h.CONFIG.selling.keepByItemId[itemId] = 5; x.sync(); await x.step();
    assert.equal(x.calls.length, 0); assert.equal(fry(x).quantity, 5); assert.equal(x.plan().quantity, 0);
});

test('uniquely resolved name-only fry still respects its normal inventory keep when stocking', async () => {
    const x = setup({ stock: 5, autoBuy: false }); x.backend.aquatic.species[1].fry_item = { name: '青鲤鱼苗' };
    x.h.CONFIG.selling.keepByItemId[itemId] = 5; x.sync(); await x.step();
    assert.equal(x.calls.length, 0); assert.equal(fry(x).quantity, 5);
    x.h.CONFIG.selling.keepByItemId[itemId] = 0; x.sync(); await x.step();
    assert.equal(x.stocks()[0].payload.quantity, 5);
});

test('real inventory exceeding owned_fry does not permanently disable missing-fry purchases', async () => {
    const x = setup({ stock: 5 }); x.backend.aquatic.species[1].owned_fry = 2; x.sync();
    await x.step(); assert.equal(x.buys().length, 1); assert.equal(x.pond('pond2').population, 37); expectSettled(x);
});

test('stocking never exceeds authoritative owned_fry when inventory contains more fish', async () => {
    const x = setup({ stock: 5, autoBuy: false }); x.backend.aquatic.species[1].owned_fry = 2; x.sync(); await x.step();
    assert.equal(x.buys().length, 0); assert.equal(x.stocks()[0].payload.quantity, 2);
    assert.equal(x.pond('pond2').population, 2); assert.equal(fry(x).quantity, 3);
});

test('shared buying priority rotates after a first pond exhausts the budget and survives refresh', async () => {
    const x = setup({ budget: 21 }); Object.assign(x.pond('pond1'), { stock: 37, population: 37, fry: [] }); x.sync();
    await x.step(); assert.deepEqual(x.buys().map(request => request.payload.shop_id), ['carp-fry-shop']);
    assert.equal(x.h.getOverride('rlt-pond-fry-last-buy'), 'pond1');
    const restored = x.reload(); Object.assign(restored.pond('pond1'), { stock: 37, population: 37, fry: [] }); restored.sync();
    await restored.step();
    assert.deepEqual(restored.buys().map(request => request.payload.shop_id), ['green-carp-fry-shop']);
    assert.equal(restored.buys()[0].payload.quantity, 4); assert.equal(restored.pond('pond2').population, 4);
    assert.equal(restored.h.getOverride('rlt-pond-fry-last-buy'), 'pond2');
    assert.ok(x.backend.player.coins - restored.backend.player.coins <= 21);
});

test('normal-reserve recovery does not override a zero budget or the shared coin floor', async () => {
    for (const options of [{ budget: 0 }, { coins: 1000, reserve: 1000 }]) {
        const x = setup(options); x.h.CONFIG.selling.keepByItemId[itemId] = 10;
        for (let pass = 0; pass < 3; pass++) await x.step();
        assert.equal(x.calls.length, 0); expectSettled(x);
    }
});

test('an unknown applied purchase remains blocked across refresh despite the new recovery paths', async () => {
    const x = setup(); x.after(request => { if (request.url.endsWith('/shop/buy')) throw new Error('response lost'); });
    await assert.rejects(x.step(), error => error.code === 'network_error'); assert.equal(x.intent().phase, 'uncertain');
    assert.equal(x.h.getOverride('rlt-pond-fry-last-buy'), null, 'only a confirmed purchase advances shared priority');
    const restored = x.reload();
    for (let pass = 0; pass < 3; pass++) await restored.step();
    assert.equal(restored.calls.length, 0); assert.equal(restored.intent().phase, 'uncertain'); assert.equal(restored.pond('pond2').population, 0);
});
