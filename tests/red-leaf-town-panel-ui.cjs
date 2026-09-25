const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { fixture, sourcePath } = require('./red-leaf-town-v4.test.cjs');

const preview = path.join(__dirname, 'red-leaf-town-panel-preview.html');
const token = `panel-${Date.now()}`;
const source = fs.readFileSync(sourcePath, 'utf8').replace('if (CONFIG.ui.autoStart) start();',
    `window.__rltPanelPreview = { token: ${JSON.stringify(token)} };`);
fs.writeFileSync(preview, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Panel interaction test</title>
<style>body{margin:0;background:#e8eddf;font:16px system-ui}#game-action{position:fixed;left:190px;top:220px;width:120px;height:50px}</style>
<div id="app"></div><button id="game-action">游戏操作</button><script>
if(sessionStorage.getItem(${JSON.stringify(token)})!=='1'){localStorage.clear();sessionStorage.setItem(${JSON.stringify(token)},'1')}
window.fixtureState=${JSON.stringify(fixture())};
document.querySelector('#app').__vue_app__={_context:{config:{globalProperties:{$pinia:{_s:new Map([['story',{cue(){},active:false,queue:[]}],['game',{state:window.fixtureState,refresh(){}}]])}}}}};
window.fetch=async()=>{throw new Error('Panel preview must not access game network')};
</script><script>${source.replace(/<\/script/gi, '<\\/script')}</script></html>`, 'utf8');

async function main() {
    const pages = await (await fetch('http://127.0.0.1:9236/json/list')).json();
    const page = pages.find(row => row.type === 'page');
    assert.ok(page, 'a Chrome page on debugging port 9236 is required');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const pending = new Map(), errors = [];
    let sequence = 0;
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
        if (!message.id) return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        message.error ? request.reject(message.error) : request.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    async function evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    }
    async function ready() {
        for (let attempt = 0; attempt < 60; attempt++) {
            if (await evaluate(`window.__rltPanelPreview?.token===${JSON.stringify(token)}`)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.fail('panel preview did not initialize');
    }
    async function reload() {
        await evaluate('window.__rltPanelPreview=null');
        await send('Page.reload', { ignoreCache: true });
        await ready();
    }
    const rect = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`);
    const panel = () => rect('#rlt-auto-helper-panel');
    const collapsed = () => evaluate(`document.querySelector('#rlt-auto-helper-panel').classList.contains('rlt-collapsed')`);
    const center = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: expected ${expected}, got ${actual}`);
    function inside(box, width, height) {
        assert.ok(box.left >= 0 && box.top >= 0 && box.right <= width + 1 && box.bottom <= height + 1, `panel must fit ${width}x${height}: ${JSON.stringify(box)}`);
    }
    async function mouse(type, point, buttons = 0) {
        await send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    async function mouseClick(selector) {
        const point = center(await rect(selector));
        await mouse('mouseMoved', point);
        await mouse('mousePressed', point, 1);
        await mouse('mouseReleased', point);
    }
    async function mouseDrag(from, to) {
        await mouse('mouseMoved', from);
        await mouse('mousePressed', from, 1);
        await mouse('mouseMoved', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 1);
        await mouse('mouseMoved', to, 1);
        await mouse('mouseReleased', to);
    }
    async function touch(type, point) {
        await send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ ...point }] });
    }
    async function touchDrag(from, to) {
        await touch('touchStart', from);
        await touch('touchMove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
        await touch('touchMove', to);
        await touch('touchEnd');
    }
    async function enterLauncher() {
        await evaluate(`document.querySelector('.rlt-brand>button').focus()`);
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    try {
        await send('Runtime.enable'); await send('Page.enable');
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: pathToFileURL(preview).href }); await ready();
        assert.equal(await collapsed(), false);

        const initial = await panel(), titlePoint = center(await rect('.rlt-brand strong'));
        await mouseDrag(titlePoint, { x: titlePoint.x - initial.left + 120, y: titlePoint.y - initial.top + 80 });
        const expandedPosition = await panel();
        close(expandedPosition.left, 120, 'desktop title drag left'); close(expandedPosition.top, 80, 'desktop title drag top');
        assert.equal(await collapsed(), false, 'dragging the title does not collapse');

        const buttonPoint = center(await rect('.rlt-brand>button'));
        await mouseDrag(buttonPoint, { x: buttonPoint.x - 100, y: buttonPoint.y + 45 });
        close((await panel()).left, expandedPosition.left, 'buttons do not start a panel drag');
        close((await panel()).top, expandedPosition.top, 'buttons do not move the panel vertically');
        assert.equal(await collapsed(), false);

        await mouseClick('.rlt-brand>button');
        let launcher = await panel();
        assert.equal(await collapsed(), true); assert.equal(launcher.width, 48); assert.equal(launcher.height, 48);
        assert.equal(await evaluate(`document.elementFromPoint(250,245)===document.querySelector('#game-action')`), true, 'desktop collapse frees the expanded panel area');
        assert.equal(await evaluate(`document.querySelector('.rlt-brand>button').getAttribute('aria-expanded')`), 'false');
        await mouseDrag(center(launcher), { x: 204, y: 224 });
        launcher = await panel();
        assert.equal(await collapsed(), true, 'mouse dragging the floating button does not open it');
        close(launcher.left, 180, 'desktop floating button drag left'); close(launcher.top, 200, 'desktop floating button drag top');
        await reload();
        close((await panel()).left, launcher.left, 'collapsed left survives reload'); close((await panel()).top, launcher.top, 'collapsed top survives reload');
        assert.equal((await panel()).width, 48);

        await enterLauncher();
        assert.equal(await collapsed(), false, 'keyboard Enter opens the floating button');
        close((await panel()).left, expandedPosition.left, 'expanded position is separate'); close((await panel()).top, expandedPosition.top, 'expanded top restored');
        await reload();
        assert.equal(await collapsed(), false);
        close((await panel()).left, expandedPosition.left, 'expanded left survives reload'); close((await panel()).top, expandedPosition.top, 'expanded top survives reload');

        await mouseClick('.rlt-brand>button');
        close((await panel()).left, launcher.left, 'collapse restores its own location');
        await mouseDrag(center(await panel()), { x: 1279, y: 899 });
        inside(await panel(), 1280, 900);
        assert.equal(await collapsed(), true);

        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        inside(await panel(), 390, 844);
        await touchDrag(center(await panel()), { x: 124, y: 204 });
        launcher = await panel();
        close(launcher.left, 100, 'touch floating button drag left'); close(launcher.top, 180, 'touch floating button drag top');
        assert.equal(await collapsed(), true, 'touch dragging does not open the floating button');
        await touch('touchStart', center(launcher)); await touch('touchEnd');
        await evaluate('new Promise(resolve=>setTimeout(resolve,350))');
        assert.equal(await collapsed(), false, 'touch tap opens once without a second compatibility click');
        inside(await panel(), 390, 844);

        const mobileBox = await panel(), mobileTitle = center(await rect('.rlt-brand strong'));
        await touchDrag(mobileTitle, { x: mobileTitle.x - mobileBox.left + 8, y: mobileTitle.y - mobileBox.top + 30 });
        close((await panel()).left, 8, 'touch title drag left'); close((await panel()).top, 30, 'touch title drag top');
        assert.equal(await collapsed(), false);
        for (const [width, height] of [[320, 568], [844, 390]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
            await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            inside(await panel(), width, height);
            await enterLauncher();
            assert.equal((await panel()).width, 48); assert.equal((await panel()).height, 48);
            inside(await panel(), width, height);
            await enterLauncher(); inside(await panel(), width, height);
        }
        assert.deepEqual(errors, []);
        console.log('Panel browser tests passed: desktop/mobile 48px floating button, real mouse/touch title dragging, interactive-button exclusion, click/drag separation, keyboard access, independent position persistence, reload, resize and viewport bounds.');
    } finally { socket.close(); }
}

if (process.argv.includes('--prepare')) console.log(preview);
else main().catch(error => { console.error(error); process.exitCode = 1; });
