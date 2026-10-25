const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

// Exposure and optional baseline loading stay local to this suite. In particular,
// the shared harness's pending concurrent-action work is neither edited nor reset.
const shared = fs.readFileSync(path.join(__dirname, 'red-leaf-town-v4.test.cjs'), 'utf8');
const boundary = shared.indexOf('async function run()');
assert.ok(boundary > 0, 'shared harness prefix is available');
const harnessSource = shared.slice(0, boundary)
    .replace('doAquaticFeed, doSailing,', 'optimizePartnerAssignments, doAquaticFeed, doSailing,')
    .replace("let source = fs.readFileSync(sourcePath, 'utf8');", "let source = options.scriptSource ?? fs.readFileSync(sourcePath, 'utf8');");
const { harness, fixture } = new Function('require', '__dirname', `${harnessSource}\nreturn { harness, fixture };`)(require, __dirname);
let baselineSource;
function baseline() {
    baselineSource ??= execFileSync('git', ['show', 'df13a10:红叶镇物语自动助手.user.js'], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    return baselineSource;
}

const assignmentFields = {
    farming: 'assigned_plot_slot', gathering: 'assigned_gathering_site_id',
    mining: 'assigned_mining_site_id', crafting: 'assigned_crafting_station_id',
};
const stateKeys = { gathering: 'gathering_sites', mining: 'mining_sites', crafting: 'crafting_stations' };
function partner(id, { industry = 'gathering', siteId = null, industries = ['gathering'], ability = 100, ...extra } = {}) {
    return { partner_id: id, name: id, [assignmentFields[industry]]: siteId,
        tendencies: industries.map(industry => ({ industry, effective_ability: ability })), ...extra };
}
function site(id, { partnerId = null, difficulty = 10, tasks = true, ...extra } = {}) {
    return { site_id: id, definition: { name: id }, empty: true, ready: false, task_snapshot: null,
        assigned_partner_ids: partnerId ? [partnerId] : [], assigned_partners: [],
        available_tasks: tasks ? [{ id: `${id}-task`, name: `${id}-task`, duration_seconds: 60,
            stamina_cost: 1, time_difficulty: difficulty, item: { item_id: `${id}-drop`, sell_price: 1 } }] : [], ...extra };
}
// service.py: closed event sites remain serialized while a task or assigned
// partner remains. Collect permits closed sites but retains their assignments;
// assigning an empty partner is permitted after closure, new assignments are not.
function eventSite(options = {}) {
    return site('event', { difficulty: 100, event_closed: false, ...options });
}
function closedEvent(options = {}) {
    return eventSite({ event_closed: true, tasks: false, ...options });
}
function failure(message, code = 'business_error', status = 400) {
    return { ok: false, status, headers: { get: () => null }, json: async () => ({ message, code }) };
}
function setup({ gathering = [], mining = [], partners = [], capacity = 1, miningCapacity = 1, swap = true,
    entries = [], scriptSource, disabled = [] } = {}) {
    const state = fixture();
    state.gathering_sites = gathering; state.mining_sites = mining; state.partners = partners;
    state.crafting_stations = [];
    state.industry_rules.gathering.partner_capacity = capacity;
    state.industry_rules.mining.partner_capacity = miningCapacity;
    const x = harness(state, entries, { scriptSource });
    x.h.CONFIG.partnerAutoSwap = swap;
    for (const industry of ['farming', 'crafting', 'aquatic', 'livestock', 'sailing', ...disabled]) x.h.CONFIG[industry].enabled = false;
    x.h.CONFIG.gathering.autoStart = false; x.h.CONFIG.mining.autoStart = false;
    let before = () => null, after = () => {};
    x.before = callback => { before = callback; }; x.after = callback => { after = callback; };
    x.businessErrors = [];
    const reject = message => { x.businessErrors.push(message); return failure(message); };
    x.setResponder(async request => {
        const override = await before(request); if (override) return override;
        if (request.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) };
        const match = request.url.match(/\/(gathering|mining)\/sites\/([^/]+)\/(partner|collect|start)$/);
        assert.ok(match, `unexpected request: ${request.method} ${request.url}`);
        const [, industry, id, action] = match, node = x.backend[stateKeys[industry]].find(row => row.site_id === id);
        if (!node) return reject('site missing');
        if (action === 'start') {
            assert.equal(request.method, 'POST');
            if (node.event_closed) return reject('event site closed');
            if (!node.empty || node.task_snapshot) return reject('task already active');
            if (industry === 'gathering' && !node.assigned_partner_ids.length) return reject('gathering requires a partner');
            const job = node.available_tasks.find(row => row.id === request.payload.task_id);
            if (!job) return reject('task unavailable');
            Object.assign(node, { empty: false, ready: false, assignment_locked: true, task: job,
                task_snapshot: { task_id: job.id, ready_at: x.backend.server_time + job.duration_seconds } });
        } else if (action === 'collect') {
            if (node.empty || !node.ready) return reject('task not ready');
            Object.assign(node, { empty: true, ready: false, task_snapshot: null, assignment_locked: false });
        } else {
            assert.equal(request.method, 'PUT');
            // The mock enforces the assistant's conservative policy: do not
            // move a partner until collection and explicit release. The real
            // service can release ready tasks or implicitly transfer an
            // unlocked partner from an old slot, so these guards deliberately
            // reject more writes than the server instead of claiming its rules.
            if (!node.empty || node.task_snapshot || node.assignment_locked) return reject('assignment locked by task');
            const id = request.payload.partner_id, field = assignmentFields[industry];
            if (id) {
                if (node.event_closed) return reject('event site closed');
                const chosen = x.backend.partners.find(row => row.partner_id === id);
                if (!chosen || chosen.missing || chosen.locked || !chosen.tendencies.some(row => row.industry === industry)) return reject('partner unavailable');
                if (Object.values(assignmentFields).some(field => chosen[field] != null)) return reject('partner already assigned');
                const occupied = x.backend.partners.filter(row => row[field] != null).length;
                if (!node.assigned_partner_ids.length && occupied >= x.backend.industry_rules[industry].partner_capacity) return reject('partner capacity reached');
            }
            for (const previous of x.backend.partners.filter(row => row[field] === node.site_id)) previous[field] = null;
            node.assigned_partner_ids = id ? [id] : []; node.assigned_partners = [];
            if (id) x.backend.partners.find(row => row.partner_id === id)[field] = node.site_id;
        }
        if (node.event_closed && !node.task_snapshot && !node.assigned_partner_ids.length) {
            x.backend[stateKeys[industry]] = x.backend[stateKeys[industry]].filter(row => row !== node);
        }
        await after(request); return x.response();
    });
    x.assignments = () => x.calls.filter(row => row.url.endsWith('/partner'));
    x.collects = () => x.calls.filter(row => row.url.endsWith('/collect'));
    x.starts = () => x.calls.filter(row => row.url.endsWith('/start'));
    x.actions = () => x.assignments().map(row => [row.url.split('/').slice(-3, -1).join('/'), row.payload.partner_id]);
    x.optimize = () => { x.h.runtime.actionCount = 0; return x.h.optimizePartnerAssignments(); };
    x.log = () => x.h.logBox.children.map(row => row.textContent).join('\n');
    return x;
}
async function settleReplan(x) {
    try { await x.optimize(); }
    catch (error) { assert.ok(['aborted', 'partner_replan'].includes(error.code), `unexpected planner error: ${error.code}`); }
}

