const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, harness, sourcePath } = require('./red-leaf-town-v4.test.cjs');

function outputHarness(state) {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        const source = originalRead.call(this, filename, ...args);
        return filename === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            'window.__craftOutputAudit = { craftRecipeOutputId, craftRecipeOutput, craftMaterialTree }; if (CONFIG.ui.autoStart) start();') : source;
    };
    try {
        const x = harness(state);
        x.audit = x.context.window.__craftOutputAudit;
        x.tree = () => x.audit.craftMaterialTree(x.h.runtime.state,
            x.h.runtime.state.crafting_stations.find(node => node.station_id === 'feed'));
        return x;
    } finally { fs.readFileSync = originalRead; }
}

const aliases = ['produce_item_id', 'output_item_id', 'item.id', 'produce.id'];
const names = { nutrition_feed: '营养饲料', fine_feed: '精饲料', grain_feed: '谷物饲料', wheat: '小麦' };
// This is a synthetic protocol fixture, not a claim about the live game's recipe ingredients or yields.
const outputs = new Map([
    ['make-nutrition', { id: 'nutrition_feed', quantity: 1 }],
    ['make-fine', { id: 'fine_feed', quantity: 2 }],
    ['make-grain', { id: 'grain_feed', quantity: 3 }],
]);

function recipe(recipeId, inputs, alias) {
    const output = outputs.get(recipeId);
    const row = { id: recipeId, name: names[output.id], unlocked: true, stamina_cost: 1,
        duration_seconds: 60, produce_quantity: output.quantity, item: { name: names[output.id] },
        inputs: Object.entries(inputs).map(([item_id, quantity]) => ({ item_id, quantity,
            item: { name: names[item_id] } })) };
    if (alias === 'item.id') row.item.id = output.id;
    else if (alias === 'produce.id') row.produce = { id: output.id, name: names[output.id] };
    else row[alias] = output.id;
    return row;
}
function station(stationId, recipes, extra = {}) {
    return { station_id: stationId, definition: { name: stationId }, recipes,
        empty: true, ready: false, assigned_partner_ids: [], ...extra };
}
function setup(alias, { pending = false, modify = () => {} } = {}) {
    const state = fixture();
    const jobs = [recipe('make-nutrition', { fine_feed: 2 }, alias),
        recipe('make-fine', { grain_feed: 3 }, alias), recipe('make-grain', { wheat: 2 }, alias)];
    state.inventory = pending ? [] : [{ item_id: 'wheat', name: names.wheat, quality: 0, quantity: 2 }];
    state.crafting_stations = pending ? [station('feed', jobs.slice(0, 2)), station('mill', [jobs[2]], {
        empty: false, recipe: jobs[2], queue_total: 1, queued_count: 0, completed_count: 0, collected_count: 0,
        task_snapshot: { recipe_id: jobs[2].id, recipe: jobs[2], ready_at: state.server_time + 60 },
    })] : [station('feed', jobs)];
    modify(state, jobs);
    const x = outputHarness(state);
    x.h.CONFIG.crafting.autoCraftInputs = true;
    x.h.setOverride('rlt-node-job:crafting:feed', 'make-nutrition');
    x.h.setOverride('rlt-craft-lock-times:feed', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'feed'), true);
    const addItem = (itemId, quantity) => {
        let item = x.backend.inventory.find(row => row.item_id === itemId);
        if (!item) { item = { item_id: itemId, name: names[itemId], quantity: 0, quality: 0 }; x.backend.inventory.push(item); }
        item.quantity += quantity;
        assert.ok(item.quantity >= 0, `mock backend refused negative inventory for ${itemId}`);
    };
    x.setResponder(request => {
        const match = request.url.match(/\/crafting\/stations\/([^/]+)\/(start|collect)$/);
        assert.ok(match, `unexpected request: ${request.url}`);
        const node = x.backend.crafting_stations.find(row => row.station_id === match[1]);
        assert.ok(node);
        if (match[2] === 'start') {
            assert.equal(node.empty, true);
            const job = node.recipes.find(row => row.id === request.payload.recipe_id);
            assert.ok(job);
            const quantity = request.payload.quantity;
            assert.ok(Number.isInteger(quantity) && quantity > 0 && quantity <= 99);
            for (const input of job.inputs) addItem(input.item_id, -input.quantity * quantity);
            x.backend.player.stamina -= job.stamina_cost * quantity;
            assert.ok(x.backend.player.stamina >= 0);
            Object.assign(node, { empty: false, ready: false, recipe: job, queue_total: quantity,
                queued_count: quantity - 1, completed_count: 0, collected_count: 0,
                task_snapshot: { recipe_id: job.id, recipe: job, ready_at: x.backend.server_time + 60 } });
            return x.response();
        }
        assert.ok(node.completed_count > 0);
        const count = node.completed_count, output = outputs.get(node.recipe.id);
        // Keep the mock server's canonical output independent of the client's alias parser.
        addItem(output.id, count * output.quantity);
        Object.assign(node, { empty: true, ready: false, recipe: null, task_snapshot: null,
            queue_total: 0, queued_count: 0, completed_count: 0, collected_count: 0,
            completed_results: [], task_results: [] });
        return x.response({ completed_count: count });
    });
    x.starts = () => x.calls.filter(request => request.url.endsWith('/start'));
    x.progress = () => x.h.craftPipelineProgress('feed', x.h.configuredCraftSteps('feed')).done[0];
    x.step = async () => {
        x.h.runtime.actionCount = 0;
        x.h.reconcileCraftFlights(x.h.runtime.state);
        await x.h.startEmptyIndustries();
    };
    x.collect = async () => {
        for (const node of x.backend.crafting_stations) if (!node.empty) {
            Object.assign(node, { ready: true, completed_count: node.queue_total, queued_count: 0, task_snapshot: null });
        }
        x.sync(); x.h.runtime.actionCount = 0;
        await x.h.collectReadyIndustries();
        x.h.reconcileCraftFlights(x.h.runtime.state);
    };
    return x;
}
function flatten(row) { return row ? [row, ...(row.children || []).flatMap(flatten)] : []; }

