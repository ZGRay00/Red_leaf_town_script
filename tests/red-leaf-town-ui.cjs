const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { fixture, sourcePath } = require('./red-leaf-town-v4.test.cjs');
const preview = path.join(__dirname, 'red-leaf-town-preview.html');
const state = fixture(), now = state.server_time;
state.plots = [{ slot: 0, empty: false, ready: false, ready_at: now + 240, planted_at: now - 360, crop: { name: '南瓜' } }];
state.crops = [{ id: 'pumpkin', name: '南瓜', seed_item_id: 'pumpkin_seed' }];
state.partners = [{ partner_id: 'p1', name: '海风', tendencies: [{ industry: 'aquatic', effective_ability: 45 }] }, { partner_id: 'p2', name: '晨曦' }, { partner_id: 'p3', name: '林间' }];
state.sailing.active_run = { run_id: 'demo', route_name: '芦苇湾', started_at: now - 1500, ready_at: now + 2100, partner_ids: ['p1'] };
Object.assign(state.crafting_stations[0], { empty: false, ready: false, completed_count: 2, queued_count: 5, collected_count: 0, queue_total: 8, queue_remaining_seconds: 320, recipe: state.crafting_stations[0].recipes[0], task_snapshot: { recipe_id: 'flour', ready_at: now + 30, started_at: now - 30 } });
state.crafting_stations.push({ ...structuredClone(state.crafting_stations[0]), station_id: 'kitchen', definition: { name: '小镇厨房' } });
const source = fs.readFileSync(sourcePath, 'utf8').replace('if (CONFIG.ui.autoStart) start();', 'window.__rltPreview = { runtime, refreshConfigRows, renderDashboard, setSetting, getOverride, start, stop, CONFIG }; runtime.state = window.fixtureState; renderDashboard(runtime.state);');
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
    async function screenshot(name) {
        const box = await evaluate(`(()=>{const r=document.querySelector('#rlt-auto-helper-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
        const image = await send('Page.captureScreenshot', { format: 'png', clip: box }); fs.writeFileSync(path.join(__dirname, name + '.png'), Buffer.from(image.data, 'base64'));
    }
    await screenshot('rlt-v4-overview');
    for (const name of ['production', 'crafting', 'sailing', 'feed', 'settings']) {
        await evaluate(`document.querySelector('.rlt-tabs [data-page="${name}"]').click()`);
        const visible = await evaluate(`Array.from(document.querySelectorAll('.rlt-group')).map(e=>e.dataset.page)`);
        assert.ok(visible.length && visible.every(value => value === name), name + ' panel visibility');
        const overflow = await evaluate(`(()=>{const e=document.querySelector('#rlt-auto-helper-panel');return e.scrollWidth-e.clientWidth})()`); assert.ok(overflow <= 1, name + ' horizontal overflow');
        if (['crafting', 'feed', 'sailing'].includes(name)) await screenshot('rlt-v4-' + name);
    }
    // Real browser interaction: a module switch must update its ARIA state and persisted setting.
    await evaluate(`document.querySelector('.rlt-tabs [data-page="feed"]').click()`);
    await evaluate(`Array.from(document.querySelectorAll('[role="switch"]')).find(e=>e.getAttribute('aria-label')==='自动补充饲料').click()`);
    assert.equal(await evaluate(`window.__rltPreview.CONFIG.feed.enabled`), true);
    assert.equal(await evaluate(`document.querySelector('[aria-label="自动补充饲料"]').getAttribute('aria-checked')`), 'true');
    await evaluate(`document.querySelector('[aria-label="自动补充饲料"]').focus();document.activeElement.click()`);
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), '自动补充饲料');
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-checked')`), 'false');
    await evaluate(`document.querySelector('.rlt-tabs [data-page="crafting"]').click();document.querySelector('[data-focus-key="craft:kitchen:submit"]').focus();document.activeElement.click()`);
    assert.equal(await evaluate(`document.activeElement.dataset.focusKey`), 'craft:kitchen:submit');
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-checked')`), 'false');
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
    for (const name of ['overview', 'crafting', 'sailing', 'feed']) {
        await evaluate(`document.querySelector('.rlt-tabs [data-page="${name}"]').click()`);
        assert.equal(await evaluate(`(()=>{const e=document.querySelector('#rlt-auto-helper-panel'),r=e.getBoundingClientRect();return r.right<=innerWidth && r.left>=0 && r.top>=0 && r.bottom<=innerHeight && e.scrollWidth-e.clientWidth<=1})()`), true, name + ' mobile bounds');
    }
    await screenshot('rlt-v4-mobile');
    assert.deepEqual(errors, []); console.log('Browser: lazy tabs, unique switches, focus/edit preservation, scroll memory, stable dashboard, graph/collapse toggles, desktop/mobile bounds and zero page errors passed.');
    socket.close();
}
if (process.argv.includes('--prepare')) console.log(preview); else main().catch(e => { console.error(e); process.exit(1); });
