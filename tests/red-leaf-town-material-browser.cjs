const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { fixture, sourcePath } = require('./red-leaf-town-v4.test.cjs');

const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const preview = path.join(artifacts, 'red-leaf-town-material-preview.html');
const token = `materials-${Date.now()}`;
const state = fixture();
const recipeNames = ['营养饲料', '谷物饲料', '谷物粉', '细磨谷物粉', '分级谷物', '脱壳谷物', '精选谷物', '干燥谷物', '基础谷物'];
const recipes = recipeNames.map((name, index) => ({
    id: `material-${index}`, name, unlocked: true, stamina_cost: 1, duration_seconds: 60, produce_quantity: 1,
    item: { item_id: `material-${index}`, name, sell_price: 10 },
    inputs: [{ item_id: index === recipeNames.length - 1 ? 'wheat' : `material-${index + 1}`, quantity: 2,
        item: { name: index === recipeNames.length - 1 ? '长名称小麦原料ABCDEFGHIJKLMN0123456789需要换行显示' : recipeNames[index + 1] } }],
}));
state.inventory = [{ item_id: 'wheat', name: '小麦', quality: 1, quantity: 3000 }];
state.portals = [{ name: '林间传送门', unlocked: true, tributes: [{ item_id: 'wheat', name: '小麦', quantity: 20, min_quality: 1 }] }];
state.crafting_stations = [{ station_id: 'nutrition', definition: { name: '营养饲料加工坊' }, empty: true, ready: false, recipes, assigned_partner_ids: [] }];
// Synthetic screenshot regression: quantities/costs are fixture data, not a claim about game recipes.
const targetState = structuredClone(state);
const targetRecipe = (id, name, input, inputQuantity, stamina, outputQuantity) => ({ id, name, unlocked: true,
    stamina_cost: stamina, duration_seconds: 60, produce_quantity: outputQuantity, item: { item_id: id, name },
    inputs: [{ item_id: input, quantity: inputQuantity, item: { item_id: input, name: { refined: '精饲料', mixed: '混合饲料', grain: '谷物' }[input] } }] });
const targetRecipes = [targetRecipe('meal', '制作营养饲料', 'refined', 2, 3, 1),
    targetRecipe('refined', '精炼饲料', 'mixed', 2, 2, 2), targetRecipe('mixed', '混合饲料加工', 'grain', 2, 1, 2)];
Object.assign(targetState.player, { stamina: 32, stamina_restore_seconds: 0 });
targetState.inventory = [{ item_id: 'mixed', name: '混合饲料', quality: 0, quantity: 2 }, { item_id: 'grain', name: '谷物', quality: 0, quantity: 100 }];
targetState.portals = [];
targetState.crafting_stations = [{ station_id: 'nutrition', definition: { name: '镇民工坊' }, recipes: targetRecipes,
    empty: false, ready: false, recipe: targetRecipes[2], queue_total: 5, queued_count: 4, completed_count: 0, collected_count: 0,
    task_snapshot: { recipe_id: 'mixed', ready_at: targetState.server_time + 60 }, assigned_partner_ids: [] }];