for (const alias of aliases) {
    test(`${alias}: a nutrition → fine → grain → wheat chain executes each level and credits only the root`, async () => {
        const x = setup(alias);
        const tree = x.tree();
        assert.deepEqual(flatten(tree.root).filter(row => row.kind === 'recipe').map(row => row.name),
            ['营养饲料', '精饲料', '谷物饲料']);
        assert.equal(x.calls.length, 0, 'display must not submit anything');
        for (const recipeId of ['make-grain', 'make-fine', 'make-nutrition']) {
            await x.step();
            assert.equal(x.starts().at(-1).payload.recipe_id, recipeId);
            assert.equal(x.starts().at(-1).payload.quantity, 1);
            assert.equal(x.progress(), 0);
            await x.collect();
        }
        await x.step();
        assert.equal(x.starts().length, 3);
        assert.equal(x.progress(), 1);
        assert.equal(x.backend.inventory.find(row => row.item_id === 'nutrition_feed').quantity, 1);
        assert.equal(x.backend.inventory.find(row => row.item_id === 'wheat').quantity, 0);
    });

    test(`${alias}: pending grain output satisfies a deeper branch without a duplicate queue`, async () => {
        const x = setup(alias, { pending: true });
        const material = flatten(x.tree().root).find(row => row.kind === 'material' && row.name === '谷物饲料');
        assert.ok(material);
        assert.equal(material.pending, 3);
        assert.equal(material.missing, 0);
        await x.step();
        assert.equal(x.calls.length, 0, 'wait for the existing grain queue');
        await x.collect(); await x.step();
        assert.deepEqual(x.starts().map(request => request.payload.recipe_id), ['make-fine']);
        assert.equal(x.progress(), 0);
        await x.collect(); await x.step();
        assert.deepEqual(x.starts().map(request => request.payload.recipe_id), ['make-fine', 'make-nutrition']);
    });
}