test('an in-progress gathering task keeps its partner and consumes its capacity', async () => {
    const busy = site('active-task', { partnerId: 'p1', empty: false, assignment_locked: true,
        task_snapshot: { ready_at: Math.floor(Date.now() / 1000) + 60 } });
    const x = setup({ gathering: [busy, site('ordinary')], partners: [partner('p1', { siteId: 'active-task' }), partner('p2')] });
    await x.optimize(); assert.equal(x.calls.length, 0); assert.deepEqual(x.backend.gathering_sites[0].assigned_partner_ids, ['p1']);
});

test('an uncollected ready task is not treated as an idle assignment slot', async () => {
    const ready = site('ready-task', { partnerId: 'p1', empty: false, ready: true,
        task_snapshot: { ready_at: Math.floor(Date.now() / 1000) - 1 } });
    const x = setup({ gathering: [ready, site('ordinary')], partners: [partner('p1', { siteId: 'ready-task' })] });
    x.h.CONFIG.gathering.autoCollect = false;
    await x.h.collectReadyIndustries(); await x.optimize(); assert.equal(x.calls.length, 0);
});

test('the offline backend rejects illegal partner assignment and premature collection without mutating state', async () => {
    const x = setup({ gathering: [site('busy', { partnerId: 'p1', empty: false,
        task_snapshot: { ready_at: Math.floor(Date.now() / 1000) + 60 } }), site('ordinary')],
        partners: [partner('p1', { siteId: 'busy' })] });
    const before = structuredClone(x.backend);
    const request = (suffix, method = 'PUT', payload = { partner_id: 'p1' }) => x.context.fetch(`/api/red-leaf-town/gathering/sites/${suffix}`, {
        method, body: JSON.stringify(payload),
    });
    assert.equal((await request('busy/partner')).status, 400);
    assert.equal((await request('ordinary/partner')).status, 400);
    assert.equal((await request('busy/collect', 'POST', {})).status, 400);
    assert.deepEqual(x.backend, before); assert.equal(x.businessErrors.length, 3);
});

