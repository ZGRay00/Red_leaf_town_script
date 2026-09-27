const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { harness, fixture, sourcePath } = require('./red-leaf-town-v4.test.cjs');

// Keep audit-only exposure here; the production userscript and shared harness need no test hooks.
function auditHarness(state = fixture()) {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (filename, ...args) {
        const source = originalRead.call(this, filename, ...args);
        return filename === sourcePath ? source.replace('if (CONFIG.ui.autoStart) start();',
            'window.__partnerAudit = { optimizePartnerAssignments }; if (CONFIG.ui.autoStart) start();') : source;
    };
    try {
        const x = harness(state);
        x.optimize = () => x.context.window.__partnerAudit.optimizePartnerAssignments();
        return x;
    } finally { fs.readFileSync = originalRead; }
}

function partner(id, siteId = null, industries = ['gathering']) {
    return { partner_id: id, name: id, assigned_gathering_site_id: siteId,
        tendencies: industries.map(industry => ({ industry, effective_ability: 100 })) };
}
function site(id, difficulty, partnerId = null) {
    return { site_id: id, empty: true, assigned_partner_ids: partnerId ? [partnerId] : [],
        available_tasks: [{ id: `${id}-task`, difficulty }] };
}
function partnerCase({ capacity = 1, sites, partners, allowSwap = false }) {
    const state = fixture();
    state.gathering_sites = sites;
    state.partners = partners;
    state.industry_rules.gathering.partner_capacity = capacity;
    state.crafting_stations = [];
    const x = auditHarness(state);
    x.h.CONFIG.partnerAutoSwap = allowSwap;
    x.setResponder(request => {
        const match = request.url.match(/\/gathering\/sites\/([^/]+)\/partner$/);
        assert.ok(match, request.url);
        const node = x.backend.gathering_sites.find(row => row.site_id === match[1]);
        const oldPartner = x.backend.partners.find(row => row.assigned_gathering_site_id === node.site_id);
        if (oldPartner) oldPartner.assigned_gathering_site_id = null;
        const next = request.payload.partner_id;
        node.assigned_partner_ids = next ? [next] : [];
        if (next) x.backend.partners.find(row => row.partner_id === next).assigned_gathering_site_id = node.site_id;
        return x.response();
    });
    return x;
}

test('no-swap keeps an incumbent on a lower-priority site when capacity is full', async () => {
    const x = partnerCase({ sites: [site('easy', 1, 'p1'), site('hard', 100)], partners: [partner('p1', 'easy')] });
    await x.optimize();
    assert.equal(x.calls.length, 0);
    assert.deepEqual(x.backend.gathering_sites[0].assigned_partner_ids, ['p1']);
});

test('no-swap counts retained incumbents before filling remaining capacity with idle partners', async () => {
    const x = partnerCase({ capacity: 2, sites: [site('easy', 1, 'p1'), site('hard', 100)], partners: [partner('p1', 'easy'), partner('p2')] });
    await x.optimize();
    assert.deepEqual(x.calls.map(row => [row.url, row.payload.partner_id]), [['/api/red-leaf-town/gathering/sites/hard/partner', 'p2']]);
});

test('no-swap preserves existing over-capacity assignments and does not fill an extra site', async () => {
    const x = partnerCase({ capacity: 1, sites: [site('first', 1, 'p1'), site('second', 2, 'p2'), site('hard', 100)], partners: [partner('p1', 'first'), partner('p2', 'second'), partner('p3')] });
    await x.optimize();
    assert.equal(x.calls.length, 0);
});

test('a missing incumbent still occupies capacity under no-swap and is not silently released', async () => {
    const x = partnerCase({ sites: [site('easy', 1, 'missing'), site('hard', 100)], partners: [partner('idle')] });
    await x.optimize();
    assert.equal(x.calls.length, 0);
});

