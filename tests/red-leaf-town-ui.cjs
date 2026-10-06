const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { fixture, sourcePath } = require('./red-leaf-town-v4.test.cjs');
const preview = path.join(__dirname, 'red-leaf-town-preview.html');
const state = fixture(), now = state.server_time;
state.inventory.push({ item_id: 'pumpkin', name: '南瓜', quality: 1, quantity: 30 }, { item_id: 'grain_feed', name: '谷物饲料', quality: 0, quantity: 20 },
    { item_id: 'grape', name: '葡萄', quality: 1, quantity: 20 }, { item_id: 'wood', name: '木材', quality: 1, quantity: 30 });
state.aquatic.feed_slot.inputs = [{ item_id: 'pumpkin', item: { name: '南瓜' }, quality: 1, quantity: 30, units: 30, unit_score: 60 }, { item_id: 'grain_feed', item: { name: '谷物饲料' }, quality: 0, quantity: 20, units: 90, unit_score: 80 }];
state.plots = [{ slot: 0, size: 2, empty: false, ready: false, ready_at: now + 240, planted_at: now - 360, crop: { name: '南瓜' } },
    { slot: 2, size: 1, empty: true, ready: false }, { slot: 3, size: 1, empty: true, ready: false }];
state.next_plot_level = 8;
state.player.coins = 5000;
state.aquatic.ponds = [
    { pond_id: 'pond1', definition: { name: '溪畔鱼塘', species_id: 'carp' }, stock: 40, population: 45, capacity: 50,
        steady_stock: 30, fry: [{ count: 5, cycles_left: 2 }], last_settled_at: now - 300, next_cycle_seconds: 600 },
    { pond_id: 'pond2', definition: { name: '山间鱼塘', species_id: 'trout' }, stock: 50, population: 60, capacity: 80,
        steady_stock: 45, fry: [{ count: 10, cycles_left: 2 }], last_settled_at: now - 300, next_cycle_seconds: 900 },
];
state.aquatic.species = [
    { id: 'carp', name: '鲤鱼', unlocked: true, owned_fry: 20 },
    { id: 'trout', name: '鳟鱼', unlocked: true, owned_fry: 20 },
];
state.aquatic.buildable_ponds = [{ id: 'pond3', name: '第三口鱼塘', capacity: 100, min_level: 8,
    unlocked: false, affordable: true, build_cost: 1000, build_materials: [{ item_id: 'wood', name: '木材', quantity: 8 }] }];
state.crops = [{ id: 'pumpkin', name: '南瓜', seed_item_id: 'pumpkin_seed' }];
state.partners = [{ partner_id: 'p1', name: '海风', tendencies: [{ industry: 'aquatic', effective_ability: 45 }] }, { partner_id: 'p2', name: '晨曦' }, { partner_id: 'p3', name: '林间' }];
state.sailing.active_run = { run_id: 'demo', route_name: '芦苇湾', started_at: now - 1500, ready_at: now + 2100, partner_ids: ['p1'] };
Object.assign(state.crafting_stations[0], { empty: false, ready: false, completed_count: 2, queued_count: 5, collected_count: 0, queue_total: 8, queue_remaining_seconds: 320, recipe: state.crafting_stations[0].recipes[0], task_snapshot: { recipe_id: 'flour', ready_at: now + 30, started_at: now - 30 } });
state.crafting_stations.push({ ...structuredClone(state.crafting_stations[0]), station_id: 'kitchen', definition: { name: '小镇厨房' },
    empty: true, ready: false, completed_count: 0, queued_count: 0, collected_count: 0, queue_total: 0,
    queue_remaining_seconds: 0, recipe: null, task_snapshot: null });