test('v5.2.6 baseline retains a partner at a closed idle event when swapping is disabled', async () => {
    const x = setup({ scriptSource: baseline(), swap: false, gathering: [closedEvent({ partnerId: 'p1' }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    await x.optimize(); assert.equal(x.calls.length, 0);
    assert.deepEqual(x.backend.gathering_sites[0].assigned_partner_ids, ['p1']);
    assert.deepEqual(x.backend.gathering_sites[1].assigned_partner_ids, []);
});

test('v5.2.6 swapping baseline still submits an obsolete assignment after synchronization closes the event', async () => {
    const x = setup({ scriptSource: baseline(), swap: true, gathering: [eventSite()], partners: [partner('p1')] });
    x.h.runtime.stateUncertain = true;
    x.before(request => { if (request.method === 'GET') x.backend.gathering_sites = []; });
    await x.optimize(); assert.equal(x.assignments().length, 1);
    assert.deepEqual(x.businessErrors, ['site missing']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, null);
});

for (const swap of [false, true]) {
    test(`a closed idle event releases its partner for an ordinary site with swapping ${swap ? 'on' : 'off'}`, async () => {
        const x = setup({ swap, gathering: [closedEvent({ partnerId: 'p1' }), site('ordinary')],
            partners: [partner('p1', { siteId: 'event' })] });
        await x.optimize();
        assert.deepEqual(x.assignments().map(row => [row.url.split('/').at(-2), row.payload.partner_id]), [['event', ''], ['ordinary', 'p1']]);
        assert.equal(x.backend.gathering_sites.some(row => row.site_id === 'event'), false);
        assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'ordinary');
        assert.equal(x.businessErrors.length, 0);
        await x.optimize(); assert.equal(x.calls.length, 2, 'the second pass keeps the new stable assignment');
    });
}

test('the same event remains a valid preferred gathering site before it closes', async () => {
    const x = setup({ gathering: [eventSite(), site('ordinary')], partners: [partner('p1')] });
    await x.optimize(); assert.equal(x.assignments().length, 1);
    assert.equal(x.assignments()[0].url.split('/').at(-2), 'event');
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'event');
});

test('closure releases an idle partner even if no replacement work currently exists', async () => {
    const x = setup({ swap: false, gathering: [closedEvent({ partnerId: 'p1' })], partners: [partner('p1', { siteId: 'event' })] });
    await x.optimize(); assert.deepEqual(x.assignments().map(row => row.payload.partner_id), ['']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, null);
    await x.optimize(); assert.equal(x.calls.length, 1);
});

test('a stale closed empty row never receives a new idle partner or crowds out an ordinary site', async () => {
    const x = setup({ capacity: 2, gathering: [closedEvent(), site('ordinary')], partners: [partner('p1'), partner('p2')] });
    await x.optimize(); await x.optimize();
    assert.equal(x.assignments().length, 1); assert.equal(x.assignments()[0].url.split('/').at(-2), 'ordinary');
    assert.equal(x.businessErrors.length, 0);
});

test('closing an event does not release the partner of a task still in progress', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1', empty: false, assignment_locked: true,
        task_snapshot: { ready_at: Math.floor(Date.now() / 1000) + 60 } }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    await x.h.collectReadyIndustries(); await x.optimize(); assert.equal(x.calls.length, 0);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'event');
});

