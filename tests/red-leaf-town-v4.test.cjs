const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const sourcePath = path.join(__dirname, '..', '红叶镇物语自动助手.user.js');
function fixture() {
    const now = Math.floor(Date.now() / 1000);
    return {
        server_time: now,
        player: { stamina: 150, stamina_cap: 100, stamina_restore_seconds: 60, stamina_updated_at: now, coins: 20000 },
        inventory: [{ item_id: 'wheat', name: '小麦', quality: 1, quantity: 100, sell_price: 2 }],
        plots: [], crops: [], gathering_sites: [], mining_sites: [], partners: [], task_items: [], portals: [], commissions: {},
        shop: [{ id: 'balanced-shop', item: { item_id: 'balanced', name: '均衡饲料' }, price: 5 }],
        crafting_stations: [{ station_id: 'mill', definition: { name: '风车磨坊' }, empty: true, ready: false, recipes: [
            { id: 'flour', name: '小麦粉', unlocked: true, stamina_cost: 2, duration_seconds: 60, produce_quantity: 1, item: { item_id: 'flour', name: '小麦粉', sell_price: 10 }, inputs: [{ item_id: 'wheat', item: { name: '小麦' }, quantity: 2 }] },
        ], assigned_partner_ids: [] }],
        industry_rules: { farming: {}, crafting: {}, gathering: {}, mining: {} },
        aquatic: { unlocked: true, spots: [], ponds: [], species: [], feed_slot: { capacity: 1000, units: 100, hourly_rate: 20, quality_score: 10, inputs: [] } },
        livestock: { unlocked: true, facilities: [] },
        sailing: { unlocked: true, ship_built: true, completed_voyages: 0, routes: [{ id: 'reed_bay', name: '芦苇湾', unlocked: true, coins: 20, stamina: 1, duration: 3600, required_voyages: 0 }], supplies: [{ id: 'none', name: '基础补给', quantity: 0 }], upgrades: [], collection: [] },
        exploration: { active_run: null },
    };
}
function element(tag = 'div') {
    const classes = new Set();
    const result = {
        tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], attrs: {}, value: '', scrollTop: 0,
        classList: { contains: c => classes.has(c), toggle(c, flag) { if (flag ?? !classes.has(c)) classes.add(c); else classes.delete(c); }, add: c => classes.add(c) },
        setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
        appendChild(x) { x.remove?.(); x.parent = this; this.children.push(x); return x; }, append(...xs) { xs.forEach(x => this.appendChild(x)); },
        prepend(x) { x.remove?.(); x.parent = this; this.children.unshift(x); }, remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } },
        replaceChildren(...xs) { for (const child of this.children) child.parent = null; this.children = []; this.append(...xs); }, addEventListener() {}, removeEventListener() {}, blur() {}, focus() {},
        contains(x) { return x === this || this.children.some(child => child.contains?.(x)); },
        getBoundingClientRect() { return { left: 0, top: 0 }; },
        querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === '[data-page]' && child.dataset?.page ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]); },
    };
    Object.defineProperty(result, 'innerHTML', { set() { this.children = []; }, get() { return ''; } });
    Object.defineProperty(result, 'lastChild', { get() { return this.children.at(-1); } });
    return result;
}
function harness(initial = fixture(), entries = []) {
    const storage = new Map(entries), calls = [];
    let backend = structuredClone(initial), responder;
    const story = { cue() {}, active: false, queue: [] }, game = { state: initial, refresh() {} };
    const app = { __vue_app__: { _context: { config: { globalProperties: { $pinia: { _s: new Map([['story', story], ['game', game]]) } } } } } };
    const context = {
        window: { addEventListener() {}, removeEventListener() {}, confirm: () => true },
        document: { body: element(), head: element(), activeElement: null, createElement: element, scripts: [{ src: 'https://chiyuki.diving-fish.com/red-leaf-town/assets/index-DCECfXs_.js' }], querySelector: () => app },
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
        navigator: {}, performance, AbortController, DOMException, crypto: webcrypto, console,
        setInterval() { return 1; }, clearInterval() {}, setTimeout, clearTimeout,
        fetch: async (url, options = {}) => {
            const request = { url, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : null };
            calls.push(request); if (!responder) throw new Error(`Unexpected network: ${url}`); return responder(request);
        },
    };
    const exposure = `window.__test = { CONFIG, runtime, setSetting, getOverride, setOverride, liveStamina, staminaWaitSeconds, nextDelay,
        doAquaticFeed, doSailing, balancedFeedInputs, feedThresholds, craftBatchSize, collectReadyIndustries, startEmptyIndustries,
        craftFlight, saveCraftFlight, craftPipelineProgress, creditCraftFlight, reconcileCraftFlights, startCraftPlan, configuredCraftSteps,
        craftingInputReserves, inFlightIndustryGuaranteedQty, isPartnerIdle, sailingPartners, processCraftCancel, acceptState, slotTaskItem, managedPartnerSlots,
        renderDashboard, refreshConfigRows, panel, dashboard, tabBar, configBox,
        start, stop, tick, sleep, wakeSoon,
        activity() { return { running, starting, busy, retryNotBefore }; },
        setRunning(value = true) { running = value; runtime.controller = value ? new AbortController() : null; } };`;
    let source = fs.readFileSync(sourcePath, 'utf8');
    assert.ok(source.includes('if (CONFIG.ui.autoStart) start();'));
    source = source.replace('if (CONFIG.ui.autoStart) start();', exposure);
    vm.runInNewContext(source, context, { filename: sourcePath });
    const h = context.window.__test; h.acceptState(structuredClone(initial)); h.setRunning();
    return { h, calls, storage, context, setResponder(fn) { responder = fn; },
        get backend() { return backend; }, set backend(value) { backend = value; },
        response(result = {}) { return { ok: true, status: 200, json: async () => ({ data: { state: structuredClone(backend), result } }) }; },
        sync() { h.acceptState(structuredClone(backend)); },
    };
}
async function run() {
    let passed = 0;
    async function test(name, body) { await body(); passed++; console.log(`PASS ${name}`); }
    await test('overflow stamina remains available', () => {
        const { h } = harness(); assert.equal(h.liveStamina(h.runtime.state), 150); assert.equal(h.staminaWaitSeconds(h.runtime.state, 130), 0);
    });
    await test('six UI pages render, switches persist', () => {
        const x = harness(); assert.equal(x.h.tabBar.children.length, 6); for (const b of x.h.tabBar.children) b.onclick();
        x.h.setSetting('crafting.enabled', false); assert.equal(x.h.CONFIG.crafting.enabled, false);
        assert.equal(harness(fixture(), [...x.storage]).h.CONFIG.crafting.enabled, false);
    });
    await test('batch respects step, stamina, item reserve and batch toggle', () => {
        const { h } = harness(), node = h.runtime.state.crafting_stations[0]; h.CONFIG.crafting.batchLimit = 99; h.CONFIG.crafting.staminaReserve = 140;
        const plan = { job: node.recipes[0], pipeline: { steps: [{ times: 8 }], stepIndex: 0, done: [0] } };
        assert.equal(h.craftBatchSize(h.runtime.state, node, plan), 5);
        h.setOverride('rlt-node-task-item-keep:crafting:mill', '2'); plan.taskItem = { quantity: 5 };
        assert.equal(h.craftBatchSize(h.runtime.state, node, plan), 3); h.CONFIG.crafting.batchEnabled = false; assert.equal(h.craftBatchSize(h.runtime.state, node, plan), 1);
    });
    await test('batch start sends quantity without crediting completion', async () => {
        const x = harness(), node = x.h.runtime.state.crafting_stations[0], steps = [{ recipeId: 'flour', times: 6 }];
        x.setResponder(req => { assert.equal(req.payload.quantity, 6); Object.assign(x.backend.crafting_stations[0], { empty: false, queue_total: 6, queued_count: 5, completed_count: 0, collected_count: 0, recipe: node.recipes[0], task_snapshot: { ready_at: x.backend.server_time + 60, recipe_id: 'flour' } }); return x.response(); });
        await x.h.startCraftPlan({ id: 'mill', node, job: node.recipes[0], pipeline: { steps, stepIndex: 0, done: [0] } });
        assert.equal(x.h.craftPipelineProgress('mill', steps).done[0], 0); assert.equal(x.h.craftFlight('mill').quantity, 6);
    });
    await test('partial collection credits actual quantity once', async () => {
        const x = harness(), steps = [{ recipeId: 'flour', times: 6 }];
        Object.assign(x.backend.crafting_stations[0], { empty: false, ready: false, completed_count: 2, queued_count: 3, collected_count: 0, recipe: x.backend.crafting_stations[0].recipes[0] }); x.sync();
        x.h.saveCraftFlight('mill', { phase: 'active', quantity: 6, credited: 0, observedCollected: 0, recipeId: 'flour', steps, stepIndex: 0 });
        x.setResponder(() => { Object.assign(x.backend.crafting_stations[0], { completed_count: 0, collected_count: 2 }); return x.response({ completed_count: 2 }); });
        await x.h.collectReadyIndustries(); x.h.reconcileCraftFlights(x.h.runtime.state);
        assert.equal(x.calls.length, 1); assert.equal(x.h.craftPipelineProgress('mill', steps).done[0], 2);
    });
    await test('master and collection switches prevent collection', async () => {
        const x = harness(); x.backend.crafting_stations[0].completed_count = 2; x.sync(); x.h.CONFIG.crafting.autoCollect = false;
        await x.h.collectReadyIndustries(); assert.equal(x.calls.length, 0); x.h.CONFIG.crafting.autoCollect = true; x.h.CONFIG.crafting.enabled = false;
        await x.h.collectReadyIndustries(); assert.equal(x.calls.length, 0);
    });
    await test('ambiguous start pauses station across reload', async () => {
        const x = harness(), node = x.h.runtime.state.crafting_stations[0];
        x.setResponder(req => { if (req.url.endsWith('/state')) return { ok: true, json: async () => ({ data: structuredClone(x.backend) }) }; throw new Error('lost connection'); });
        await assert.rejects(x.h.startCraftPlan({ id: 'mill', node, job: node.recipes[0] })); assert.equal(x.h.craftFlight('mill').phase, 'uncertain');
        const y = harness(fixture(), [...x.storage]); y.h.reconcileCraftFlights(y.h.runtime.state); assert.equal(y.h.craftFlight('mill').phase, 'uncertain');
    });
    await test('cancel retains completed portions and no premature credit', async () => {
        const x = harness(), node = x.backend.crafting_stations[0], steps = [{ recipeId: 'flour', times: 6 }];
        Object.assign(node, { empty: false, recipe: node.recipes[0], task_snapshot: { ready_at: 1000, recipe_id: 'flour' }, completed_count: 2, queued_count: 3 }); x.sync();
        x.h.saveCraftFlight('mill', { phase: 'active', quantity: 6, credited: 0, observedCollected: 0, recipeId: 'flour', steps, stepIndex: 0 }); x.h.runtime.cancelCraft = { id: 'mill', recipeId: 'flour', readyAt: 1000 };
        x.setResponder(() => { Object.assign(node, { task_snapshot: null, ready: true, queued_count: 0 }); return x.response(); });
        await x.h.processCraftCancel(); assert.equal(x.h.craftFlight('mill').quantity, 2); assert.equal(x.h.craftPipelineProgress('mill', steps).done[0], 0);
    });
    await test('balanced-feed buying reaches target with aquatic disabled', async () => {
        const x = harness(); x.h.CONFIG.feed.enabled = true; x.h.CONFIG.aquatic.enabled = false;
        x.setResponder(req => {
            const slot = x.backend.aquatic.feed_slot; let item = x.backend.inventory.find(i => i.item_id === 'balanced');
            if (req.url.endsWith('/shop/buy')) {
                assert.equal(req.payload.shop_id, 'balanced-shop'); if (!item) { item = { item_id: 'balanced', name: '均衡饲料', quality: 0, quantity: 0 }; x.backend.inventory.push(item); }
                item.quantity += req.payload.quantity; x.backend.player.coins -= req.payload.quantity * 5;
            } else { assert.equal(req.url.endsWith('/feed-slot/deposit'), true); assert.equal(req.payload.item_id, 'balanced'); slot.units += req.payload.count * 100; item.quantity -= req.payload.count; }
            slot.inputs = [{ item_id: 'balanced', item: { name: '均衡饲料' }, quality: 0, quantity: item.quantity, units: 100 }]; return x.response();
        });
        await x.h.doAquaticFeed(); assert.equal(x.h.runtime.state.aquatic.feed_slot.units, 800); assert.equal(x.backend.player.coins, 19965); assert.equal(x.backend.inventory[0].quantity, 100);
    });
    await test('feed hysteresis and invalid bounds cause no purchase', async () => {
        const x = harness(); x.h.CONFIG.feed.enabled = true; x.h.runtime.state.aquatic.feed_slot.units = 400;
        await x.h.doAquaticFeed(); assert.equal(x.calls.length, 0); x.h.CONFIG.feed.low = 90; x.h.CONFIG.feed.target = 50;
        await x.h.doAquaticFeed(); assert.equal(x.calls.length, 0);
    });
    await test('feed protects tribute quantities', async () => {
        const x = harness(); x.h.CONFIG.feed.enabled = true; x.h.CONFIG.feed.autoBuy = false;
        x.backend.inventory.push({ item_id: 'balanced', name: '均衡饲料', quality: 3, quantity: 20 }); x.backend.portals = [{ unlocked: true, tributes: [{ item_id: 'balanced', min_quality: 3, quantity: 20 }] }];
        x.backend.aquatic.feed_slot.inputs = [{ item_id: 'balanced', item: { name: '均衡饲料' }, quality: 3, quantity: 20, units: 100 }]; x.sync();
        await x.h.doAquaticFeed(); assert.equal(x.calls.length, 0);
    });
    await test('feed coin reserve prevents purchases', async () => {
        const x = harness(); x.h.CONFIG.feed.enabled = true; x.h.CONFIG.feed.coinReserve = 20000; await x.h.doAquaticFeed(); assert.equal(x.calls.length, 0);
    });
    await test('sailing off or missing route prevents departure', async () => {
        const x = harness(); await x.h.doSailing(); assert.equal(x.calls.length, 0); x.h.CONFIG.sailing.enabled = true; x.h.CONFIG.sailing.autoStart = true;
        await x.h.doSailing(); assert.equal(x.calls.length, 0);
    });
    await test('sailing collects then starts with party and UUID', async () => {
        const x = harness(); Object.assign(x.h.CONFIG.sailing, { enabled: true, autoStart: true, routeId: 'reed_bay' });
        x.backend.partners = [{ partner_id: 'p1', name: '海风', tendencies: [{ industry: 'aquatic', effective_ability: 20 }] }];
        x.backend.sailing.active_run = { run_id: 'old', ready_at: x.backend.server_time - 1, route_name: '芦苇湾', partner_ids: ['p1'] }; x.sync();
        x.setResponder(req => { if (req.url.endsWith('/collect')) { assert.equal(req.payload.run_id, 'old'); x.backend.sailing.active_run = null; } else { assert.deepEqual(req.payload.partner_ids, ['p1']); assert.equal(req.payload.route_id, 'reed_bay'); assert.match(req.payload.request_id, /^[\da-f-]{36}$/); } return x.response(); });
        await x.h.doSailing(); assert.equal(x.calls.length, 2);
    });
    await test('specified sailors reserved, busy party not substituted', async () => {
        const x = harness(); Object.assign(x.h.CONFIG.sailing, { enabled: true, autoStart: true, routeId: 'reed_bay', partnerIds: '["p1"]' });
        const p = { partner_id: 'p1', tendencies: [] }; x.backend.partners = [p]; x.sync(); assert.equal(x.h.isPartnerIdle(p, x.h.runtime.state), false);
        p.locked = true; x.sync(); await x.h.doSailing(); assert.equal(x.calls.length, 0);
    });
    await test('sailing coin and stamina budgets enforced', async () => {
        const x = harness(); Object.assign(x.h.CONFIG.sailing, { enabled: true, autoStart: true, routeId: 'reed_bay', maxSpendPerTick: 0 });
        await x.h.doSailing(); assert.equal(x.calls.length, 0); x.h.CONFIG.sailing.maxSpendPerTick = 100; x.h.CONFIG.sailing.staminaReserve = 150;
        await x.h.doSailing(); assert.equal(x.calls.length, 0);
    });
    await test('manual voyage and exploration parties excluded from production', () => {
        const { h } = harness(), p = { partner_id: 'p1' }; h.runtime.state.sailing.active_run = { partner_ids: ['p1'] }; assert.equal(h.isPartnerIdle(p), false);
        h.runtime.state.sailing.active_run = null; h.runtime.state.exploration.active_run = { partner_ids: ['p1'] }; assert.equal(h.isPartnerIdle(p), false);
    });
    await test('disabled submissions and paused stations never start jobs', async () => {
        const x = harness(); x.h.CONFIG.gathering.enabled = x.h.CONFIG.mining.enabled = false;
        x.h.setOverride('rlt-node-job:crafting:mill', 'flour'); x.h.CONFIG.crafting.autoStart = false;
        await x.h.startEmptyIndustries(); assert.equal(x.calls.length, 0); x.h.CONFIG.crafting.autoStart = true; x.h.setOverride('rlt-craft-paused:mill', '1');
        await x.h.startEmptyIndustries(); assert.equal(x.calls.length, 0);
    });
    await test('full queue collection completes step and releases next step', async () => {
        const x = harness(), steps = [{ recipeId: 'flour', times: 3 }, { recipeId: 'bread', times: 2 }];
        const node = x.backend.crafting_stations[0];
        Object.assign(node, { empty: false, ready: true, completed_count: 3, collected_count: 0 }); x.sync();
        x.h.saveCraftFlight('mill', { phase: 'active', quantity: 3, credited: 0, observedCollected: 0, recipeId: 'flour', steps, stepIndex: 0 });
        x.setResponder(() => { Object.assign(node, { empty: true, ready: false, completed_count: 0 }); return x.response({ completed_count: 3 }); });
        await x.h.collectReadyIndustries(); assert.equal(x.h.craftFlight('mill'), null);
        assert.equal(x.h.craftPipelineProgress('mill', steps).stepIndex, 1); assert.equal(x.h.craftPipelineProgress('mill', steps).done[0], 3);
    });
    await test('active per-step task item selection and master toggle respected', () => {
        const { h } = harness(); h.runtime.state.task_items = [{ id: 'finish', timing: 'active', quantity: 2, value: 30 }];
        h.saveCraftFlight('mill', { phase: 'active', taskItemChoice: 'finish' });
        assert.equal(h.slotTaskItem(h.runtime.state, 'crafting', 'mill', 'active').id, 'finish');
        h.CONFIG.crafting.useTaskItems = false; assert.equal(h.slotTaskItem(h.runtime.state, 'crafting', 'mill', 'active'), null);
    });
    await test('feed calibration never buys repeatedly when metadata is absent', async () => {
        const x = harness(); x.h.CONFIG.feed.enabled = true;
        x.setResponder(req => { assert.equal(req.payload.quantity, 1); x.backend.inventory.push({ item_id: 'balanced', quantity: 1 }); return x.response(); });
        await x.h.doAquaticFeed(); await x.h.doAquaticFeed(); assert.equal(x.calls.length, 1);
    });
    await test('feed per-tick budget and resumed filling are enforced', async () => {
        const x = harness(); x.h.CONFIG.feed.enabled = true; x.h.CONFIG.feed.maxSpendPerTick = 5;
        x.setResponder(req => {
            const slot = x.backend.aquatic.feed_slot;
            let item = x.backend.inventory.find(i => i.item_id === 'balanced');
            if (!item) { item = { item_id: 'balanced', quantity: 0 }; x.backend.inventory.push(item); }
            if (req.url.endsWith('/buy')) { item.quantity += req.payload.quantity; x.backend.player.coins -= 5 * req.payload.quantity; }
            else { item.quantity -= req.payload.count; slot.units += 100 * req.payload.count; }
            slot.inputs = [{ item_id: 'balanced', quantity: item.quantity, quality: 0, units: 100 }]; return x.response();
        });
        await x.h.doAquaticFeed(); assert.equal(x.backend.player.coins, 19995); assert.equal(x.backend.aquatic.feed_slot.units, 200);
        await x.h.doAquaticFeed(); assert.equal(x.backend.aquatic.feed_slot.units, 300); assert.equal(x.backend.player.coins, 19990);
    });
    await test('ambiguous sailing departure does not produce another UUID/retry', async () => {
        const x = harness(); Object.assign(x.h.CONFIG.sailing, { enabled: true, autoStart: true, routeId: 'reed_bay' });
        x.backend.partners = [{ partner_id: 'p1' }]; x.sync();
        x.setResponder(req => { if (req.url.endsWith('/state')) return { ok: true, json: async () => ({ data: structuredClone(x.backend) }) }; throw new Error('network lost'); });
        await assert.rejects(x.h.doSailing()); const starts = x.calls.filter(req => req.url.endsWith('/start')).length;
        await x.h.doSailing(); assert.equal(x.calls.filter(req => req.url.endsWith('/start')).length, starts);
    });
    await test('build and upgrade share the sailing tick budget', async () => {
        const x = harness(); Object.assign(x.h.CONFIG.sailing, { enabled: true, autoBuild: true, autoUpgrade: true, maxSpendPerTick: 100 });
        Object.assign(x.backend.sailing, { ship_built: false, construction: { coins: 80, materials: [] }, upgrades: [{ kind: 'hull', level: 0, coins: 30, quantity: 0 }] }); x.sync();
        x.setResponder(req => { assert.equal(req.url.endsWith('/build'), true); x.backend.sailing.ship_built = true; x.backend.player.coins -= 80; return x.response(); });
        await x.h.doSailing(); assert.equal(x.calls.length, 1);
    });
    await test('reserving an assigned sailor does not withdraw their current post', () => {
        const { h } = harness(); Object.assign(h.CONFIG.sailing, { enabled: true, autoStart: true, partnerIds: '["p1"]' });
        h.runtime.state.plots = [{ slot: 0, empty: true, assigned_partner_ids: ['p1'] }];
        assert.equal(h.managedPartnerSlots(h.runtime.state).some(slot => slot.industry === 'farming'), false);
    });
    await test('forecast includes partial completed and queued crafting outputs', () => {
        const { h } = harness(), node = h.runtime.state.crafting_stations[0];
        Object.assign(node, { empty: false, ready: false, recipe: node.recipes[0], queued_count: 3, task_snapshot: {}, completed_results: [{ item_id: 'flour', quality: 1, quantity: 2 }] });
        assert.equal(h.inFlightIndustryGuaranteedQty(h.runtime.state, { itemId: 'flour', minQuality: 0 }), 6);
    });
    await test('legacy boolean and numeric settings survive; canonical edits take priority', () => {
        const x = harness(fixture(), [['rlt-craft-enabled', 'off'], ['rlt-aquatic-chain', '9'], ['rlt-aquatic-stamina-reserve', '25']]);
        assert.equal(x.h.CONFIG.crafting.enabled, false); assert.equal(x.h.CONFIG.aquatic.chainCasts, 9); assert.equal(x.h.CONFIG.aquatic.staminaReserve, 25);
        x.h.CONFIG.crafting.enabled = true; x.h.CONFIG.aquatic.chainCasts = 3;
        const next = harness(fixture(), [...x.storage]);
        assert.equal(next.h.CONFIG.crafting.enabled, true); assert.equal(next.h.CONFIG.aquatic.chainCasts, 3);
    });
    await test('reserves refresh on settings change and keep cache for identical writes', () => {
        const { h } = harness(); h.setOverride('rlt-node-job:crafting:mill', 'flour');
        const first = h.craftingInputReserves(h.runtime.state); assert.ok(first.size > 0);
        assert.equal(h.setOverride('rlt-node-job:crafting:mill', 'flour'), false);
        assert.equal(h.craftingInputReserves(h.runtime.state), first);
        h.CONFIG.crafting.enabled = false;
        assert.equal(h.craftingInputReserves(h.runtime.state).size, 0);
    });
    await test('settings render only the selected page and retain independent scroll positions', () => {
        const { h } = harness();
        assert.equal(h.configBox.children.length, 0);
        const go = page => h.tabBar.children.find(button => button.dataset.page === page).onclick();
        go('production'); h.configBox.scrollTop = 123;
        go('feed'); assert.equal(h.configBox.scrollTop, 0);
        assert.ok(h.configBox.children.every(group => group.dataset.page === 'feed'));
        h.configBox.scrollTop = 45; go('production'); assert.equal(h.configBox.scrollTop, 123);
        assert.ok(h.configBox.children.every(group => group.dataset.page === 'production'));
        go('feed'); assert.equal(h.configBox.scrollTop, 45);
    });
    await test('dashboard retains card nodes while updating values and removing ended tasks', () => {
        const { h } = harness();
        h.runtime.state.plots = [{ slot: 0, empty: false, ready: false, ready_at: h.runtime.state.server_time + 30 }];
        h.renderDashboard(h.runtime.state); const cards = [...h.dashboard.children];
        const next = structuredClone(h.runtime.state); next.player.coins += 100;
        h.renderDashboard(next);
        cards.forEach((card, index) => assert.equal(h.dashboard.children[index], card));
        assert.equal(h.dashboard.children[0].children[1].children[1].textContent, '20,100');
        next.plots = []; h.renderDashboard(next); assert.ok(!h.dashboard.children.includes(cards[2]));
    });
    await test('settings refresh preserves an in-progress numeric edit', () => {
        const x = harness(), { h } = x;
        h.tabBar.children.find(button => button.dataset.page === 'feed').onclick();
        const input = element('input'); input.value = '37'; h.configBox.children[0].appendChild(input);
        x.context.document.activeElement = input;
        h.refreshConfigRows(structuredClone(h.runtime.state));
        assert.ok(h.configBox.contains(input)); assert.equal(input.value, '37');
        x.context.document.activeElement = null;
        h.refreshConfigRows(structuredClone(h.runtime.state)); assert.equal(h.configBox.contains(input), false);
    });
    await test('configuration pages also render before login', () => {
        const x = harness(); x.h.setRunning(false);
        x.context.document.querySelector = () => null; x.h.runtime.state = null;
        for (const button of x.h.tabBar.children) button.onclick();
        assert.ok(x.h.configBox.children.length);
    });
    await test('stop cancels a waiting fishing interval immediately', async () => {
        const { h } = harness(), waiting = h.sleep(60000);
        h.stop(); await assert.rejects(waiting, error => error.code === 'aborted');
    });
    await test('rapid restart holds the tab lock until the old request drains', async () => {
        const x = harness(), { h } = x; h.stop();
        let locks = 0, released = 0, respond, entered;
        const requestEntered = new Promise(resolve => { entered = resolve; });
        x.context.navigator.locks = { async request(name, options, callback) { locks++; try { await callback({ name }); } finally { released++; } } };
        x.setResponder(() => { entered(); return new Promise(resolve => { respond = resolve; }); });
        try {
            await h.start(); await requestEntered;
            const oldController = h.runtime.controller;
            h.stop(); const restarting = h.start(); await Promise.resolve();
            assert.equal(locks, 1); assert.equal(released, 0); assert.equal(h.runtime.controller, oldController);
            assert.equal(oldController.signal.aborted, true); assert.equal(h.activity().running, false);
            respond({ ok: true, status: 200, json: async () => ({ data: structuredClone(x.backend) }) });
            await restarting;
            assert.equal(locks, 2); assert.equal(released, 1); assert.equal(h.activity().running, true);
            assert.notEqual(h.runtime.controller, oldController); assert.equal(x.calls.length, 1);
        } finally { h.stop(); }
    });
    await test('stopping during lock acquisition cannot reactivate a canceled start', async () => {
        const x = harness(), { h } = x; h.stop();
        let deliver;
        x.context.navigator.locks = { request(name, options, callback) { return new Promise(resolve => { deliver = () => resolve(callback({ name })); }); } };
        const starting = h.start(); await Promise.resolve(); h.stop(); deliver(); await starting;
        assert.equal(h.activity().running, false); assert.equal(h.runtime.controller, null);
    });
    await test('settings wakeups cannot bypass server rate-limit backoff', async () => {
        const x = harness(), { h } = x;
        x.setResponder(() => { h.wakeSoon(); return { ok: false, status: 429, headers: { get: () => '60' }, json: async () => ({ message: 'Too many requests' }) }; });
        try {
            await h.tick(); assert.equal(x.calls.length, 1); assert.ok(h.activity().retryNotBefore > Date.now() + 50000);
            h.wakeSoon(); await h.tick(); assert.equal(x.calls.length, 1);
        } finally { h.stop(); }
    });
    await test('aborted crafting submission retains its uncertain queue journal', async () => {
        const x = harness(), node = x.h.runtime.state.crafting_stations[0];
        x.setResponder(() => { x.h.stop(); throw new DOMException('Stopped after request was sent', 'AbortError'); });
        await assert.rejects(x.h.startCraftPlan({ id: 'mill', node, job: node.recipes[0] }), error => error.code === 'aborted');
        assert.equal(x.h.craftFlight('mill').phase, 'uncertain');
        assert.equal(x.h.runtime.stateUncertain, true);
    });
    console.log(`\n${passed} scenarios passed (mock HTTP only).`);
}
module.exports = { fixture, harness, sourcePath };
if (require.main === module) run().catch(e => { console.error(e); process.exitCode = 1; });
