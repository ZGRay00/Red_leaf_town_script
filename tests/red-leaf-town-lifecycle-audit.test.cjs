const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, harness } = require('./red-leaf-town-v4.test.cjs');

function plan(x) {
    const node = x.h.runtime.state.crafting_stations[0];
    x.h.setOverride('rlt-node-job:crafting:mill', 'flour');
    x.h.setOverride('rlt-craft-lock-times:mill', '1');
    assert.equal(x.h.startCraftRun(x.h.runtime.state, 'mill'), true);
    return { id: 'mill', node, job: node.recipes[0], runId: x.h.craftRun('mill').id,
        pipeline: { steps: x.h.configuredCraftSteps('mill'), stepIndex: 0, done: [0] } };
}
function story(x) {
    return x.context.document.querySelector().__vue_app__._context.config.globalProperties.$pinia._s.get('story');
}

test('craft preflight guards do not leave a phantom uncertain queue', async () => {
    for (const guard of ['limit', 'story', 'stopped', 'build', 'bridge']) {
        const x = harness();
        if (guard === 'limit') x.h.runtime.actionCount = x.h.CONFIG.maxActionsPerTick;
        if (guard === 'story') story(x).active = true;
        if (guard === 'stopped') x.h.setRunning(false);
        if (guard === 'build') x.h.CONFIG.expectedBuild = 'index-other.js';
        if (guard === 'bridge') story(x).cue = null;
        await assert.rejects(x.h.startCraftPlan(plan(x)), error => error.writeNotSent === true);
        assert.equal(x.calls.length, 0, guard);
        assert.equal(x.h.craftFlight('mill'), null, guard);
    }
});

test('preflight state synchronization failure cannot claim that a start was sent', async () => {
    const x = harness(); x.h.runtime.stateUncertain = true;
    x.setResponder(req => { assert.equal(req.method, 'GET'); throw new Error('offline'); });
    await assert.rejects(x.h.startCraftPlan(plan(x)), error => error.writeNotSent === true);
    assert.equal(x.calls.length, 1);
    assert.equal(x.h.craftFlight('mill'), null);
});

test('collection and cancellation guards preserve the existing confirmed queue', async () => {
    for (const action of ['collect', 'cancel']) {
        const x = harness(), node = x.h.runtime.state.crafting_stations[0];
        Object.assign(node, { empty: false, completed_count: 1, queued_count: 1, recipe: node.recipes[0], task_snapshot: { ready_at: 123, recipe_id: 'flour' } });
        x.h.saveCraftFlight('mill', { phase: 'active', quantity: 3, credited: 0, observedCollected: 0, recipeId: 'flour', steps: [] });
        x.h.runtime.actionCount = x.h.CONFIG.maxActionsPerTick;
        x.h.runtime.cancelCraft = { id: 'mill', recipeId: 'flour', readyAt: 123 };
        await assert.rejects(action === 'collect' ? x.h.collectReadyIndustries() : x.h.processCraftCancel());
        assert.equal(x.h.craftFlight('mill').phase, 'active');
        assert.equal(x.calls.length, 0);
    }
});

test('successful write followed by a story bridge exception retains its queue journal', async () => {
    const x = harness();
    story(x).cue = () => { throw new Error('story callback failed'); };
    x.setResponder(() => x.response());
    await assert.rejects(x.h.startCraftPlan(plan(x)), error => error.writeResponseReceived === true && error.code === 'invalid_story_bridge');
    assert.equal(x.calls.length, 1);
    assert.equal(x.h.craftFlight('mill').phase, 'uncertain');
});

test('sailing blocked by a story can depart after the story finishes without manual repair', async () => {
    const x = harness();
    Object.assign(x.h.CONFIG.sailing, { enabled: true, autoStart: true, routeId: 'reed_bay' });
    x.h.runtime.state.partners = [{ partner_id: 'p1' }];
    story(x).active = true;
    await assert.rejects(x.h.doSailing(), error => error.code === 'story_active');
    assert.equal(x.calls.length, 0);
    assert.equal(x.h.getOverride('rlt-sailing-intent'), null);
    story(x).active = false; x.h.runtime.storyWasBusy = false;
    x.setResponder(req => { assert.ok(req.url.endsWith('/sailing/start')); return x.response(); });
    await x.h.doSailing();
    assert.equal(x.calls.length, 1);
});

test('inventory consumers require portal protection data even when farming and commissions are off', () => {
    for (const enabled of ['feed', 'crafting', 'sailing']) {
        const x = harness();
        for (const name of ['farming', 'gathering', 'mining', 'crafting', 'aquatic', 'livestock', 'commissions', 'feed', 'sailing']) x.h.CONFIG[name].enabled = false;
        x.h.CONFIG[enabled].enabled = true;
        if (enabled === 'sailing') x.h.CONFIG.sailing.autoStart = true;
        const state = fixture(); delete state.portals;
        assert.throws(() => x.h.acceptState(state), error => error.code === 'invalid_state' && error.message.includes('portals'));
    }
});

test('turning sailing off while collecting prevents immediate departure', async () => {
    const state = fixture();
    state.partners = [{ partner_id: 'p1' }];
    state.sailing.active_run = { run_id: 'old', ready_at: 1, partner_ids: ['p1'] };
    const x = harness(state);
    Object.assign(x.h.CONFIG.sailing, { enabled: true, autoStart: true, routeId: 'reed_bay' });
    x.setResponder(req => {
        assert.ok(req.url.endsWith('/sailing/collect'));
        x.backend.sailing.active_run = null; x.h.CONFIG.sailing.enabled = false;
        return x.response();
    });
    await x.h.doSailing();
    assert.equal(x.calls.length, 1);
});

test('turning off industry collection during a request stops collecting remaining stations', async () => {
    for (const toggle of ['enabled', 'autoCollect']) {
        const state = fixture();
        state.crafting_stations[0].empty = false; state.crafting_stations[0].completed_count = 1;
        state.crafting_stations.push({ ...state.crafting_stations[0], station_id: 'mill2' });
        const x = harness(state);
        x.setResponder(req => {
            assert.ok(req.url.endsWith('/stations/mill/collect'));
            x.h.CONFIG.crafting[toggle] = false;
            return x.response({ completed_count: 1 });
        });
        await x.h.collectReadyIndustries();
        assert.equal(x.calls.length, 1);
    }
});