const exposure = `
const originalMaterialTree = craftMaterialTree;
let materialTreeCalls = 0;
craftMaterialTree = (...args) => { materialTreeCalls++; return originalMaterialTree(...args); };
acceptState(window.fixtureState);
window.__rltMaterialPreview = {
    token: ${JSON.stringify(token)}, CONFIG, runtime, craftMaterialTree, craftRun,
    get calls() { return materialTreeCalls; },
    refresh() { const next = structuredClone(runtime.state); next.server_time++; acceptState(next); getPageStore('game').state = next; refreshConfigRows(next); },
    pause(value) { if (value) stopCraftRun('nutrition'); else startCraftRun(runtime.state, 'nutrition'); refreshConfigRows(runtime.state); },
    tree() { return craftMaterialTree(runtime.state, runtime.state.crafting_stations[0]); },
    targetScenario() {
        setOverride('rlt-craft-paused:nutrition', '');
        setOverride('rlt-node-job:crafting:nutrition', 'meal'); setOverride('rlt-craft-lock-times:nutrition', '10');
        CONFIG.crafting.batchLimit = 3;
        saveCraftFlight('nutrition', { phase: 'active', recipeId: 'mixed', quantity: 5, credited: 0, observedCollected: 0,
            steps: [], stepIndex: 0, dependencyFor: { stationId: 'nutrition', recipeId: 'meal', name: '制作营养饲料' } });
        acceptState(window.targetFixtureState); getPageStore('game').state = runtime.state; refreshConfigRows(runtime.state);
    },
    committedScenario() {
        saveCraftFlight('nutrition', null); stopCraftRun('nutrition');
        setOverride('rlt-craft-lock-times:nutrition', '1');
        const next = structuredClone(window.targetFixtureState), node = next.crafting_stations[0];
        Object.assign(node, { empty: true, task_snapshot: null, recipe: null, queue_total: 0, queued_count: 0 });
        acceptState(next);
        if (!startCraftRun(next, 'nutrition')) throw new Error('one-run fixture could not start');
        saveCraftFlight('nutrition', { phase: 'active', recipeId: 'meal', quantity: 1, credited: 0, observedCollected: 0,
            steps: configuredCraftSteps('nutrition'), stepIndex: 0, runId: craftRun('nutrition').id });
        Object.assign(node, { empty: false, recipe: node.recipes[0], queue_total: 1,
            task_snapshot: { recipe_id: 'meal', ready_at: next.server_time + 216 } });
        getPageStore('game').state = next; refreshConfigRows(next);
    },
    finishScenario() {
        creditCraftFlight('nutrition', 1); saveCraftFlight('nutrition', null);
        const next = structuredClone(runtime.state);
        Object.assign(next.crafting_stations[0], { empty: true, recipe: null, task_snapshot: null, queue_total: 0, collected_count: 1 });
        acceptState(next); getPageStore('game').state = next; refreshConfigRows(next);
    },
};
refreshConfigRows(runtime.state);`;
const source = fs.readFileSync(sourcePath, 'utf8').replace('if (CONFIG.ui.autoStart) start();', exposure);
fs.writeFileSync(preview, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>材料树离线验证</title>
<style>body{margin:0;background:#e8eddf;font:16px system-ui}</style><div id="app"></div><script>
localStorage.clear();localStorage.setItem('rlt-ui-page','crafting');
localStorage.setItem('rlt-node-job:crafting:nutrition','material-0');localStorage.setItem('rlt-craft-lock-times:nutrition','1');
window.fixtureState=${JSON.stringify(state)};window.targetFixtureState=${JSON.stringify(targetState)};window.gameRequests=0;
document.querySelector('#app').__vue_app__={_context:{config:{globalProperties:{$pinia:{_s:new Map([['story',{cue(){},active:false,queue:[]}],['game',{state:window.fixtureState,refresh(){}}]])}}}}};
window.fetch=async()=>{window.gameRequests++;throw new Error('Material preview must not access game network')};
</script><script>${source.replace(/<\/script/gi, '<\\/script')}</script></html>`, 'utf8');

async function main() {
    const pages = await (await fetch('http://127.0.0.1:9236/json/list')).json();
    const page = pages.find(row => row.type === 'page');
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
    async function evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    async function settle() { await evaluate('new Promise(resolve=>setTimeout(resolve,0))'); }
    async function screenshot(name) {
        await evaluate(`document.querySelector('.rlt-material-tree').scrollIntoView({block:'start'})`);
        const clip = await evaluate(`(()=>{const r=document.querySelector('#rlt-auto-helper-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
        const result = await send('Page.captureScreenshot', { format: 'png', clip });
        fs.writeFileSync(path.join(artifacts, `${name}.png`), Buffer.from(result.data, 'base64'));
    }
    async function noOverflow(width) {
        const failures = await evaluate(`Array.from(document.querySelectorAll('#rlt-auto-helper-panel,.rlt-material-tree,.rlt-material-list,.rlt-material-row,.rlt-material-note')).filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1).map(e=>({className:e.className,scroll:e.scrollWidth,client:e.clientWidth}))`);
        assert.deepEqual(failures, [], `${width}px material layout must not overflow horizontally`);
        const box = await evaluate(`(()=>{const r=document.querySelector('#rlt-auto-helper-panel').getBoundingClientRect();return {left:r.left,right:r.right}})()`);
        assert.ok(box.left >= 0 && box.right <= width + 1, `panel must fit ${width}px`);
    }
    try {
        await send('Runtime.enable'); await send('Page.enable');
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: pathToFileURL(preview).href });
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt++) {
            if (await evaluate(`window.__rltMaterialPreview?.token===${JSON.stringify(token)}`)) { ready = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(ready, 'material preview initialized');
        assert.equal(await evaluate('window.__rltMaterialPreview.calls'), 0, 'closed tree avoids display calculations');
        assert.equal(await evaluate(`document.querySelector('.rlt-material-tree').open`), false);
        await evaluate(`document.querySelector('.rlt-material-tree>summary').click()`); await settle();
        assert.equal(await evaluate('window.__rltMaterialPreview.calls'), 1);
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('库存供给')`));
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('背包总量 3,000')`));
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('长名称小麦原料')`));
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('待做路线消耗 511 体力')`));
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('本轮目标 1 次 · 已领取 0 · 已提交待领取 0 · 待开工 1')`));
        assert.equal(await evaluate('window.__rltMaterialPreview.tree().stamina.missing'), 361);
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('体力 256')`));
        assert.ok((await evaluate(`document.querySelectorAll('.rlt-material-row').length`)) >= 18, 'fixture traverses a deep real recipe chain');
        await evaluate(`document.querySelectorAll('.rlt-material-tree details').forEach(detail=>detail.open=true)`); await settle();
        await noOverflow(1280); await screenshot('rlt-material-desktop');

        // A same-turn state refresh occurs before native details toggle events are delivered.
        const branchName = JSON.stringify(recipeNames[3]);
        await evaluate(`(()=>{const summary=Array.from(document.querySelectorAll('summary.rlt-material-row')).find(e=>e.querySelector('.rlt-material-name')?.textContent===${branchName});summary.click();window.__rltMaterialPreview.refresh()})()`);
        await settle();
        assert.equal(await evaluate(`document.querySelector('.rlt-material-tree').open`), true);
        assert.equal(await evaluate(`Array.from(document.querySelectorAll('summary.rlt-material-row')).find(e=>e.querySelector('.rlt-material-name')?.textContent===${branchName}).parentElement.open`), false);
        await evaluate(`window.__rltMaterialPreview.pause(true)`); await settle();
        assert.equal(await evaluate('window.__rltMaterialPreview.tree().preview'), true);
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('当前用料预览')`));
        assert.ok(await evaluate(`document.querySelector('.rlt-material-tree').textContent.includes('用料预览；点击执行后')`));
        assert.equal(await evaluate('window.gameRequests'), 0, 'expansion and paused preview make no game requests');

        for (const width of [390, 320]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
            await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
            await evaluate(`document.querySelectorAll('.rlt-material-tree details').forEach(detail=>detail.open=true)`); await settle();
            await noOverflow(width); await screenshot(`rlt-material-mobile-${width}`);
            await evaluate(`window.__rltMaterialPreview.refresh()`); await settle();
            assert.equal(await evaluate(`document.querySelector('.rlt-material-tree').open`), true);
        }
        await evaluate(`document.querySelector('.rlt-material-tree>summary').click()`); await settle();
        const callsBefore = await evaluate('window.__rltMaterialPreview.calls');
        await evaluate(`window.__rltMaterialPreview.refresh()`); await settle();
        assert.equal(await evaluate('window.__rltMaterialPreview.calls'), callsBefore, 'collapsed tree remains lazy after state refresh');
        assert.equal(await evaluate(`document.querySelector('.rlt-material-tree').open`), false);
        await evaluate('window.__rltMaterialPreview.targetScenario()'); await settle();
        await evaluate(`document.querySelector('.rlt-material-tree>summary').click()`); await settle();
        const target = await evaluate('window.__rltMaterialPreview.tree()');
        assert.equal(target.quantity, 10); assert.equal(target.stamina.cost, 54); assert.equal(target.stamina.missing, 22);
        const targetText = await evaluate(`document.querySelector('.rlt-material-tree').textContent`);
        for (const expected of ['本轮目标 10 次', '待开工 10', '单次最多提交 3 次', '待做路线消耗 54 体力', '加工次数 10', '加工次数 4', '每次至少产出 2']) assert.ok(targetText.includes(expected), expected);
        for (const width of [1280, 320]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
            await evaluate(`document.querySelectorAll('.rlt-material-tree details').forEach(detail=>detail.open=true)`); await settle();
            await noOverflow(width); await screenshot(`rlt-material-target-${width}`);
        }
        // Reproduce the reported 1/1 submitted queue: no fake zero-work recipe or zero-cost label.
        await evaluate('window.__rltMaterialPreview.committedScenario()'); await settle();
        const committed = await evaluate('window.__rltMaterialPreview.tree()');
        assert.equal(committed.phase, 'committed'); assert.equal(committed.root.kind, 'queue');
        const committedText = await evaluate(`document.querySelector('.rlt-material-tree').textContent`);
        for (const expected of ['本轮目标 1 次', '已提交待领次数 1', '体力和材料已在提交时支付']) assert.ok(committedText.includes(expected), expected);
        for (const obsolete of ['加工次数 0', '体力 0', '用料预览', '待做路线消耗 0']) assert.ok(!committedText.includes(obsolete), obsolete);
        const button = `document.querySelector('[data-focus-key="craft:nutrition:execute"]')`;
        assert.equal(await evaluate(`${button}.textContent`), '停止本轮');
        assert.ok(await evaluate(`!!document.querySelector('.rlt-craft-cancel')`));
        for (const width of [1280, 320]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
            await noOverflow(width); await screenshot(`rlt-material-committed-${width}`);
        }
        await evaluate(`${button}.click()`); await settle();
        assert.equal(await evaluate(`${button}.textContent`), '继续本轮');
        assert.equal(await evaluate(`${button}.disabled`), true, 'stopped queue must finish before resuming');
        const previousRun = await evaluate(`window.__rltMaterialPreview.craftRun('nutrition').id`);
        await evaluate('window.__rltMaterialPreview.finishScenario()'); await settle();
        assert.equal(await evaluate(`${button}.textContent`), '再执行一次');
        assert.equal(await evaluate(`window.__rltMaterialPreview.craftRun('nutrition').status`), 'completed');
        await evaluate('window.__rltMaterialPreview.refresh()'); await settle();
        assert.equal(await evaluate(`window.__rltMaterialPreview.craftRun('nutrition').id`), previousRun, 'refresh cannot create another run');
        await evaluate(`${button}.focus();${button}.click()`); await settle();
        assert.equal(await evaluate(`${button}.textContent`), '停止本轮');
        assert.notEqual(await evaluate(`window.__rltMaterialPreview.craftRun('nutrition').id`), previousRun, 'explicit repeat starts a new run');
        assert.equal(await evaluate('document.activeElement.dataset.focusKey'), 'craft:nutrition:execute');
        assert.equal(await evaluate('window.__rltMaterialPreview.tree().goal.collected'), 0);
        assert.equal(await evaluate('window.gameRequests'), 0); assert.deepEqual(errors, []);
        console.log('Material tree browser checks passed: deep chains, complete target budget, committed queue without misleading zeros, stop/complete/restart, focus, 1280/390/320px layouts, zero game requests.');
    } finally { socket.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