test('a closed ready event is collected first, then its retained partner is released and reassigned', async () => {
    const x = setup({ swap: false, gathering: [closedEvent({ partnerId: 'p1', empty: false, ready: true,
        task_snapshot: { ready_at: Math.floor(Date.now() / 1000) - 1 } }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    await x.optimize(); assert.equal(x.calls.length, 0);
    await x.h.collectReadyIndustries();
    assert.equal(x.collects().length, 1); assert.deepEqual(x.backend.gathering_sites[0].assigned_partner_ids, ['p1']);
    await x.optimize();
    assert.deepEqual(x.calls.map(row => row.url.split('/').at(-1)), ['collect', 'partner', 'partner']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'ordinary');
    assert.equal(x.businessErrors.length, 0);
});

test('disabled automatic collection leaves the closed ready task and its partner intact', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1', empty: false, ready: true,
        task_snapshot: { ready_at: Math.floor(Date.now() / 1000) - 1 } }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    x.h.CONFIG.gathering.autoCollect = false;
    await x.h.collectReadyIndustries(); await x.optimize(); assert.equal(x.calls.length, 0);
});

test('a remaining task snapshot protects its partner even if the empty flag is inconsistent', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1', task_snapshot: { ready_at: 1 } }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    await x.optimize(); assert.equal(x.calls.length, 0);
});

for (const swap of [false, true]) {
    test(`explicit close-and-keep overrides automatic event cleanup with swapping ${swap ? 'on' : 'off'}`, async () => {
        const x = setup({ swap, gathering: [closedEvent({ partnerId: 'p1' }), site('ordinary')],
            partners: [partner('p1', { siteId: 'event' }), partner('p2')] });
        x.h.setOverride('rlt-node-job:gathering:event', '__off_keep');
        await x.optimize(); assert.equal(x.calls.length, 0);
        assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'event');
    });
}