test('legacy output IDs retain priority over the new explicit aliases', () => {
    const { audit } = outputHarness(fixture());
    const row = { item_id: 'original-top', item: { item_id: 'original-item', id: 'new-item' },
        produce: { item_id: 'original-produce', id: 'new-produce' },
        produce_item_id: 'new-produce-top', output_item_id: 'new-output-top', produce_quantity: 2 };
    for (const [expected, remove] of [['original-top', () => delete row.item_id],
        ['original-item', () => delete row.item.item_id], ['original-produce', () => delete row.produce.item_id]]) {
        assert.equal(audit.craftRecipeOutput(row).id, expected);
        remove();
    }
    assert.equal(audit.craftRecipeOutput(row).id, 'new-produce-top');
});

test('recognized output ID remains available to diagnostics when its quantity cannot be guaranteed', () => {
    const { audit } = outputHarness(fixture());
    assert.equal(audit.craftRecipeOutputId({ item: { id: 'fine_feed', name: '精饲料' } }), 'fine_feed');
    assert.equal(audit.craftRecipeOutput({ item: { id: 'fine_feed', name: '精饲料' } }), null);
    assert.equal(audit.craftRecipeOutputId(null), null);
});

test('a recipe ID or matching name never substitutes for a missing output ID', async () => {
    const x = setup('item.id', { modify(state, jobs) {
        delete jobs[1].item.id;
        jobs[1].id = 'fine_feed';
    } });
    assert.equal(x.audit.craftRecipeOutputId(x.backend.crafting_stations[0].recipes[1]), null);
    await x.step();
    assert.equal(x.calls.length, 0);
    assert.equal(x.tree().status, 'blocked');
});

test('missing or invalid intermediate quantities block the chain before any sibling is submitted', async () => {
    for (const quantity of [undefined, null, '', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const x = setup('item.id', { modify(state, jobs) { jobs[1].produce_quantity = quantity; } });
        await x.step();
        assert.equal(x.calls.length, 0, `quantity ${quantity} cannot authorize production`);
        assert.equal(x.tree().status, 'blocked');
    }
});

test('a valid explicit fallback quantity and a conservative minimum remain supported', () => {
    const { audit } = outputHarness(fixture());
    assert.equal(audit.craftRecipeOutput({ item: { id: 'fine_feed' }, output_quantity: 2 }).quantity, 2);
    assert.equal(audit.craftRecipeOutput({ produce_item_id: 'fine_feed', produce_quantity: 4, yield_min: 2 }).quantity, 2);
});

test('random outputs never authorize recursive crafting even alongside a valid explicit output alias', async () => {
    const x = setup('item.id', { modify(state, jobs) {
        jobs[1].outputs = [{ item_id: 'fine_feed', quantity: 2, weight: 1 }, { item_id: 'wheat', quantity: 1, weight: 1 }];
    } });
    assert.equal(x.audit.craftRecipeOutput(x.backend.crafting_stations[0].recipes[1]), null);
    await x.step();
    assert.equal(x.calls.length, 0);
    assert.equal(x.tree().status, 'blocked');
});

test('an in-flight recipe without a guaranteed quantity cannot conceal a missing deeper material', async () => {
    const x = setup('output_item_id', { pending: true, modify(state, jobs) { delete jobs[2].produce_quantity; } });
    const material = flatten(x.tree().root).find(row => row.kind === 'material' && row.name === '谷物饲料');
    assert.ok(material);
    assert.equal(material.pending, 0);
    assert.equal(material.missing, 3);
    await x.step();
    assert.equal(x.calls.length, 0);
    assert.equal(x.tree().status, 'blocked');
});

test('random in-flight output is never counted as guaranteed deeper material', async () => {
    const x = setup('produce.id', { pending: true, modify(state, jobs) {
        jobs[2].outputs = [{ item_id: 'grain_feed', weight: 1 }, { item_id: 'wheat', weight: 1 }];
    } });
    const material = flatten(x.tree().root).find(row => row.kind === 'material' && row.name === '谷物饲料');
    assert.ok(material);
    assert.equal(material.pending, 0);
    assert.equal(material.missing, 3);
    await x.step();
    assert.equal(x.calls.length, 0);
});
