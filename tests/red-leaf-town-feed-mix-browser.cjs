const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { fixture, sourcePath } = require('./red-leaf-town-v4.test.cjs');

const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const preview = path.join(artifacts, 'red-leaf-town-feed-mix-preview.html'), token = `feed-mix-${Date.now()}`;
const state = fixture();
const products = [['balanced', '均衡饲料', 100, 30], ['grain_feed', '谷物饲料', 100, 80],
    ['pumpkin', '南瓜', 25, 50], ['corn', '玉米', 20, 20], ['wheat', '小麦', 10, 15], ['bean', '大豆', 25, 40]];
state.inventory = products.map(([item_id, name]) => ({ item_id, name, quality: 0, quantity: 70 }));
state.portals = [{ unlocked: true, name: '南瓜门贡', tributes: [{ item_id: 'pumpkin', name: '南瓜', quantity: 10, min_quality: 0 }] }];
Object.assign(state.aquatic.feed_slot, { units: 0, capacity: 1000, quality_score: 0, hourly_rate: 20,
    inputs: products.map(([item_id, name, units, unit_score]) => ({ item_id, item: { name }, quality: 0, units, unit_score, quantity: 70 })) });
const exposure = `
acceptState(window.fixtureState);
window.__rltFeedPreview = {
    token: ${JSON.stringify(token)}, CONFIG, runtime, feedMode, feedPlan, configuredFeedMix, feedBatch, feedSettingsSignature,
    getOverride, setSetting, feedChoices, feedGoal,
    refresh() { const next=structuredClone(runtime.state); next.server_time++; this.state(next); },
    state(next) { acceptState(next); getPageStore('game').state=next; lastConfigState=null; refreshConfigRows(next); },
    render() { lastConfigState=null; refreshConfigRows(runtime.state); },
    batch(phase) { localStorage.setItem('rlt-feed-batch:v1',JSON.stringify({phase,
        remaining:[{itemId:'pumpkin',quality:0,count:2,units:25,score:50}],signature:feedSettingsSignature(),build:detectedGameBuild()})); this.render(); },
};
refreshConfigRows(runtime.state);`;
const source = fs.readFileSync(sourcePath, 'utf8').replace('if (CONFIG.ui.autoStart) start();', exposure);
fs.writeFileSync(preview, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>组合饲料离线验证</title>
<style>body{margin:0;background:#e8eddf;font:16px system-ui}</style><div id="app"></div><script>
localStorage.clear();localStorage.setItem('rlt-ui-page','feed');window.fixtureState=${JSON.stringify(state)};window.gameRequests=0;window.confirmations=[];
document.querySelector('#app').__vue_app__={_context:{config:{globalProperties:{$pinia:{_s:new Map([['story',{cue(){},active:false,queue:[]}],['game',{state:window.fixtureState,refresh(){}}]])}}}}};
window.fetch=async()=>{window.gameRequests++;throw new Error('Feed preview must remain offline')};window.confirm=text=>{window.confirmations.push(text);return true};
</script><script>${source.replace(/<\/script/gi, '<\\/script')}</script></html>`, 'utf8');

async function main() {
    const pages = await (await fetch('http://127.0.0.1:9236/json/list')).json(), page = pages.find(row => row.type === 'page');
    assert.ok(page, 'a Chrome page on debugging port 9236 is required');
    const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(), errors = [];
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
        if (!message.id) return;
        const request = pending.get(message.id); if (!request) return;
        pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    const settle = () => evaluate('new Promise(resolve=>setTimeout(resolve,40))');
    async function change(selector, value, event = 'change') {
        await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing control '+${JSON.stringify(selector)});e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));e.blur();})()`);
        await settle();
    }
    const click = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
    async function screenshot(name, selector = '[data-feed-mix="editor"]') {
        await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`);
        const clip = await evaluate(`(()=>{const r=document.querySelector('#rlt-auto-helper-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
        const result = await send('Page.captureScreenshot', { format: 'png', clip });
        fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(result.data, 'base64'));
    }
    try {
        await send('Runtime.enable'); await send('Page.enable');
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: pathToFileURL(preview).href });
        for (let attempt = 0; attempt < 60; attempt++) {
            if (await evaluate(`window.__rltFeedPreview?.token===${JSON.stringify(token)}`)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(await evaluate(`window.__rltFeedPreview?.token`), token);
        assert.equal(await evaluate(`document.querySelector('[aria-label="投喂方式"]').value`), 'smart');
        assert.equal(await evaluate(`document.querySelector('[aria-label="目标品质分"]').min`), '41');
        assert.equal(await evaluate(`document.querySelector('[aria-label="目标品质分"]').value`), '45');
        assert.equal(await evaluate(`!!document.querySelector('[aria-label="启用品质目标"]')`), false);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-feed-candidate]')].map(e=>e.dataset.feedCandidate).sort()`), ['balanced','grain_feed']);
        await screenshot('rlt-feed-smart-desktop', '[data-feed-candidate]');
        await change('[aria-label="投喂方式"]', 'mix');
        await click('[data-feed-mix-action="add"]');
        await change('[aria-label="组合物品 1"]', 'pumpkin');
        await click('[data-feed-mix-action="add"]');
        await change('[aria-label="组合物品 2"]', 'grain_feed');
        assert.equal(await evaluate(`window.__rltFeedPreview.CONFIG.feed.mix`), '[]', 'draft cannot authorize live automation');
        assert.equal(await evaluate(`document.querySelector('[data-feed-mix-draft]').textContent.includes('草稿尚未应用')`), true);
        assert.equal(await evaluate(`document.querySelector('[aria-label="组合物品 2"] option[value="pumpkin"]').disabled`), true);
        assert.equal(await evaluate(`document.querySelector('[data-feed-mix-row="0"]').textContent.includes('可用 55 / 库存 70 件')`), true, 'portal plus default keep remain unavailable');
        await click('.rlt-tabs [data-page="settings"]'); await click('.rlt-tabs [data-page="feed"]');
        await evaluate(`window.__rltFeedPreview.refresh()`); await settle();
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-feed-mix-row] select')].map(e=>e.value)`), ['pumpkin','grain_feed']);
        await click('[data-feed-mix-action="apply"]');
        assert.deepEqual(await evaluate(`JSON.parse(window.__rltFeedPreview.CONFIG.feed.mix)`), [{ itemId:'pumpkin',weight:50 },{ itemId:'grain_feed',weight:50 }]);
        const allocation = await evaluate(`(()=>{const a=window.__rltFeedPreview,p=a.feedPlan(a.runtime.state,800);return {feasible:p.feasible,quality:p.quality,units:p.units,deposits:p.deposits.map(x=>({id:x.input.item_id,count:x.count,units:x.count*x.input.units}))}})()`);
        assert.equal(allocation.feasible, true); assert.equal(allocation.quality, 65); assert.equal(allocation.units, 800);
        assert.deepEqual(allocation.deposits.sort((a,b)=>a.id.localeCompare(b.id)), [{ id:'grain_feed',count:4,units:400 },{ id:'pumpkin',count:16,units:400 }]);
        assert.equal(await evaluate(`document.querySelector('[data-feed-preview]').textContent.includes('南瓜 × 16 件 · 400 份 · 占 50%')`), true);
        assert.equal(await evaluate(`document.querySelector('[data-feed-preview]').textContent.includes('0 → 65')`), true);
        await change('[data-feed-mix-weight="0"]', '25', 'input'); await change('[data-feed-mix-weight="1"]', '75', 'input');
        assert.equal(await evaluate(`document.querySelector('[data-feed-mix-row="0"]').textContent.includes('25%')`), true);
        assert.equal(await evaluate(`JSON.parse(window.__rltFeedPreview.CONFIG.feed.mix)[0].weight`), 50);
        await click('[data-feed-mix-action="cancel"]');
        assert.equal(await evaluate(`document.querySelector('[data-feed-mix-weight="0"]').value`), '50');
        // Invalid/duplicate drafts must never be persisted, including programmatic change events.
        await change('[aria-label="组合物品 2"]', 'pumpkin');
        assert.equal(await evaluate(`document.querySelector('[data-feed-mix-action="apply"]').disabled`), true);
        await click('[data-feed-mix-action="cancel"]');
        for (let index = 0; index < 4; index++) await click('[data-feed-mix-action="add"]');
        assert.equal(await evaluate(`document.querySelectorAll('[data-feed-mix-row]').length`), 6);
        assert.equal(await evaluate(`document.querySelector('[data-feed-mix-action="add"]').disabled`), true);
        await click('[data-feed-mix-action="cancel"]');
        // Removing current stock metadata retains the configured item identity and reports waiting.
        await evaluate(`(()=>{const a=window.__rltFeedPreview,s=structuredClone(a.runtime.state);s.aquatic.feed_slot.inputs=s.aquatic.feed_slot.inputs.filter(i=>i.item_id!=='pumpkin');a.state(s)})()`); await settle();
        assert.equal(await evaluate(`document.querySelector('[aria-label="组合物品 1"]').value`), 'pumpkin');
        assert.equal(await evaluate(`document.querySelector('[data-feed-mix-row="0"]').textContent.includes('每件份数与单位品质分待确认')`), true);
        assert.equal(await evaluate(`document.querySelector('[data-feed-preview]').textContent.includes('等待')`), true);
        await evaluate(`window.__rltFeedPreview.state(structuredClone(window.fixtureState))`); await settle();
        await evaluate(`window.__rltFeedPreview.batch('uncertain')`); await settle();
        assert.equal(await evaluate(`!!document.querySelector('[data-feed-batch-reset]')`), true);
        await evaluate(`window.confirm=text=>{window.confirmations.push(text);return false}`);
        await click('[data-feed-batch-reset]');
        assert.equal(await evaluate(`window.__rltFeedPreview.feedBatch().phase`), 'uncertain');
        await evaluate(`window.confirm=text=>{window.confirmations.push(text);return true}`);
        await click('[data-feed-batch-reset]');
        assert.equal(await evaluate(`window.__rltFeedPreview.feedBatch()`), null);
        assert.equal(await evaluate(`window.confirmations.every(text=>text.includes('不会重发旧请求'))`), true);
        await evaluate(`window.__rltFeedPreview.batch('ready')`); await settle();
        await click('[data-feed-batch-abandon]');
        assert.equal(await evaluate(`window.__rltFeedPreview.feedBatch()`), null);
        assert.equal(await evaluate(`window.confirmations.at(-1).includes('已投入的饲料不会退回')`), true);
        await change('[aria-label="投喂方式"]', 'single');
        await change('[aria-label="投喂物品"]', 'pumpkin');
        assert.equal(await evaluate(`window.__rltFeedPreview.CONFIG.feed.itemId`), 'pumpkin');
        await change('[aria-label="投喂方式"]', 'mix');
        // The full editor, controls and preview must fit all supported panel widths.
        for (const width of [1280,390,320]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 }); await settle();
            const overflow = await evaluate(`(()=>{const selectors=['#rlt-auto-helper-panel','.rlt-config','[data-feed-mix="editor"]','[data-feed-preview]'];return selectors.map(s=>{const e=document.querySelector(s);return [s,e.scrollWidth-e.clientWidth]})})()`);
            assert.ok(overflow.every(([,amount])=>amount<=1), `horizontal overflow at ${width}: ${JSON.stringify(overflow)}`);
            await screenshot(`rlt-feed-mix-${width}`);
            await screenshot(`rlt-feed-mix-preview-${width}`, '[data-feed-preview]');
        }
        assert.equal(await evaluate('window.gameRequests'), 0, 'configuration and preview cannot write game state');
        assert.deepEqual(errors, []);
        console.log('Feed mix browser: smart/single/mix, atomic drafts, ratios, safeguards, recovery and 320/390/desktop layouts passed.');
    } finally { socket.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