test('explicit close-and-release still releases an open event when swapping is disabled', async () => {
    const x = setup({ swap: false, gathering: [eventSite({ partnerId: 'p1' }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    x.h.setOverride('rlt-node-job:gathering:event', '__off');
    await x.optimize(); assert.deepEqual(x.assignments().map(row => row.payload.partner_id), ['', 'p1']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'ordinary');
});

for (const setting of ['gathering.enabled', 'gathering.autoAssignPartner']) {
    test(`disabling ${setting} does not authorize automatic cleanup of a closed event`, async () => {
        const x = setup({ gathering: [closedEvent({ partnerId: 'p1' }), site('ordinary')],
            partners: [partner('p1', { siteId: 'event' })] });
        x.h.setSetting(setting, false); await x.optimize(); assert.equal(x.calls.length, 0);
    });
}

test('an eligible partner can move from a closed gathering event into another enabled industry', async () => {
    const x = setup({ swap: false, gathering: [closedEvent({ partnerId: 'p1' })], mining: [site('mine')],
        partners: [partner('p1', { siteId: 'event', industries: ['gathering', 'mining'] })] });
    await x.optimize(); assert.deepEqual(x.assignments().map(row => row.payload.partner_id), ['', 'p1']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, null);
    assert.equal(x.backend.partners[0].assigned_mining_site_id, 'mine');
    assert.equal(x.businessErrors.length, 0);
});

test('event cleanup preserves the capacity occupied by unrelated active tasks', async () => {
    const busy = site('busy', { partnerId: 'p2', empty: false, assignment_locked: true,
        task_snapshot: { ready_at: Math.floor(Date.now() / 1000) + 60 } });
    const x = setup({ capacity: 2, gathering: [closedEvent({ partnerId: 'p1' }), busy, site('ordinary')],
        partners: [partner('p1', { siteId: 'event' }), partner('p2', { siteId: 'busy' }), partner('p3')] });
    await x.optimize(); assert.equal(x.backend.partners.filter(row => row.assigned_gathering_site_id != null).length, 2);
    assert.deepEqual(x.backend.gathering_sites.find(row => row.site_id === 'busy').assigned_partner_ids, ['p2']);
    assert.equal(x.businessErrors.length, 0); assert.equal(x.assignments().filter(row => row.payload.partner_id).length, 1);
});

test('an event with no remaining partners does not cause undefined partner requests', async () => {
    const x = setup({ gathering: [closedEvent(), site('ordinary')], partners: [] });
    await x.optimize(); await x.optimize(); assert.equal(x.calls.length, 0);
});

test('an event disappearing during mandatory pre-write synchronization receives no stale assignment', async () => {
    const x = setup({ gathering: [eventSite()], partners: [partner('p1')] });
    x.h.runtime.stateUncertain = true;
    x.before(request => { if (request.method === 'GET') x.backend.gathering_sites = []; });
    await settleReplan(x);
    assert.equal(x.calls.filter(row => row.method === 'GET').length, 1);
    assert.equal(x.assignments().length, 0); assert.equal(x.backend.partners[0].assigned_gathering_site_id, null);
});

test('switching to close-and-keep during pre-write synchronization prevents the planned cleanup', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1' }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    x.h.runtime.stateUncertain = true;
    x.before(request => { if (request.method === 'GET') x.h.setOverride('rlt-node-job:gathering:event', '__off_keep'); });
    await settleReplan(x); assert.equal(x.assignments().length, 0);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'event');
});

test('a destination closing while the old event releases its partner invalidates the remaining assignment', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1' }), eventSite({ site_id: 'next-event' })],
        partners: [partner('p1', { siteId: 'event' })] });
    x.after(request => {
        if (request.url.endsWith('/event/partner') && !request.payload.partner_id) {
            // Another player action assigned a different partner as the second
            // event closed, so the closed row remains visible in the real schema.
            const destination = x.backend.gathering_sites.find(row => row.site_id === 'next-event');
            Object.assign(destination, { event_closed: true, available_tasks: [], assigned_partner_ids: ['p2'] });
            x.backend.partners.push(partner('p2', { siteId: 'next-event' }));
        }
    });
    await settleReplan(x);
    assert.deepEqual(x.assignments().map(row => row.payload.partner_id), ['']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, null);
    assert.equal(x.backend.partners[1].assigned_gathering_site_id, 'next-event');
    assert.equal(x.businessErrors.length, 0);
});

test('cleanup does not release a replacement partner assigned while an earlier closed site is being cleared', async () => {
    const x = setup({ capacity: 2, gathering: [closedEvent({ partnerId: 'p1' }),
        closedEvent({ site_id: 'second-event', partnerId: 'p2' })], partners: [
        partner('p1', { siteId: 'event' }), partner('p2', { siteId: 'second-event' }), partner('p3'),
    ] });
    x.after(request => {
        if (request.url.endsWith('/event/partner') && !request.payload.partner_id) {
            const second = x.backend.gathering_sites.find(row => row.site_id === 'second-event');
            second.assigned_partner_ids = ['p3'];
            x.backend.partners.find(row => row.partner_id === 'p2').assigned_gathering_site_id = null;
            x.backend.partners.find(row => row.partner_id === 'p3').assigned_gathering_site_id = 'second-event';
        }
    });
    await settleReplan(x);
    assert.deepEqual(x.assignments().map(row => [row.url.split('/').at(-2), row.payload.partner_id]), [['event', '']]);
    assert.deepEqual(x.backend.gathering_sites.find(row => row.site_id === 'second-event').assigned_partner_ids, ['p3']);
    assert.equal(x.backend.partners.find(row => row.partner_id === 'p3').assigned_gathering_site_id, 'second-event');
    assert.equal(x.backend.partners.find(row => row.partner_id === 'p2').assigned_gathering_site_id, null);
    assert.equal(x.businessErrors.length, 0);
});