state.facilities = {
    upgrades: [
        { id: 'farm_2', kind: 'farm', stage: 2, name: '第二块双倍田', unlocked: true, affordable: true, coins: 1500, inputs: [{ item_id: 'wood', name: '木材', quantity: 20 }] },
        { id: 'feed_2', kind: 'feed', name: '扩充共用饲料槽', unlocked: true, coins: 1000, inputs: [{ item_id: 'wood', name: '木材', quantity: 10 }] },
    ],
    refining: { built: true, unlocked: true, ability: 120, max_quality: 4, locked: true,
        assigned_partner: { partner_id: 'refiner', name: '酿酒伙伴' },
        slots: [{ task_id: 'manual-wine', item: { item_id: 'grape_wine', name: '葡萄酒' }, max_quality: 4,
            quality_times: [now - 60, now + 600, now + 3600, now + 7200] }, null, null, null, null, null],
        recipes: [{ id: 'grape_wine', unlocked: true, item: { item_id: 'grape_wine', name: '葡萄酒' },
            input_item: { item_id: 'grape', name: '葡萄' }, input_quantity: 2, output_prices: [5, 10, 20, 40],
            options: [1, 2].map(quality => ({ quality, owned: quality === 1 ? 20 : 0, input_value: 4,
                quality_times: [now + 60, now + 600, now + 3600, now + 7200] })) }] },
};
const source = fs.readFileSync(sourcePath, 'utf8').replace('if (CONFIG.ui.autoStart) start();', `window.__rltPreview = {
    runtime, refreshConfigRows, renderDashboard, setSetting, getOverride, start, stop, CONFIG,
    craftRun, startCraftRun, stopCraftRun, configuredCraftSteps, craftPipelineProgress, advanceCraftPipeline, finishCraftRun,
    refiningConfig, refiningRun, startRefiningRun, stopRefiningRun, pondSettings, pondBuildEnabled, plotManagementMode
};
setOverride('rlt-node-job:crafting:kitchen', 'flour'); setOverride('rlt-craft-lock-times:kitchen', '3');
setOverride('rlt-refining-config:1', JSON.stringify({recipeId:'grape_wine',inputQuality:1,targetQuality:3,times:2}));
runtime.state = window.fixtureState; renderDashboard(runtime.state);`);
fs.writeFileSync(preview, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>红叶镇助手预览</title><style>body{background:#e8eddf;color:#324535;font:18px system-ui;margin:45px}h1{font-size:28px}p{font-size:14px;color:#6c7c62}</style><div id="app"><h1>红叶镇物语</h1><p>助手界面离线预览 · 模拟状态</p></div><script>localStorage.clear();window.fixtureState=${JSON.stringify(state)};document.querySelector('#app').__vue_app__={_context:{config:{globalProperties:{$pinia:{_s:new Map([['story',{cue(){},active:false,queue:[]}],['game',{state:window.fixtureState,refresh(){}}]])}}}}};window.fetch=async()=>{throw new Error('Preview must not access game network')};</script><script>${source.replace(/<\/script/gi, '<\\/script')}</script></html>`, 'utf8');

async function main() {
    const pages = await (await fetch('http://127.0.0.1:9236/json/list')).json();
    const page = pages.find(p => p.type === 'page');
    assert.ok(page);
    const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(), errors = []; let id = 0;
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => { const msg = JSON.parse(event.data); if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + msg.params.exceptionDetails.exception?.description); if (msg.id) { const item = pending.get(msg.id); if (item) { pending.delete(msg.id); msg.error ? item.reject(msg.error) : item.resolve(msg.result); } } };
    function send(method, params = {}) { return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); }); }
    async function evaluate(expression) { const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description); return value.result.value; }
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(preview).href });
    for (let tries = 0; tries < 50; tries++) { if (await evaluate('!!window.__rltPreview')) break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(await evaluate('!!window.__rltPreview'), true);
    await evaluate('window.confirm=()=>true');
    async function screenshot(name) {
        const box = await evaluate(`(()=>{const r=document.querySelector('#rlt-auto-helper-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
        const image = await send('Page.captureScreenshot', { format: 'png', clip: box }); fs.writeFileSync(path.join(__dirname, name + '.png'), Buffer.from(image.data, 'base64'));
    }
    await screenshot('rlt-v4-overview');
    for (const name of ['production', 'crafting', 'refining', 'sailing', 'feed', 'facilities', 'settings']) {
        await evaluate(`document.querySelector('.rlt-tabs [data-page="${name}"]').click()`);
        const visible = await evaluate(`Array.from(document.querySelectorAll('.rlt-group')).map(e=>e.dataset.page)`);
        assert.ok(visible.length && visible.every(value => value === name), name + ' panel visibility');
        const overflow = await evaluate(`(()=>{const e=document.querySelector('#rlt-auto-helper-panel');return e.scrollWidth-e.clientWidth})()`); assert.ok(overflow <= 1, name + ' horizontal overflow');
        if (['crafting', 'feed', 'sailing', 'refining', 'facilities'].includes(name)) await screenshot('rlt-v4-' + name);
    }
    // Actual single/double plots and ponds expose independent persistent controls.
    await evaluate(`document.querySelector('.rlt-tabs [data-page="production"]').click()`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.rlt-config [data-plot-slot]')].map(e=>e.dataset.plotSlot)`), ['0', '2', '3']);
    assert.equal(await evaluate(`document.querySelector('[data-plot-slot="0"]').textContent.includes('双倍田')`), true);
    assert.equal(await evaluate(`document.querySelector('[data-plot-slot="0"]').textContent.includes('2 粒种子') || document.querySelector('[data-plot-slot="0"]').textContent.includes('2 倍用量')`), true);
    const plotMode = '[data-plot-slot="0"] [data-control="plot-mode"]';
    await evaluate(`(()=>{const e=document.querySelector('${plotMode}');e.focus();e.value='manual';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    assert.equal(await evaluate(`window.__rltPreview.plotManagementMode(0)`), 'manual');
    assert.equal(await evaluate(`window.__rltPreview.plotManagementMode(2)`), 'auto');
    await evaluate(`(()=>{const e=document.querySelector('[data-plot-slot="0"] [data-control="plot-crop"]');e.focus();e.value='pumpkin';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    assert.equal(await evaluate(`localStorage.getItem('rlt-plot-crop:0')`), 'pumpkin');
    assert.equal(await evaluate(`localStorage.getItem('rlt-plot-crop:2')`), null);
    assert.equal(await evaluate(`document.querySelector('.rlt-config').textContent.includes('等级 8 解锁')`), true);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    await evaluate(`document.querySelector('.rlt-config [data-plot-slot="0"]').scrollIntoView({block:'start'})`);
    await screenshot('rlt-v451-double-plot');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.rlt-config [data-pond-id]')].map(e=>e.dataset.pondId)`), ['pond1', 'pond2']);
    assert.deepEqual(await evaluate(`[...document.querySelector('[data-pond-id="pond2"] select[aria-label="投苗鱼种"]').options].map(e=>e.value)`), ['', 'trout']);
    await evaluate(`(()=>{const e=document.querySelector('[data-pond-id="pond2"] input[data-pond-setting="keepStock"]');e.focus();e.value='46';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    await evaluate(`(()=>{const e=document.querySelector('[data-pond-id="pond2"] input[data-pond-setting="restockTarget"]');e.focus();e.value='0';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    assert.equal(await evaluate(`window.__rltPreview.pondSettings('pond2').restockTarget`), 0, 'zero target must differ from inheriting the global default');
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    await evaluate(`(()=>{const e=document.querySelector('[data-pond-id="pond2"] input[data-pond-setting="restockTarget"]');e.focus();e.value='70';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    await evaluate(`(()=>{const e=document.querySelector('[data-pond-id="pond2"] select[aria-label="自动收鱼"]');e.focus();e.value='off';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    assert.deepEqual(await evaluate(`(()=>{const a=window.__rltPreview;return [a.pondSettings('pond1').keepStock,a.pondSettings('pond2').keepStock,a.pondSettings('pond1').autoHarvest,a.pondSettings('pond2').autoHarvest]})()`), [30,46,true,false]);
    await evaluate(`window.__rltPreview.setSetting('aquatic.pondKeepStock',12);window.__rltPreview.refreshConfigRows(window.fixtureState)`);
    assert.deepEqual(await evaluate(`['pond1','pond2'].map(id=>window.__rltPreview.pondSettings(id).keepStock)`), [12,46], 'individual override survives a global default change');
    await evaluate(`window.__rltPreview.setSetting('aquatic.pondKeepStock',30);window.__rltPreview.refreshConfigRows(window.fixtureState)`);
    await evaluate(`(()=>{const e=document.querySelector('[data-pond-build-id="pond3"] select[aria-label="自动建造本塘"]');e.focus();e.value='on';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    assert.equal(await evaluate(`window.__rltPreview.pondBuildEnabled('pond3')`), true);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.aquatic.autoBuildPonds`), false);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    await evaluate(`document.querySelector('.rlt-config [data-pond-id="pond2"]').scrollIntoView({block:'start'})`);
    await screenshot('rlt-v451-second-pond');
    await evaluate(`document.querySelector('.rlt-tabs [data-page="overview"]').click()`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.rlt-dashboard [data-pond-id]')].map(e=>e.dataset.pondId)`), ['pond1','pond2']);
    assert.equal(await evaluate(`document.querySelector('.rlt-dashboard [data-pond-id="pond2"]').textContent.includes('保留 46')`), true);
    await evaluate(`document.querySelector('.rlt-tabs [data-page="production"]').click()`);
    assert.equal(await evaluate(`document.querySelector('${plotMode}').value`), 'manual');
    assert.equal(await evaluate(`document.querySelector('[data-pond-id="pond2"] input[data-pond-setting="restockTarget"]').value`), '70');
    await evaluate(`document.querySelector('.rlt-config [data-focus-key="production:逐塘管理"]').click()`);
    assert.equal(await evaluate(`(()=>{const e=document.querySelector('.rlt-config'),g=e.querySelector('[data-group="逐塘管理"]');return Math.abs(g.getBoundingClientRect().top-e.getBoundingClientRect().top)<2})()`), true, 'pond shortcut opens the correct section');
    // Real browser interaction: a module switch must update its ARIA state and persisted setting.
    await evaluate(`document.querySelector('.rlt-tabs [data-page="crafting"]').click()`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="缺料自动加工"]').getAttribute('aria-checked')`), 'true');
    await evaluate(`document.querySelector('[aria-label="缺料自动加工"]').click()`);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.crafting.autoCraftInputs`), false);
    await evaluate(`document.querySelector('[aria-label="缺料自动加工"]').click()`);
    await evaluate(`document.querySelector('.rlt-tabs [data-page="feed"]').click()`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelector('select[aria-label="投喂物品"]').options).map(o=>o.value)`), ['', 'pumpkin', 'grain_feed']);
    await evaluate(`(()=>{const e=document.querySelector('select[aria-label="投喂物品"]');e.value='pumpkin';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.feed.itemId`), 'pumpkin');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('rlt-setting:feed.itemId'))`), 'pumpkin');
    await evaluate(`Array.from(document.querySelectorAll('[role="switch"]')).find(e=>e.getAttribute('aria-label')==='自动补充饲料').click()`);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.feed.enabled`), true);
    assert.equal(await evaluate(`document.querySelector('[aria-label="自动补充饲料"]').getAttribute('aria-checked')`), 'true');
    await evaluate(`document.querySelector('[aria-label="自动补充饲料"]').focus();document.activeElement.click()`);
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), '自动补充饲料');
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-checked')`), 'false');
    // A configured idle station must wait for an explicit click. Trusted mouse/keyboard
    // activation must preserve focus when the card is rebuilt and retain the same run on resume.
    await evaluate(`document.querySelector('.rlt-tabs [data-page="crafting"]').click()`);
    const craftButton = '[data-focus-key="craft:kitchen:execute"]';
    async function craftControl() {
        return evaluate(`(()=>{const api=window.__rltPreview,e=document.querySelector('${craftButton}');return {
            label:e.textContent,disabled:e.disabled,focusKey:document.activeElement?.dataset.focusKey,
            run:api.craftRun('kitchen'),done:api.craftPipelineProgress('kitchen',api.configuredCraftSteps('kitchen')).done
        }})()`);
    }
    async function clickCraftControl() {
        const point = await evaluate(`(()=>{const e=document.querySelector('${craftButton}');e.scrollIntoView({block:'center'});e.focus();
            const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
    let craft = await craftControl();
    assert.equal(craft.label, '执行一次'); assert.equal(craft.disabled, false); assert.equal(craft.run, null);
    assert.deepEqual(craft.done, [0]);
    assert.equal(await evaluate(`document.querySelector('[data-focus-key="craft:mill:execute"]').disabled`), true, 'a manual active queue cannot authorize a new run');
    await clickCraftControl();
    craft = await craftControl();
    assert.equal(craft.label, '停止本轮'); assert.equal(craft.focusKey, 'craft:kitchen:execute');
    assert.equal(craft.run.status, 'running'); assert.ok(craft.run.id);
    const craftRunId = craft.run.id;
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('rlt-craft-run-once:kitchen')).id`), craftRunId);
    // Simulate a collected portion while keeping this preview offline; the lifecycle suite
    // separately exercises actual start/collect requests and completion accounting.
    await evaluate(`(()=>{const api=window.__rltPreview;api.advanceCraftPipeline('kitchen',api.configuredCraftSteps('kitchen'),0,1);api.refreshConfigRows(api.runtime.state)})()`);
    await clickCraftControl();
    craft = await craftControl();
    assert.equal(craft.label, '继续本轮'); assert.equal(craft.run.status, 'stopped'); assert.equal(craft.run.id, craftRunId);
    assert.equal(craft.focusKey, 'craft:kitchen:execute'); assert.deepEqual(craft.done, [1]);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    craft = await craftControl();
    assert.equal(craft.label, '停止本轮'); assert.equal(craft.run.status, 'running'); assert.equal(craft.run.id, craftRunId);
    assert.equal(craft.focusKey, 'craft:kitchen:execute'); assert.deepEqual(craft.done, [1]);
    await evaluate(`(()=>{const api=window.__rltPreview;api.advanceCraftPipeline('kitchen',api.configuredCraftSteps('kitchen'),0,2);api.finishCraftRun('kitchen');api.refreshConfigRows(api.runtime.state)})()`);
    craft = await craftControl();
    assert.equal(craft.label, '再执行一次'); assert.equal(craft.run.status, 'completed'); assert.deepEqual(craft.done, [3]);
    assert.equal(craft.focusKey, 'craft:kitchen:execute');
    await clickCraftControl();
    craft = await craftControl();
    assert.equal(craft.label, '停止本轮'); assert.equal(craft.run.status, 'running'); assert.notEqual(craft.run.id, craftRunId);
    assert.deepEqual(craft.done, [0]); assert.equal(craft.focusKey, 'craft:kitchen:execute');
    await clickCraftControl();
    assert.equal((await craftControl()).run.status, 'stopped');
    // New pages: explicit reservations, average quality settings and finite refining runs.
    await evaluate(`document.querySelector('.rlt-tabs [data-page="facilities"]').click()`);
    await evaluate(`(()=>{const e=document.querySelector('select[aria-label="农田改良"]');e.value='farm_2';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    assert.equal(await evaluate(`window.__rltPreview.getOverride('rlt-facility-reserve:farm')`), 'farm_2');
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    assert.equal(await evaluate(`document.querySelector('.rlt-config').textContent.includes('预留中')`), true);
    await evaluate(`(()=>{const e=document.querySelector('select[aria-label="饲料设施"]');e.value='feed_2';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    assert.equal(await evaluate(`document.querySelector('.rlt-config').textContent.includes('已选项目合计 30 件')`), true);
    assert.equal(await evaluate(`document.querySelector('.rlt-config').textContent.includes('项备齐')`), false);
    const farmUpgrade = '[data-focus-key="facility:farm_2:execute"]';
    assert.equal(await evaluate(`document.querySelector('${farmUpgrade}').disabled`), false);
    await evaluate(`document.querySelector('${farmUpgrade}').click()`);
    assert.equal(await evaluate(`window.__rltPreview.runtime.facilityUpgrade.projectId`), 'farm_2');
    assert.equal(await evaluate(`document.querySelector('${farmUpgrade}').disabled`), true);
    await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='撤回本次安排').click()`);
    assert.equal(await evaluate(`window.__rltPreview.runtime.facilityUpgrade`), null);
    assert.equal(await evaluate(`localStorage.getItem('rlt-facility-upgrade-intent')`), null, 'queuing/cancelling offline must not send a game request');
    await evaluate(`(()=>{const e=document.querySelector('select[aria-label="新鱼塘建设"]');e.value='pond3';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    assert.equal(await evaluate(`window.__rltPreview.getOverride('rlt-facility-reserve:pond')`), 'pond3');
    assert.equal(await evaluate(`document.querySelector('.rlt-config').textContent.includes('已选项目合计 38 件')`), true);
    assert.equal(await evaluate(`document.querySelector('${farmUpgrade}').disabled`), true, 'farm materials cannot consume the new pond reservation');
    await screenshot('rlt-v451-facility-reservation');
    await evaluate(`document.querySelector('.rlt-tabs [data-page="feed"]').click();document.querySelector('[aria-label="启用品质目标"]').click()`);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.feed.qualityTargetEnabled`), true);
    await evaluate(`(()=>{const e=document.querySelector('input[aria-label="目标品质分"]');e.focus();e.value='65';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.feed.qualityTarget`), 65);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    assert.equal(await evaluate(`document.querySelector('.rlt-config').textContent.includes('目标 65')`), true);
    await screenshot('rlt-v450-feed-quality');
    await evaluate(`document.querySelector('.rlt-tabs [data-page="refining"]').click()`);
    const refineButton = '[data-focus-key="refining:1:execute"]';
    assert.equal(await evaluate(`window.__rltPreview.refiningRun(1)`), null);
    await evaluate(`document.querySelector('${refineButton}').closest('.rlt-work').querySelector('summary').click()`);
    const refinePoint = await evaluate(`(()=>{const e=document.querySelector('${refineButton}');e.scrollIntoView({block:'center'});e.focus();const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...refinePoint, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...refinePoint, button: 'left', clickCount: 1 });
    const refineRunId = await evaluate(`window.__rltPreview.refiningRun(1).id`);
    assert.equal(await evaluate(`window.__rltPreview.refiningRun(1).status`), 'running');
    assert.equal(await evaluate(`document.activeElement.dataset.focusKey`), 'refining:1:execute');
    assert.equal(await evaluate(`document.querySelector('${refineButton}').closest('.rlt-work').querySelector('details').open`), true);
    assert.equal(await evaluate(`[...document.querySelector('${refineButton}').closest('.rlt-work').querySelectorAll('input,select')].every(e=>e.disabled)`), true);
    await evaluate(`document.querySelector('${refineButton}').click()`);
    assert.equal(await evaluate(`window.__rltPreview.refiningRun(1).status`), 'stopped');
    assert.equal(await evaluate(`document.activeElement.dataset.focusKey`), 'refining:1:execute');
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate(`window.__rltPreview.refiningRun(1).status`), 'running');
    assert.equal(await evaluate(`window.__rltPreview.refiningRun(1).id`), refineRunId);
    await evaluate(`document.querySelector('${refineButton}').click()`);
    await screenshot('rlt-v450-refining-config');
    await evaluate(`(()=>{const e=document.querySelector('${refineButton}').closest('.rlt-work').querySelector('select[aria-label="精制配方"]');e.focus();e.value='';e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
    await evaluate(`new Promise(r=>setTimeout(r,40))`);
    assert.equal(await evaluate(`window.__rltPreview.refiningConfig(1).recipeId`), '');
    assert.equal(await evaluate(`document.querySelector('${refineButton}').disabled`), true);
    await evaluate(`document.querySelector('.rlt-tabs [data-page="sailing"]').click();for(let n=1;n<=3;n++){const e=document.querySelector('select[aria-label="伙伴 '+n+'"]');e.focus();e.value='p'+n;e.dispatchEvent(new Event('change',{bubbles:true}))}`);
    assert.deepEqual(await evaluate(`JSON.parse(window.__rltPreview.CONFIG.sailing.partnerIds)`), ['p1', 'p2', 'p3']);
    assert.equal(await evaluate(`document.querySelector('select[aria-label="伙伴 2"] option[value="p1"]').disabled`), true);
    await evaluate(`document.querySelector('.rlt-tabs [data-page="feed"]').click()`);
    // State refresh must not discard an unfinished edit; commit on change/blur.
    await evaluate(`window.editing=document.querySelector('input[aria-label="触发底限"]');editing.focus();editing.value='37';window.__rltPreview.refreshConfigRows(structuredClone(window.fixtureState))`);
    assert.equal(await evaluate(`document.activeElement===editing && editing.isConnected && editing.value==='37'`), true);
    await evaluate(`editing.dispatchEvent(new Event('change',{bubbles:true}));editing.blur();new Promise(r=>setTimeout(r,30))`);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.feed.low`), 37);
    // Each global setting appears once, and each page remembers its own scroll.
    for (const name of ['production', 'feed', 'settings']) {
        await evaluate(`document.querySelector('.rlt-tabs [data-page="${name}"]').click()`);
        assert.equal(await evaluate(`(()=>{const labels=[...document.querySelectorAll('.rlt-config [role="switch"]')].map(e=>e.getAttribute('aria-label'));return new Set(labels).size===labels.length})()`), true);
    }
    await evaluate(`document.querySelector('.rlt-tabs [data-page="production"]').click();document.querySelector('.rlt-config').scrollTop=220;window.productionScroll=document.querySelector('.rlt-config').scrollTop;document.querySelector('.rlt-tabs [data-page="feed"]').click();document.querySelector('.rlt-tabs [data-page="production"]').click()`);
    assert.equal(await evaluate(`productionScroll>0 && document.querySelector('.rlt-config').scrollTop===productionScroll`), true);
    await evaluate(`document.querySelector('.rlt-tabs [data-page="overview"]').click();window.statsNode=document.querySelector('.rlt-stats');window.workNode=document.querySelector('.rlt-dashboard .rlt-work');window.__rltPreview.renderDashboard(structuredClone(window.fixtureState))`);
    assert.equal(await evaluate(`statsNode===document.querySelector('.rlt-stats') && workNode===document.querySelector('.rlt-dashboard .rlt-work')`), true);
    await evaluate(`document.querySelector('.rlt-tabs [data-page="settings"]').click();document.querySelector('[aria-label="图形进度与航线"]').click();document.querySelector('.rlt-tabs [data-page="overview"]').click()`);
    assert.equal(await evaluate(`[...document.querySelectorAll('.rlt-dashboard .rlt-meter,.rlt-dashboard .rlt-voyage')].every(e=>getComputedStyle(e).display==='none')`), true);
    await evaluate(`document.querySelector('[aria-label="收起助手面板"]').click()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.rlt-dashboard')).display`), 'none');
    await evaluate(`document.querySelector('[aria-label="展开助手面板"]').click();window.__rltPreview.setSetting('ui.showGraphs',true);window.__rltPreview.refreshConfigRows(window.fixtureState)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const name of ['overview', 'production', 'crafting', 'refining', 'sailing', 'feed', 'facilities']) {
        await evaluate(`document.querySelector('.rlt-tabs [data-page="${name}"]').click()`);
        assert.equal(await evaluate(`(()=>{const e=document.querySelector('#rlt-auto-helper-panel'),r=e.getBoundingClientRect();return r.right<=innerWidth && r.left>=0 && r.top>=0 && r.bottom<=innerHeight && e.scrollWidth-e.clientWidth<=1})()`), true, name + ' mobile bounds');
    }
    await screenshot('rlt-v4-mobile');
    // Mobile collapsed launcher: small hit area, touch drag and tap remain separate.
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await evaluate(`document.querySelector('[aria-label="收起助手面板"]').click();window.bottomAction=document.createElement('button');bottomAction.textContent='模拟游戏底部操作';bottomAction.style.cssText='position:fixed;right:8px;bottom:8px;width:180px;height:48px';document.body.appendChild(bottomAction)`);
    const panelBox = () => evaluate(`(()=>{const r=document.querySelector('#rlt-auto-helper-panel').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`);
    let launcher = await panelBox();
    assert.equal(launcher.width, 48); assert.equal(launcher.height, 48);
    assert.equal(await evaluate(`document.elementFromPoint(innerWidth-90,innerHeight-32)===bottomAction`), true, 'bottom game action remains reachable');
    const mobileCollapsed = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'rlt-v4-mobile-collapsed.png'), Buffer.from(mobileCollapsed.data, 'base64'));
    async function touch(type, x, y) {
        await send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    }
    await touch('touchStart', launcher.left + 24, launcher.top + 24);
    await touch('touchMove', 120, 220); await touch('touchEnd');
    assert.equal(await evaluate(`document.querySelector('#rlt-auto-helper-panel').classList.contains('rlt-collapsed')`), true, 'drag does not expand launcher');
    launcher = await panelBox(); assert.ok(Math.abs(launcher.left - 96) < 2 && Math.abs(launcher.top - 196) < 2, 'launcher can move on touch screens');
    await touch('touchStart', launcher.left + 24, launcher.top + 24); await touch('touchEnd');
    await evaluate(`new Promise(resolve=>setTimeout(resolve,350))`);
    assert.ok((await panelBox()).width > 300, 'tap expands launcher');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.rlt-config')).display!=='none'`), true);
    await evaluate(`document.querySelector('[aria-label="收起助手面板"]').click()`);
    assert.deepEqual(await panelBox(), launcher, 'collapse restores launcher location');
    for (const [width, height] of [[320, 568], [844, 390]]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
        const small = await panelBox(); assert.equal(small.width, 48); assert.equal(small.height, 48);
        await evaluate(`document.querySelector('[aria-label="展开助手面板"]').click()`);
        const expanded = await panelBox(); assert.ok(expanded.left >= 0 && expanded.top >= 0 && expanded.right <= width && expanded.bottom <= height);
        for (const name of ['production', 'refining', 'feed', 'facilities']) {
            await evaluate(`document.querySelector('.rlt-tabs [data-page="${name}"]').click()`);
            assert.equal(await evaluate(`(()=>{const e=document.querySelector('.rlt-config');return e.scrollWidth-e.clientWidth<=1})()`), true, name + ' narrow content overflow');
            if (width === 320) {
                if (name === 'production') await evaluate(`document.querySelector('.rlt-config [data-pond-id="pond2"]').scrollIntoView({block:'start'})`);
                await screenshot('rlt-v451-narrow-' + name);
            }
        }
        await evaluate(`document.querySelector('[aria-label="收起助手面板"]').click()`);
    }
    assert.deepEqual(errors, []); console.log('Browser: one-shot execution/stop/resume with trusted mouse and keyboard, run identity/progress, lazy tabs, unique switches, focus/edit preservation, scroll memory, stable dashboard, graph/collapse toggles, desktop/mobile bounds and zero page errors passed.');
    console.log('Mobile: 48px launcher, bottom action hit testing, touch drag/tap, position restoration and narrow/landscape bounds passed.');
    socket.close();
}
if (process.argv.includes('--prepare')) console.log(preview); else main().catch(e => { console.error(e); process.exit(1); });