test('no-swap preserves an incumbent marked missing in the partner roster', async () => {
    const missing = partner('p1', 'easy'); missing.missing = true;
    const x = partnerCase({ sites: [site('easy', 1, 'p1'), site('hard', 100)], partners: [missing, partner('p2')] });
    await x.optimize();
    assert.equal(x.calls.length, 0);
});

test('explicit close-and-release can move the released partner even when automatic swapping is off', async () => {
    const x = partnerCase({ sites: [site('easy', 1, 'p1'), site('hard', 100)], partners: [partner('p1', 'easy')] });
    x.h.setOverride('rlt-node-job:gathering:easy', '__off');
    await x.optimize();
    assert.deepEqual(x.calls.map(row => [row.url, row.payload.partner_id]), [
        ['/api/red-leaf-town/gathering/sites/easy/partner', ''],
        ['/api/red-leaf-town/gathering/sites/hard/partner', 'p1'],
    ]);
});

test('enabled automatic swapping can move an incumbent to the higher-priority site', async () => {
    const x = partnerCase({ allowSwap: true, sites: [site('easy', 1, 'p1'), site('hard', 100)], partners: [partner('p1', 'easy')] });
    await x.optimize();
    assert.deepEqual(x.calls.map(row => row.payload.partner_id), ['', 'p1']);
});

test('no-swap does not give an incumbent to a different industry', async () => {
    const x = partnerCase({ sites: [site('easy', 1, 'p1')], partners: [partner('p1', 'easy', ['gathering', 'mining'])] });
    x.backend.mining_sites = [site('mine', 100)]; x.sync();
    await x.optimize();
    assert.equal(x.calls.length, 0);
});

for (const setting of ['partnerAutoSwap', 'gathering.autoAssignPartner']) {
    test(`changing ${setting} while releasing a partner aborts subsequent writes from the old plan`, async () => {
        const x = partnerCase({ allowSwap: true, sites: [site('easy', 1, 'p1'), site('hard', 100)], partners: [partner('p1', 'easy')] });
        x.setResponder(request => {
            assert.equal(request.payload.partner_id, '');
            x.h.setSetting(setting, false);
            x.backend.gathering_sites[0].assigned_partner_ids = [];
            x.backend.partners[0].assigned_gathering_site_id = null;
            return x.response();
        });
        await x.optimize();
        assert.equal(x.calls.length, 1);
        assert.equal(x.backend.gathering_sites[1].assigned_partner_ids.length, 0);
    });
}

function taskItemCase({ pipeline = false, choice = 'required-item', items = [], partial = false, useItems = true }) {
    const state = fixture(); state.task_items = items;
    const x = auditHarness(state);
    x.h.CONFIG.crafting.partialTaskItems = partial;
    x.h.CONFIG.crafting.useTaskItems = useItems;
    if (pipeline) {
        x.h.setOverride('rlt-craft-pipe:mill', JSON.stringify([{ recipeId: 'flour', times: 1, taskItemId: choice }]));
    } else {
        x.h.setOverride('rlt-node-job:crafting:mill', 'flour');
        x.h.setOverride('rlt-craft-lock-times:mill', '1');
        x.h.setOverride('rlt-node-task-item:crafting:mill', choice);
    }
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    x.setResponder(request => {
        assert.ok(request.url.endsWith('/start'));
        const node = x.backend.crafting_stations[0];
        Object.assign(node, { empty: false, recipe: node.recipes[0], queue_total: request.payload.quantity,
            queued_count: request.payload.quantity - 1, task_snapshot: { recipe_id: 'flour', ready_at: x.backend.server_time + 60 } });
        return x.response();
    });
    return x;
}

for (const pipeline of [false, true]) {
    test(`strict task-item mode blocks a vanished explicit ${pipeline ? 'pipeline' : 'station'} selection`, async () => {
        const x = taskItemCase({ pipeline });
        await x.h.startEmptyIndustries();
        assert.equal(x.calls.length, 0);
    });
}

test('strict task-item mode still blocks a known but exhausted start item', async () => {
    const x = taskItemCase({ items: [{ id: 'required-item', timing: 'start', quantity: 0 }] });
    await x.h.startEmptyIndustries(); assert.equal(x.calls.length, 0);
});