test('a partner becoming occupied during pre-write synchronization is not stolen by the old plan', async () => {
    const x = setup({ gathering: [eventSite(), site('ordinary')], partners: [partner('p1')] });
    x.h.runtime.stateUncertain = true;
    x.before(request => {
        if (request.method === 'GET') {
            x.backend.partners[0].assigned_gathering_site_id = 'ordinary';
            x.backend.gathering_sites.find(row => row.site_id === 'ordinary').assigned_partner_ids = ['p1'];
        }
    });
    await settleReplan(x); assert.equal(x.assignments().length, 0);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'ordinary');
});

for (const setting of ['partnerAutoSwap', 'gathering.autoAssignPartner']) {
    test(`changing ${setting} in the cleanup response stops the old plan before reassignment`, async () => {
        const x = setup({ gathering: [closedEvent({ partnerId: 'p1' }), site('ordinary')],
            partners: [partner('p1', { siteId: 'event' })] });
        x.after(request => { if (request.url.endsWith('/partner')) x.h.setSetting(setting, false); });
        await settleReplan(x); assert.deepEqual(x.assignments().map(row => row.payload.partner_id), ['']);
        assert.equal(x.backend.partners[0].assigned_gathering_site_id, null);
    });
}

test('a definite release rejection never triggers assignment of the still-occupied partner', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1' }), site('ordinary')],
        partners: [partner('p1', { siteId: 'event' })] });
    x.before(request => request.url.endsWith('/event/partner') ? failure('temporary release rejection') : null);
    await settleReplan(x); assert.deepEqual(x.assignments().map(row => row.payload.partner_id), ['']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'event');
    x.before(() => null); await x.optimize();
    assert.deepEqual(x.assignments().map(row => row.payload.partner_id), ['', '', 'p1']);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'ordinary');
    assert.equal(x.businessErrors.length, 0);
});

test('a rejected collection keeps the closed task and its partner protected for the next pass', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1', empty: false, ready: true,
        task_snapshot: { ready_at: 1 } }), site('ordinary')], partners: [partner('p1', { siteId: 'event' })] });
    x.before(request => request.url.endsWith('/collect') ? failure('temporary collection rejection') : null);
    await x.h.collectReadyIndustries(); await x.optimize();
    assert.equal(x.collects().length, 1); assert.equal(x.assignments().length, 0);
    assert.equal(x.backend.partners[0].assigned_gathering_site_id, 'event');
});

test('a closed gathering event cannot start even if a stale task catalogue is still present', async () => {
    const x = setup({ gathering: [closedEvent({ partnerId: 'p1', tasks: true })],
        partners: [partner('p1', { siteId: 'event' })] });
    x.h.CONFIG.gathering.autoStart = true;
    await x.h.startEmptyIndustries(); assert.equal(x.calls.length, 0);
    assert.equal(x.backend.gathering_sites[0].empty, true);
});

test('a gathering event closing during pre-start synchronization receives no obsolete start request', async () => {
    const x = setup({ gathering: [eventSite({ partnerId: 'p1' })], partners: [partner('p1', { siteId: 'event' })] });
    x.h.CONFIG.gathering.autoStart = true; x.h.runtime.stateUncertain = true;
    x.before(request => {
        if (request.method === 'GET') Object.assign(x.backend.gathering_sites[0], { event_closed: true, available_tasks: [] });
    });
    try { await x.h.startEmptyIndustries(); }
    catch (error) { assert.equal(error.code, 'aborted'); }
    assert.equal(x.calls.filter(row => row.method === 'GET').length, 1);
    assert.equal(x.starts().length, 0); assert.equal(x.backend.gathering_sites[0].empty, true);
});