test('strict task-item mode uses an available start item', async () => {
    const x = taskItemCase({ items: [{ id: 'required-item', timing: 'start', quantity: 1 }] });
    await x.h.startEmptyIndustries(); assert.equal(x.calls[0].payload.task_item_id, 'required-item');
});

test('explicit no-item choice is allowed in strict mode', async () => {
    const x = taskItemCase({ pipeline: true, choice: '__off' });
    await x.h.startEmptyIndustries(); assert.equal(x.calls[0].payload.task_item_id, '');
});

test('partial task-item mode can continue when the selected item disappears', async () => {
    const x = taskItemCase({ partial: true });
    await x.h.startEmptyIndustries(); assert.equal(x.calls[0].payload.task_item_id, '');
});

test('turning off task-item usage permits a previously configured missing item', async () => {
    const x = taskItemCase({ useItems: false });
    await x.h.startEmptyIndustries(); assert.equal(x.calls[0].payload.task_item_id, '');
});

test('known active-timing items are not mistakenly required at queue submission', async () => {
    const x = taskItemCase({ items: [{ id: 'required-item', timing: 'active', quantity: 0 }] });
    await x.h.startEmptyIndustries(); assert.equal(x.calls[0].payload.task_item_id, '');
});

function descendants(node) {
    return [node, ...(node.children || []).flatMap(descendants)];
}
for (const controlKind of ['pipeline', 'recipe', 'limit']) {
    for (const blocker of ['flight', 'task', 'snapshot']) {
        test(`a focused ${controlKind} editor rejects changes after a ${blocker} appears and restores the saved value`, () => {
            const x = auditHarness();
            const pipeline = JSON.stringify([{ recipeId: 'flour', times: 1, taskItemId: '' }]);
            if (controlKind === 'pipeline') x.h.setOverride('rlt-craft-pipe:mill', pipeline);
            else {
                x.h.setOverride('rlt-node-job:crafting:mill', 'flour');
                x.h.setOverride('rlt-craft-lock-times:mill', '1');
            }
            x.h.tabBar.children.find(button => button.dataset.page === 'crafting').onclick();
            const findControl = () => descendants(x.h.configBox).find(node => controlKind === 'recipe'
                ? node.tagName === 'SELECT'
                : node.tagName === 'INPUT' && !node.hidden && (controlKind === 'pipeline' ? /本步骤|该步累计/.test(node.title) : node.type === 'number'));
            const control = findControl(), savedValue = control.value;
            assert.equal(control.disabled, false);
            x.context.document.activeElement = control;
            control.blur = () => { x.context.document.activeElement = null; };
            if (blocker === 'flight') x.h.saveCraftFlight('mill', {
                phase: 'submitting', recipeId: 'flour', quantity: 1, credited: 0, observedCollected: 0, steps: [], stepIndex: 0,
            });
            else {
                const node = x.backend.crafting_stations[0];
                if (blocker === 'task') node.empty = false;
                else node.task_snapshot = { recipe_id: 'flour', ready_at: x.backend.server_time + 60 };
                x.sync();
            }
            x.h.refreshConfigRows(x.h.runtime.state);
            assert.equal(x.h.configBox.contains(control), true, 'a focused editor remains present while state updates');
            control.value = controlKind === 'recipe' ? '__off' : '20';
            control.onchange();
            const storageKey = controlKind === 'pipeline' ? 'rlt-craft-pipe:mill' : controlKind === 'recipe' ? 'rlt-node-job:crafting:mill' : 'rlt-craft-lock-times:mill';
            assert.equal(x.h.getOverride(storageKey), controlKind === 'pipeline' ? pipeline : savedValue);
            assert.equal(x.h.configBox.contains(control), false, 'the rejected edit is replaced with an authoritative control');
            assert.equal(findControl().value, savedValue);
            assert.equal(findControl().disabled, true);
            x.h.stop();
        });
    }
}
