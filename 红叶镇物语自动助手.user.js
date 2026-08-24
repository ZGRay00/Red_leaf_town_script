// ==UserScript==
// @name         红叶镇物语 · 自动农场助手
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  红叶镇物语自动收菜/种菜、采集、采矿、加工、每日委托循环脚本（基于游戏自身 API）
// @author       -
// @match        https://chiyuki.diving-fish.com/red-leaf-town/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_KEY = '__redLeafTownAutoHelperV2__';
    if (window[INSTANCE_KEY]) return; // 防止同一页面重复注入两套面板和循环
    window[INSTANCE_KEY] = { version: '2.1.0' };

    /******************** 配置区 ********************/
    const CONFIG = {
        // 空闲时的最短轮询间隔（毫秒）；有任务在进行时会自动对齐到完成时间，无事可做时用 maxPollInterval
        pollInterval: 15000,
        // 无事可做时的最长轮询间隔（毫秒）
        maxPollInterval: 120000,
        // 单次请求超时；写请求超时后只重新同步状态，不会盲目重试
        requestTimeout: 20000,
        // 单轮写操作安全上限，防止异常状态造成死循环
        maxActionsPerTick: 80,
        // 同一浏览器只允许一个标签页执行自动化
        singleTab: true,
        // 官网前端构建变化时暂停写操作，避免接口结构变化后误操作
        expectedBuild: 'index-Cb6HilJh.js',
        pauseOnBuildChange: true,
        // 剧情结束后给 /story/:id/seen 留出回写奖励 state 的时间
        storySyncGrace: 1200,

        farming: {
            enabled: true,            // 自动收获 + 种菜
            cropId: null,             // 指定作物 id；null = 自动选择
            strictCropId: true,       // 指定作物无种子/不可种时等待，不偷偷改种其他作物
            prefer: 'first',          // 自动选择策略: 'first' 列表第一种 | 'fastest' 生长最快 | 'slowest' 生长最慢
            autoBuySeeds: true,       // 没种子时自动去商店买（逐粒按需购买；金币不足时按 selling 白名单安全售卖凑钱）
            autoSellForSeeds: true,   // 买种子金币不足时，自动售卖多余物资凑钱（配合 autoBuySeeds）
            seedStrategy: 'portal',   // 种植/购买策略: 'portal' 传送门需求优先，满足后按经济价值 | 'profit' 始终按经济价值最高
            seedShopId: null,         // 可选：强制指定商店条目 id，优先级最高
            taskItemId: null,         // 可选：开工时使用的 start 型任务道具 id；null = 不使用
            autoAssignPartner: true,  // 自动派驻/优化驻场伙伴（有更强的空闲伙伴时自动更换）
        },

        gathering: {
            enabled: true,            // 林野采集：自动领取 + 重新开工
            taskId: null,             // 指定任务 id；null = 用该点第一个可接任务
            strictTaskId: true,       // 指定任务不存在时等待，不回退到其他任务
            taskItemId: null,         // 可选：开工时使用的 start 型任务道具 id
            autoAssignPartner: true,  // 采集必须派驻伙伴：自动安排/优化驻场伙伴
        },

        mining: {
            enabled: true,            // 矿山采矿：自动收取 + 重新开工
            taskId: null,             // 指定任务 id；null = 用该点第一个可接任务
            strictTaskId: true,
            taskItemId: null,
            autoAssignPartner: true,  // 自动派驻/优化协助伙伴（不设则会独自采矿）
        },

        crafting: {
            enabled: false,           // 加工：会消耗背包材料，默认关闭，需要时打开
            recipeId: null,           // 指定配方 id；null = 用第一个配方
            strictRecipeId: true,
            taskItemId: null,
            autoAssignPartner: true,  // 自动派驻/优化协助伙伴
        },

        commissions: {
            enabled: true,            // 每日委托
            autoSubmit: true,         // 库存够时自动交付今日委托（奖励枫火）
            autoTake: true,           // 自动从转发池接单（只动超出传送门/自委托需求的富余物资）
            maxTakesPerTick: 5,       // 单轮最多安全接单次数
        },

        selling: {
            // 显式正向白名单；默认空数组表示不允许自动售卖任何物品。
            allowedItemIds: [],
            // 可选：把当前 state 中可识别的农作/采集/采矿产物并入白名单。稀有产物也可能被识别，默认关闭。
            inferredOutputWhitelist: false,
            neverSellItemIds: [],     // 永不售卖的物品 id
            keepByItemId: {},         // 每种物品最低保留量，例如 { 123: 20 }
            defaultKeep: 5,           // 白名单物品默认至少保留数量
            maxUnitsPerTick: 20,      // 单轮最多卖出数量
            protectLockedPortals: true,
            protectCraftingInputs: true,
        },

        partnerMinImprovement: 0.05, // 非必需岗位换人至少提升 5%，避免频繁抖动

        rosterScanOnStart: true,      // 启动时自动扫描并打印角色库
    };
    /****************** 配置区结束 ******************/

    const API = '/api/red-leaf-town';

    // ---------- 权威状态与请求层 ----------
    const runtime = {
        state: null,
        controller: null,
        actionCount: 0,
        soldUnits: 0,
        stateUncertain: false,
        serverMsAtSync: 0,
        monotonicMsAtSync: 0,
        storyWasBusy: false,
        storyGraceUntil: 0,
    };

    class ApiError extends Error {
        constructor(message, { status = 0, code = 'network_error', retryAfter = null, cause } = {}) {
            super(message, { cause });
            this.name = 'ApiError';
            this.status = status;
            this.code = code;
            this.retryAfter = retryAfter;
        }
    }

    function acceptState(state) {
        if (!state || typeof state !== 'object' || !Array.isArray(state.inventory)) {
            throw new ApiError('服务器返回的 state 结构不完整，已停止本轮操作', { code: 'invalid_state' });
        }
        validateStateSchema(state);
        runtime.state = state;
        runtime.serverMsAtSync = Number(state.server_time || 0) * 1000;
        runtime.monotonicMsAtSync = performance.now();
        return state;
    }

    function serverNowSeconds() {
        if (!runtime.serverMsAtSync) return Math.floor(Date.now() / 1000);
        return Math.floor((runtime.serverMsAtSync + performance.now() - runtime.monotonicMsAtSync) / 1000);
    }

    function getPageStore(id) {
        try {
            const app = document.querySelector('#app')?.__vue_app__;
            const pinia = app?._context?.config?.globalProperties?.$pinia;
            return pinia?._s?.get(id) || null;
        } catch (_) {
            return null;
        }
    }

    function detectedGameBuild() {
        for (const script of document.scripts) {
            const match = script.src?.match(/\/red-leaf-town\/assets\/(index-[^/?#]+\.js)(?:[?#]|$)/);
            if (match) return match[1];
        }
        return null;
    }

    function validateClientEnvironment() {
        const build = detectedGameBuild();
        if (CONFIG.pauseOnBuildChange && build && build !== CONFIG.expectedBuild) {
            throw new ApiError(`检测到游戏官网已更新（${build}），助手预期 ${CONFIG.expectedBuild}，已安全暂停`, {
                code: 'unknown_build',
            });
        }
        const story = getPageStore('story');
        if (typeof story?.cue !== 'function') {
            throw new ApiError('无法连接游戏官网剧情系统，已安全暂停，避免遗漏剧情奖励', {
                code: 'invalid_story_bridge',
            });
        }
    }

    function validateStateSchema(state) {
        const errors = [];
        const requireArray = (key, enabled = true) => {
            if (enabled && !Array.isArray(state[key])) errors.push(key);
        };
        if (!state.player || typeof state.player !== 'object') errors.push('player');
        requireArray('inventory');
        requireArray('plots', CONFIG.farming.enabled);
        requireArray('crops', CONFIG.farming.enabled);
        requireArray('shop', CONFIG.farming.enabled && CONFIG.farming.autoBuySeeds);
        requireArray('gathering_sites', CONFIG.gathering.enabled);
        requireArray('mining_sites', CONFIG.mining.enabled);
        const needsSafeInventory = CONFIG.commissions.autoTake ||
            (CONFIG.farming.autoBuySeeds && CONFIG.farming.autoSellForSeeds);
        requireArray('crafting_stations', CONFIG.crafting.enabled ||
            (needsSafeInventory && CONFIG.selling.protectCraftingInputs));
        requireArray('portals', needsSafeInventory || CONFIG.farming.seedStrategy === 'portal');
        if (CONFIG.commissions.enabled && (!state.commissions || typeof state.commissions !== 'object')) {
            errors.push('commissions');
        }
        const needsPartners = CONFIG.farming.autoAssignPartner || CONFIG.gathering.autoAssignPartner ||
            CONFIG.mining.autoAssignPartner || CONFIG.crafting.autoAssignPartner;
        requireArray('partners', needsPartners);

        if (Array.isArray(state.plots) && state.plots.some(plot => plot.slot == null)) errors.push('plots[].slot');
        if (Array.isArray(state.gathering_sites) &&
            state.gathering_sites.some(site => site.site_id == null || !Array.isArray(site.available_tasks))) {
            errors.push('gathering_sites[]');
        }
        if (Array.isArray(state.mining_sites) &&
            state.mining_sites.some(site => site.site_id == null || !Array.isArray(site.available_tasks))) {
            errors.push('mining_sites[]');
        }
        if (CONFIG.crafting.enabled && Array.isArray(state.crafting_stations) &&
            state.crafting_stations.some(station => station.station_id == null || !Array.isArray(station.recipes))) {
            errors.push('crafting_stations[]');
        }
        if (errors.length) {
            throw new ApiError(`state 字段不兼容：${[...new Set(errors)].join(', ')}`, { code: 'invalid_state' });
        }
    }

    function officialStoryBusy() {
        const story = getPageStore('story');
        return Boolean(story?.active || story?.queue?.length);
    }

    // 剧情关闭时 /story/:id/seen 是异步回写；留出短暂窗口后再重新拉 state。
    function storyBlockDelay() {
        if (officialStoryBusy()) {
            runtime.storyWasBusy = true;
            runtime.storyGraceUntil = 0;
            return 1000;
        }
        if (runtime.storyWasBusy) {
            runtime.storyWasBusy = false;
            runtime.storyGraceUntil = performance.now() + CONFIG.storySyncGrace;
        }
        return Math.max(0, runtime.storyGraceUntil - performance.now());
    }

    function ensureStoryIdle() {
        const delay = storyBlockDelay();
        if (delay > 0) throw new ApiError('剧情播放或奖励同步中', { code: 'story_active', retryAfter: delay });
    }

    async function emitOfficialStoryCue(cue) {
        if (!cue) return false;
        const story = getPageStore('story');
        if (typeof story?.cue !== 'function') {
            throw new ApiError('剧情接口不可用', { code: 'invalid_story_bridge' });
        }
        await Promise.resolve(story.cue(cue));
        return officialStoryBusy();
    }

    function isControlFlowError(error) {
        return error?.code === 'aborted' || error?.code === 'story_active';
    }

    function requestController(parentSignal) {
        const controller = new AbortController();
        let timedOut = false;
        const abortFromParent = () => controller.abort(parentSignal?.reason || new DOMException('已停止', 'AbortError'));
        if (parentSignal?.aborted) abortFromParent();
        else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(new DOMException('请求超时', 'TimeoutError'));
        }, CONFIG.requestTimeout);
        return {
            signal: controller.signal,
            timedOut: () => timedOut,
            cleanup: () => {
                clearTimeout(timeout);
                parentSignal?.removeEventListener('abort', abortFromParent);
            },
        };
    }

    // 与游戏前端一致：同源 cookie 会话 + JSON；保留 status/code 供调度层判断。
    async function api(path, { method = 'GET', payload, signal = runtime.controller?.signal } = {}) {
        const linked = requestController(signal);
        try {
            const resp = await fetch(API + path, {
                method,
                credentials: 'same-origin',
                headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: payload === undefined ? undefined : JSON.stringify(payload),
                signal: linked.signal,
            });
            const json = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                const retryHeader = resp.headers.get('Retry-After');
                const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : null;
                throw new ApiError(json.message || `请求失败 (${resp.status})`, {
                    status: resp.status,
                    code: json.code || 'http_error',
                    retryAfter,
                });
            }
            if (!Object.prototype.hasOwnProperty.call(json, 'data')) {
                throw new ApiError('服务器响应缺少 data 字段', { status: resp.status, code: 'invalid_response' });
            }
            return json.data;
        } catch (e) {
            if (e instanceof ApiError) throw e;
            if (linked.timedOut()) {
                throw new ApiError('请求超时', { code: 'request_timeout', cause: e });
            }
            if (signal?.aborted) throw new ApiError('操作已停止', { code: 'aborted', cause: e });
            throw new ApiError('网络错误：无法连接红叶镇', { code: 'network_error', cause: e });
        } finally {
            linked.cleanup();
        }
    }

    async function getState({ signal = runtime.controller?.signal } = {}) {
        const state = acceptState(await api('/state', { signal }));
        runtime.stateUncertain = false;
        return state;
    }

    // 官网写接口返回 { state, result }；state 是唯一真相源，禁止手工猜测库存/体力/任务状态。
    async function mutate(path, { method = 'POST', payload, cue } = {}) {
        if (!running || !runtime.controller || runtime.controller.signal.aborted) {
            throw new ApiError('操作已停止', { code: 'aborted' });
        }
        if (runtime.stateUncertain) await getState();
        ensureStoryIdle();
        runtime.actionCount += 1;
        if (runtime.actionCount > CONFIG.maxActionsPerTick) {
            throw new ApiError(`单轮操作超过 ${CONFIG.maxActionsPerTick} 次，已触发安全保护`, { code: 'action_limit' });
        }
        let data;
        try {
            data = await api(path, { method, payload });
        } catch (e) {
            // 网络失败/超时后写入结果可能不确定：绝不重发，必须先重新同步状态。
            if (['network_error', 'request_timeout', 'invalid_response'].includes(e.code)) {
                runtime.stateUncertain = true;
            }
            if (runtime.stateUncertain && runtime.controller && !runtime.controller.signal.aborted) {
                try { await getState(); } catch (_) { /* 下一轮仍会先 GET /state */ }
            }
            throw e;
        }
        if (data?.state) acceptState(data.state);
        else await getState();
        markDirty();
        await emitOfficialStoryCue(cue);
        return data?.result;
    }

    const plantPlot = (slot, cropId, taskItemId = '') => mutate(`/plots/${slot}/plant`, {
        payload: { crop_id: cropId, task_item_id: taskItemId || '' }, cue: 'action:plant',
    });
    const harvestPlot = (slot) => mutate(`/plots/${slot}/harvest`, { cue: 'action:harvest' });
    const buyItem = (shopId, qty = 1) => mutate('/shop/buy', {
        payload: { shop_id: shopId, quantity: qty }, cue: 'action:buy',
    });
    const sellItem = (itemId, qty, quality = 0) =>
        mutate(`/inventory/${itemId}/sell`, { payload: { quantity: qty, quality }, cue: 'action:sell' });
    const siteUrl = (industry, siteId) => `/${industry}/${industry === 'crafting' ? 'stations' : 'sites'}/${siteId}`;
    const startSite = (industry, siteId, payloadKey, id, taskItemId = '') =>
        mutate(`${siteUrl(industry, siteId)}/start`, {
            payload: { [payloadKey]: id, task_item_id: taskItemId || '' }, cue: `action:start_${industry}`,
        });
    const collectSite = (industry, siteId) => mutate(`${siteUrl(industry, siteId)}/collect`, {
        cue: `action:collect_${industry}`,
    });
    const assignSitePartner = (industry, siteId, partnerId) =>
        mutate(`${siteUrl(industry, siteId)}/partner`, { method: 'PUT', payload: { partner_id: partnerId ?? '' } });
    const assignPlotPartner = (slot, partnerId) =>
        mutate(`/plots/${slot}/partners`, { method: 'PUT', payload: { partner_id: partnerId ?? '' } });
    const submitCommission = () => mutate('/commissions/submit', { cue: 'action:submit_commission' });
    const getCommissionBoard = () => api('/commissions/board');
    const takeCommission = (commissionId) => mutate(`/commissions/${commissionId}/take`);

    // ---------- 小面板 ----------
    const panel = document.createElement('div');
    panel.id = 'rlt-auto-helper-panel';
    panel.style.cssText = [
        'position:fixed', 'right:12px', 'bottom:12px', 'z-index:99999',
        'background:rgba(23,33,27,.92)', 'color:#e8e0cf', 'font:12px/1.6 monospace',
        'border:1px solid #8ead71', 'border-radius:8px', 'padding:8px 10px',
        'max-width:320px',
    ].join(';');
    const toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = 'margin-right:8px;padding:2px 10px;cursor:pointer;background:#8ead71;border:none;border-radius:4px;color:#17211b;font-weight:bold';
    const rosterBtn = document.createElement('button');
    rosterBtn.textContent = '伙伴库';
    rosterBtn.title = '扫描并打印当前角色库';
    rosterBtn.style.cssText = 'margin-right:8px;padding:2px 10px;cursor:pointer;background:#78906d;border:none;border-radius:4px;color:#17211b;font-weight:bold';
    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '—';
    collapseBtn.title = '收起/展开面板';
    collapseBtn.style.cssText = 'margin-right:8px;padding:2px 8px;cursor:pointer;background:#555f52;border:none;border-radius:4px;color:#e8e0cf;font-weight:bold';
    const statusLine = document.createElement('span');
    statusLine.style.cursor = 'move'; // 按住状态行可拖动面板
    statusLine.title = '按住可拖动面板';
    const logBox = document.createElement('div');
    // 只有日志区滚动，按钮行始终固定在面板顶部
    logBox.style.cssText = 'margin-top:6px;white-space:pre-wrap;opacity:.85;max-height:32vh;overflow-y:auto';
    panel.appendChild(toggleBtn);
    panel.appendChild(rosterBtn);
    panel.appendChild(collapseBtn);
    panel.appendChild(statusLine);

    // 槽位配置区：每块土地/采集点/矿点/加工站各一行下拉，选择记忆在 localStorage
    const configBox = document.createElement('div');
    configBox.style.cssText = 'margin-top:6px;border-top:1px solid #555f52;padding-top:2px';
    panel.appendChild(configBox);
    panel.appendChild(logBox);
    document.body.appendChild(panel);

    // ---------- 槽位级覆盖配置（localStorage 记忆） ----------
    function getOverride(key) {
        const v = localStorage.getItem(key);
        return v === null || v === '' ? null : v;
    }
    function setOverride(key, value) { localStorage.setItem(key, value || ''); }
    const plotCropKey = slot => `rlt-plot-crop:${slot}`;
    const nodeJobKey = (industry, id) => `rlt-node-job:${industry}:${id}`;
    const plotCropOverride = slot => getOverride(plotCropKey(slot));
    const nodeJobOverride = (industry, id) => getOverride(nodeJobKey(industry, id));

    function makeSelectRow(labelText, title) {
        const row = document.createElement('div');
        row.style.cssText = 'margin-top:4px;display:flex;align-items:center;gap:6px';
        const label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText = 'opacity:.8;white-space:nowrap';
        const select = document.createElement('select');
        select.style.cssText = 'flex:1;max-width:230px;background:#17211b;color:#e8e0cf;border:1px solid #555f52;border-radius:4px;font:11px monospace;padding:1px 4px';
        if (title) select.title = title;
        row.appendChild(label);
        row.appendChild(select);
        return { row, select };
    }

    // 填充下拉并恢复当前选择；目标暂时不在列表时保留锁定项，不悄悄恢复自动
    function fillSelect(select, options, current, autoText) {
        select.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = autoText;
        select.appendChild(auto);
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = String(o.value);
            opt.textContent = o.text;
            if (o.disabled) opt.disabled = true;
            select.appendChild(opt);
        }
        if (current != null) {
            select.value = String(current);
            if (select.value !== String(current)) {
                const opt = document.createElement('option');
                opt.value = String(current);
                opt.textContent = `锁定目标 #${current}（当前不可用）`;
                select.appendChild(opt);
                select.value = String(current);
            }
        }
    }

    // 每轮用最新 state 重建槽位配置行（选项来自实时 state，选择从 localStorage 恢复）
    function refreshConfigRows(state) {
        if (configBox.contains(document.activeElement)) return; // 用户正在操作下拉时不动它
        configBox.innerHTML = '';
        if (CONFIG.farming.enabled) {
            // 未解锁的土地不在 state.plots 里，额外补一行“下一块地”，便于提前锁定作物（解锁后沿用同一 key）
            const slots = (state.plots || []).map(p => p.slot);
            if (slots.length) slots.push(Math.max(...slots) + 1);
            for (const slot of slots) {
                const key = plotCropKey(slot);
                const { row, select } = makeSelectRow(`土地${slot + 1}:`, '选择这块地要种的作物；「自动」按传送门/委托需求 > 经济价值选择');
                fillSelect(select, (state.crops || []).map(c => ({
                    value: cropId(c), text: c.name || `作物#${cropId(c)}`,
                })), getOverride(key), '自动');
                select.onchange = () => {
                    setOverride(key, select.value);
                    log(`土地 ${slot + 1}：${select.value ? '已锁定作物' : '恢复自动选种'}`);
                };
                configBox.appendChild(row);
            }
        }
        for (const industry of ['mining', 'crafting']) {
            const adapter = INDUSTRY_ADAPTERS[industry];
            if (!adapter.config().enabled) continue;
            for (const node of industryNodes(state, industry)) {
                const id = adapter.id(node);
                if (id == null) continue;
                const key = nodeJobKey(industry, id);
                const nodeName = node.definition?.name || id;
                const label = `${INDUSTRY_NAMES[industry] || industry}·${nodeName}:`;
                const { row, select } = makeSelectRow(label,
                    industry === 'crafting' ? '选择这个加工站的配方；「自动」按需求/价值选择' : '选择这个点位的任务；「自动」按需求/价值选择');
                fillSelect(select, [
                    { value: '__off', text: '关闭（此点位不开工）' },
                    ...adapter.jobs(node).map(j => ({
                        value: jobId(j),
                        text: `${j.name || '任务#' + jobId(j)}${j.stamina_cost ? `（体力${j.stamina_cost}）` : ''}${industry === 'crafting' && j.unlocked === false ? '（未解锁）' : ''}`,
                        disabled: industry === 'crafting' && j.unlocked === false,
                    })),
                ], getOverride(key), '自动');
                select.onchange = () => {
                    setOverride(key, select.value);
                    const what = select.value === '__off' ? '已关闭' : (select.value ? '已锁定目标' : '恢复自动选择');
                    log(`${INDUSTRY_NAMES[industry] || industry}点 ${nodeName}：${what}`);
                };
                configBox.appendChild(row);
            }
        }
    }

    // 收起/展开（记住选择）
    let collapsed = localStorage.getItem('rlt-helper-collapsed') === '1';
    function applyCollapsed() {
        logBox.style.display = collapsed ? 'none' : '';
        configBox.style.display = collapsed ? 'none' : '';
        statusLine.style.display = collapsed ? 'none' : '';
        collapseBtn.textContent = collapsed ? '+' : '—';
    }
    collapseBtn.onclick = () => {
        collapsed = !collapsed;
        localStorage.setItem('rlt-helper-collapsed', collapsed ? '1' : '0');
        applyCollapsed();
    };
    applyCollapsed();

    // 拖动面板
    statusLine.addEventListener('pointerdown', (e) => {
        const rect = panel.getBoundingClientRect();
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        const move = (ev) => {
            panel.style.left = Math.max(0, ev.clientX - dx) + 'px';
            panel.style.top = Math.max(0, ev.clientY - dy) + 'px';
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });
    rosterBtn.onclick = async () => {
        try {
            scanRoster(await getState());
        } catch (e) {
            log(`扫描失败：${e.message}`);
        }
    };

    function log(msg) {
        const time = new Date().toLocaleTimeString();
        const line = document.createElement('div');
        line.textContent = `[${time}] ${msg}`;
        logBox.prepend(line);
        while (logBox.children.length > 30) logBox.lastChild.remove();
    }

    // ---------- 自动化逻辑 ----------
    let running = false;
    let timer = null;
    let busy = false; // 防止上一轮还没跑完又开新一轮
    let rosterScanned = false; // 角色库是否已自动扫描过

    // ---------- 操作后同步游戏界面 ----------
    let dirty = false;
    function markDirty() { dirty = true; }

    // 触发游戏自带的 state 刷新（调用页面 Pinia store 的 refresh，而非刷新网页）
    async function refreshGameUI() {
        try {
            const app = document.querySelector('#app')?.__vue_app__;
            const pinia = app?._context?.config?.globalProperties?.$pinia;
            const store = pinia?._s?.get('game');
            if (typeof store?.refresh === 'function') {
                await Promise.resolve(store.refresh());
                clearSkip('fail:ui-refresh');
                return true;
            }
        } catch (e) {
            logSkip('fail:ui-refresh', `游戏界面同步失败：${e.message || e}`);
        }
        return false;
    }

    // ---------- 体力估算 ----------

    // 用服务器时钟偏移估算实时体力；同一轮中时间也会继续前进。
    function liveStamina(state) {
        const p = state.player;
        if (!p) return Infinity;
        const base = p.stamina ?? 0;
        const restore = p.stamina_restore_seconds || 0;
        if (!restore) return base;
        const regen = Math.floor(Math.max(0, serverNowSeconds() - (p.stamina_updated_at || 0)) / restore);
        return Math.min(p.stamina_cap ?? Infinity, base + regen);
    }

    // 体力恢复到 target 还要多少秒；无法估算返回 null
    function staminaWaitSeconds(state, target) {
        const p = state.player;
        if (!p || !p.stamina_restore_seconds) return null;
        if (target > (p.stamina_cap ?? Infinity)) return Infinity;
        const cur = liveStamina(state);
        if (cur >= target) return 0;
        const elapsed = Math.max(0, serverNowSeconds() - (p.stamina_updated_at || 0));
        const partial = elapsed % p.stamina_restore_seconds;
        return Math.max(0, (target - cur) * p.stamina_restore_seconds - partial);
    }

    // 本轮因体力不足未能开工所需的最低体力（tick 开始时重置，pickTask 里记录）
    let pendingStaminaCost = null;

    // ---------- 自适应调度 ----------

    // 根据 state 算下次唤醒时间：对齐最近的任务完成时刻，无事可做则用上限
    function nextDelay(state) {
        const now = serverNowSeconds();
        let wait = Infinity;
        const consider = (readyAt) => {
            if (readyAt && readyAt > now) wait = Math.min(wait, readyAt - now);
        };
        for (const p of state.plots || []) {
            if (!p.empty && !p.ready) consider(p.ready_at ?? p.task_snapshot?.ready_at);
        }
        for (const group of [state.gathering_sites, state.mining_sites, state.crafting_stations]) {
            for (const s of group || []) {
                if (!s.empty && !s.ready) consider(s.task_snapshot?.ready_at ?? s.ready_at);
            }
        }
        // 有因体力不足停工的点：对齐体力恢复时间
        if (pendingStaminaCost != null) {
            const sw = staminaWaitSeconds(state, pendingStaminaCost);
            if (sw != null && isFinite(sw)) wait = Math.min(wait, sw);
        }
        if (!isFinite(wait)) return CONFIG.maxPollInterval;
        // +2s 缓冲，且不低于 pollInterval、不超过 maxPollInterval
        return Math.min(CONFIG.maxPollInterval, Math.max(CONFIG.pollInterval, Math.ceil(wait * 1000) + 2000));
    }

    function sameId(a, b) {
        return a != null && b != null && String(a) === String(b);
    }

    function seedQty(state, crop) {
        return (state.inventory || [])
            .filter(i => sameId(i.item_id, crop.seed_item_id))
            .reduce((sum, i) => sum + Number(i.quantity || 0), 0);
    }

    function inventoryQty(state, itemId, name = '', minQuality = 0) {
        return (state.inventory || [])
            .filter(i => itemId != null ? sameId(i.item_id, itemId) : (!!name && i.name === name))
            .filter(i => Number(i.quality || 0) >= Number(minQuality || 0))
            .reduce((sum, i) => sum + Number(i.quantity || 0), 0);
    }

    function cropId(crop) { return crop?.id ?? crop?.crop_id; }
    function cropProduceItemId(crop) {
        return crop?.produce_item_id ?? crop?.produce?.item_id ?? crop?.item?.item_id ?? crop?.item_id ?? null;
    }
    function cropProduceName(crop) {
        return crop?.produce?.name ?? crop?.item?.name ?? crop?.name ?? '';
    }

    // ---------- 经济价值评估 ----------

    // 官网同款时长公式，包含任务的 minimum_duration_seconds。
    function calcSeconds(base, difficulty, ability, minimum = 1) {
        const b = Number(base);
        const d = Number(difficulty || 0);
        const a = Math.max(0, Number(ability || 0));
        if (!Number.isFinite(b) || b <= 0) return null;
        const sum = a + d;
        const factor = sum > 0 ? 1 + 2 * a / sum : 1;
        return Math.max(Number(minimum || 1), Math.ceil(b / factor));
    }

    function calcDraws(draws, ability) {
        if (!draws) return 0;
        const n = Math.max(0, Number(ability || 0));
        const difficulty = Number(draws.difficulty || 1);
        const scale = 1 + Number(draws.ability_bonus || 0) * n / (n + difficulty);
        return Math.max(1, Math.floor(Number(draws.base_draws || 1) * scale + .5));
    }

    function itemMetadata(state, itemId, name = '') {
        const matches = item => item && (itemId != null ? sameId(item.item_id, itemId) : (!!name && item.name === name));
        for (const item of state.inventory || []) if (matches(item)) return item;
        for (const entry of state.shop || []) if (matches(entry.item)) return entry.item;
        for (const site of [...(state.gathering_sites || []), ...(state.mining_sites || [])]) {
            for (const task of site.available_tasks || []) {
                if (matches(task.item)) return task.item;
                for (const out of task.outputs || []) if (matches(out.item || out)) return out.item || out;
            }
        }
        for (const station of state.crafting_stations || []) {
            for (const recipe of station.recipes || []) {
                if (matches(recipe.item)) return recipe.item;
                for (const input of recipe.inputs || []) if (matches(input.item || input)) return input.item || input;
            }
        }
        return null;
    }

    function itemSellPrice(state, itemId, name = '', fallback) {
        const raw = fallback ?? itemMetadata(state, itemId, name)?.sell_price;
        if (raw == null || raw === '') return null;
        const price = Number(raw);
        return Number.isFinite(price) ? price : null;
    }

    function assignedPartner(state, obj) {
        const embedded = (obj?.assigned_partners || [])[0];
        if (embedded) return embedded;
        const pid = (obj?.assigned_partner_ids || [])[0];
        return pid == null ? null : (state.partners || []).find(p => sameId(p.partner_id ?? p.id, pid)) || null;
    }

    function farmingAbility(state, plot = null) {
        const base = Number(state.industry_rules?.farming?.character_base_ability || 0);
        const partner = plot ? assignedPartner(state, plot) : null;
        return base + (partner ? partnerAbility(partner, 'farming') : 0);
    }

    function cropHourlyProfit(state, crop, ability = 0) {
        const produceId = cropProduceItemId(crop);
        const producePrice = itemSellPrice(state, produceId, cropProduceName(crop), crop.produce_sell_price ?? crop.produce?.sell_price ?? crop.item?.sell_price);
        const shopEntry = (state.shop || []).find(e => sameId(shopEntryItemId(e), crop.seed_item_id));
        const seedRaw = crop.seed_price ?? shopEntry?.price;
        if (producePrice == null || seedRaw == null) return null;
        const seedPrice = Number(seedRaw);
        if (!Number.isFinite(seedPrice)) return null;
        const minYield = Number(crop.yield_min ?? 1);
        const maxYield = Number(crop.yield_max ?? minYield);
        const seconds = calcSeconds(crop.growth_seconds, crop.time_difficulty, ability);
        if (!seconds) return null;
        return (((minYield + maxYield) / 2) * producePrice - seedPrice) / (seconds / 3600);
    }

    function bestCrop(state, crops, plot = null) {
        const ability = farmingAbility(state, plot);
        const scored = crops
            .map(crop => ({ crop, value: cropHourlyProfit(state, crop, ability) }))
            .filter(x => x.value != null)
            .sort((a, b) => b.value - a.value);
        if (scored.length) return scored[0].crop;
        const list = [...crops];
        if (CONFIG.farming.prefer === 'fastest') list.sort((a, b) => Number(a.growth_seconds || Infinity) - Number(b.growth_seconds || Infinity));
        if (CONFIG.farming.prefer === 'slowest') list.sort((a, b) => Number(b.growth_seconds || 0) - Number(a.growth_seconds || 0));
        return list[0] || null;
    }

    // ---------- 需求、在途产量与安全库存 ----------

    function commissionActive(cm) {
        return !!cm && !cm.settled &&
            cm.status !== 'forwarded' && cm.status !== 'forward_completed' && cm.status !== 'completed';
    }

    function gatherNeeds(state, { productionOnly = false } = {}) {
        const needs = [];
        for (const portal of state.portals || []) {
            if (portal.completed || (productionOnly && !portal.unlocked) || (!portal.unlocked && !CONFIG.selling.protectLockedPortals)) continue;
            for (const tr of portal.tributes || []) {
                const need = Number(tr.quantity || 0) - Number(tr.delivered || 0);
                if (tr.completed || need <= 0) continue;
                needs.push({
                    source: 'portal', itemId: tr.item_id ?? null, name: tr.name || '',
                    minQuality: Number(tr.min_quality || 0), need, portal, tribute: tr,
                });
            }
        }
        const cm = state.commissions?.commission;
        if (commissionActive(cm)) {
            needs.unshift({
                source: 'commission', itemId: cm.item_id ?? cm.item?.item_id ?? null,
                name: cm.item?.name || '', minQuality: 0, need: Number(cm.quantity || 0), commission: cm,
            });
        }
        return needs;
    }

    function needMatchesItem(need, item) {
        return need.itemId != null ? sameId(need.itemId, item.item_id) : (!!need.name && need.name === item.name);
    }

    function cropMatchesNeed(crop, need) {
        const produceId = cropProduceItemId(crop);
        return need.itemId != null ? sameId(produceId, need.itemId) : (!!need.name && cropProduceName(crop) === need.name);
    }

    function inFlightCropQty(state, need) {
        if (need.minQuality > 0) return 0; // 品质尚未结算，不能把在途作物当作保证库存
        let qty = 0;
        for (const plot of state.plots || []) {
            if (plot.empty || !plot.crop || !cropMatchesNeed(plot.crop, need)) continue;
            qty += Math.max(1, Number(plot.crop.yield_min ?? 1));
        }
        return qty;
    }

    function needShortage(state, need) {
        return Math.max(0, need.need
            - inventoryQty(state, need.itemId, need.name, need.minQuality)
            - inFlightCropQty(state, need)
            - inFlightIndustryGuaranteedQty(state, need));
    }

    function findCropForNeed(state, need) {
        return (state.crops || []).find(c => cropMatchesNeed(c, need)) || null;
    }

    function chooseCropTarget(state, plot) {
        const cfg = CONFIG.farming;
        // 槽位级指定作物优先于全局 cropId；锁定后不回退其他作物，但失败只跳过本块地，不中断其余土地
        const plotWanted = plot ? plotCropOverride(plot.slot) : null;
        if (plotWanted != null) {
            const crop = (state.crops || []).find(c => sameId(cropId(c), plotWanted));
            if (crop) return { crop, reason: '槽位指定作物' };
            return { blocked: `槽位指定作物 #${plotWanted} 当前不可用` };
        }
        if (cfg.cropId != null) {
            const crop = (state.crops || []).find(c => sameId(cropId(c), cfg.cropId));
            if (crop) return { crop, reason: '指定作物', strict: cfg.strictCropId };
            return { blocked: `指定作物 #${cfg.cropId} 当前不可用`, strict: cfg.strictCropId };
        }

        if (CONFIG.commissions.enabled || cfg.seedStrategy !== 'profit') {
            for (const need of gatherNeeds(state, { productionOnly: true })) {
                if (need.source === 'portal' && cfg.seedStrategy === 'profit') continue;
                const shortage = needShortage(state, need);
                if (shortage <= 0) continue;
                const crop = findCropForNeed(state, need);
                if (!crop) continue;
                const canBuy = CONFIG.farming.autoBuySeeds &&
                    seedShopEntries(state).some(e => sameId(shopEntryItemId(e), crop.seed_item_id));
                if (seedQty(state, crop) <= 0 && !canBuy) {
                    logSkip(`need:no-seed:${need.itemId ?? need.name}`, `${need.name || need.itemId} 有缺口，但当前没有对应种子来源`);
                    continue;
                }
                const reason = need.source === 'commission'
                    ? `今日委托缺 ${need.name || need.itemId} ×${shortage}`
                    : `传送门「${need.portal?.name || need.portal?.portal_id || ''}」缺 ${need.name} ×${shortage}`;
                return { crop, reason, need };
            }
        }

        const buyableSeeds = new Set(seedShopEntries(state).map(e => String(shopEntryItemId(e))));
        const candidates = (state.crops || []).filter(c => seedQty(state, c) > 0 ||
            (cfg.autoBuySeeds && buyableSeeds.has(String(c.seed_item_id))));
        const crop = bestCrop(state, candidates, plot);
        if (crop) {
            // 记录本次估值表，便于核对“为什么选它”
            const ability = farmingAbility(state, plot);
            const table = candidates.map(c => {
                const v = cropHourlyProfit(state, c, ability);
                return `${c.name || '作物#' + cropId(c)}=${v == null ? '缺价' : v.toFixed(2)}`;
            }).join(' ');
            log(`作物估值（土地 ${plot.slot + 1}，能力 ${ability}）：${table} → 选 ${crop.name || cropId(crop)}`);
            return { crop, reason: '经济价值最高' };
        }
        // 诊断：定位“没有可用或可购买的种子”时商店/作物的实际结构
        const shopSample = (state.shop || []).slice(0, 6)
            .map(e => `${e.id}:${e.item?.name || '?'}(item_id=${shopEntryItemId(e)},kind=${e.item?.kind},locked=${!!e.locked},price=${e.price})`)
            .join(' ');
        const cropSample = (state.crops || []).slice(0, 6)
            .map(c => `${c.name || cropId(c)}(seed=${c.seed_item_id},库存=${seedQty(state, c)})`)
            .join(' ');
        logSkip('seed:diag', `诊断｜autoBuySeeds=${cfg.autoBuySeeds} 可购种子条目=${buyableSeeds.size}｜商店[${(state.shop || []).length}]: ${shopSample || '空'}｜作物[${(state.crops || []).length}]: ${cropSample || '空'}`);
        return { blocked: '没有可用或可购买的种子' };
    }

    // 商店条目的物品 id：优先内嵌 item.item_id，缺失时退到条目 id（种子条目的 id 即物品 id，如 wheat_seed）
    function shopEntryItemId(entry) {
        return entry?.item?.item_id ?? entry?.item_id ?? entry?.id ?? null;
    }

    function seedShopEntries(state) {
        return (state.shop || []).filter(e =>
            shopEntryItemId(e) != null && !e.locked &&
            (state.crops || []).some(c => sameId(c.seed_item_id, shopEntryItemId(e))));
    }

    function playerCoins(state) { return Number(state.player?.coins || 0); }

    function inferredSellItemIds(state) {
        const ids = new Set();
        if (!CONFIG.selling.inferredOutputWhitelist) return ids;
        for (const crop of state.crops || []) {
            const id = cropProduceItemId(crop);
            if (id != null) ids.add(String(id));
        }
        for (const site of [...(state.gathering_sites || []), ...(state.mining_sites || [])]) {
            for (const task of site.available_tasks || []) {
                const direct = task.item_id ?? task.item?.item_id;
                if (direct != null) ids.add(String(direct));
                for (const out of task.outputs || []) {
                    const id = out.item_id ?? out.item?.item_id;
                    if (id != null) ids.add(String(id));
                }
            }
        }
        return ids;
    }

    function craftingInputIds(state) {
        const ids = new Set();
        for (const station of state.crafting_stations || []) {
            for (const recipe of station.recipes || []) {
                for (const input of recipe.inputs || []) {
                    const id = input.item_id ?? input.item?.item_id;
                    if (id != null) ids.add(String(id));
                }
            }
        }
        return ids;
    }

    function configuredKeep(itemId) {
        const explicit = CONFIG.selling.keepByItemId?.[String(itemId)];
        return Math.max(0, Number(explicit ?? CONFIG.selling.defaultKeep ?? 0));
    }

    // 为一个物品的全部品质栈统一分配需求：高门槛需求优先，使用最低可满足品质。
    function reservedStacksForItem(state, stacks) {
        const needs = gatherNeeds(state).filter(n => stacks.some(item => needMatchesItem(n, item)))
            .sort((a, b) => b.minQuality - a.minQuality);
        const rows = stacks.map(item => ({ item, free: Number(item.quantity || 0), reserved: 0 }))
            .sort((a, b) => Number(a.item.quality || 0) - Number(b.item.quality || 0));
        for (const need of needs) {
            let remaining = need.need;
            for (const row of rows) {
                if (remaining <= 0) break;
                if (Number(row.item.quality || 0) < need.minQuality) continue;
                const take = Math.min(row.free, remaining);
                row.free -= take;
                row.reserved += take;
                remaining -= take;
            }
        }
        let keep = configuredKeep(stacks[0]?.item_id);
        for (const row of rows) {
            if (keep <= 0) break;
            const take = Math.min(row.free, keep);
            row.free -= take;
            row.reserved += take;
            keep -= take;
        }
        return rows;
    }

    function computeSellables(state) {
        const whitelist = new Set((CONFIG.selling.allowedItemIds || []).map(String));
        for (const id of inferredSellItemIds(state)) whitelist.add(id);
        const never = new Set((CONFIG.selling.neverSellItemIds || []).map(String));
        const craftingInputs = CONFIG.selling.protectCraftingInputs ? craftingInputIds(state) : new Set();
        const groups = new Map();
        for (const item of state.inventory || []) {
            const key = String(item.item_id);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }
        const sellables = [];
        for (const [key, stacks] of groups) {
            if (!whitelist.has(key) || never.has(key) || craftingInputs.has(key)) continue;
            for (const row of reservedStacksForItem(state, stacks)) {
                const price = Number(row.item.sell_price || 0);
                if (price > 0 && row.free > 0) sellables.push({ item: row.item, surplus: row.free, price });
            }
        }
        sellables.sort((a, b) => b.price - a.price || Number(a.item.quality || 0) - Number(b.item.quality || 0));
        return sellables;
    }

    // 接单/加工接口不指定品质：按“服务器优先扣最高品质”的最坏情况计算仍可安全消耗多少。
    function safeUnspecifiedConsumeQty(state, itemId, name = '') {
        const stacks = (state.inventory || []).filter(i => itemId != null ? sameId(i.item_id, itemId) : i.name === name);
        if (!stacks.length) return 0;
        const needs = gatherNeeds(state).filter(n => stacks.some(item => needMatchesItem(n, item)));
        const thresholds = new Set([0, ...needs.map(n => Number(n.minQuality || 0))]);
        let safe = Infinity;
        for (const q of thresholds) {
            const eligible = stacks.filter(i => Number(i.quality || 0) >= q)
                .reduce((sum, i) => sum + Number(i.quantity || 0), 0);
            const required = needs.filter(n => Number(n.minQuality || 0) >= q)
                .reduce((sum, n) => sum + n.need, 0);
            safe = Math.min(safe, eligible - required);
        }
        safe = Math.min(safe, inventoryQty(state, itemId, name) - configuredKeep(itemId));
        return Math.max(0, Math.floor(safe));
    }

    async function autoSellForCoins(target) {
        while (playerCoins(runtime.state) < target && runtime.soldUnits < CONFIG.selling.maxUnitsPerTick) {
            const candidate = computeSellables(runtime.state)[0];
            if (!candidate) break;
            const needCoins = target - playerCoins(runtime.state);
            const qty = Math.min(
                candidate.surplus,
                CONFIG.selling.maxUnitsPerTick - runtime.soldUnits,
                Math.ceil(needCoins / candidate.price),
            );
            if (qty <= 0) break;
            const item = candidate.item;
            await sellItem(item.item_id, qty, Number(item.quality || 0));
            runtime.soldUnits += qty;
            clearSkip(`fail:sell:${item.item_id}:${item.quality || 0}`);
            log(`已安全卖出 ${item.quality_name || ''}${item.name} ×${qty}，目标金币 ${target}`);
        }
        const ok = playerCoins(runtime.state) >= target;
        if (!ok) logSkip('seed:poor', `金币仍不足（${playerCoins(runtime.state)}/${target}），安全售卖额度或白名单物资不足`);
        return ok;
    }

    async function buySeedForCrop(crop, reason) {
        let state = runtime.state;
        const cfg = CONFIG.farming;
        let entry = null;
        if (cfg.seedShopId != null) {
            const forced = (state.shop || []).find(e => sameId(e.id, cfg.seedShopId));
            if (forced && sameId(shopEntryItemId(forced), crop.seed_item_id) && !forced.locked) entry = forced;
            else logSkip('seed:bad-forced-shop', `指定商店条目 #${cfg.seedShopId} 不是目标作物的可用种子`);
        }
        entry ||= seedShopEntries(state).find(e => sameId(shopEntryItemId(e), crop.seed_item_id)) || null;
        if (!entry) {
            logSkip(`seed:unavailable:${cropId(crop)}`, `${crop.name || '目标作物'} 没有可购买的种子`);
            return false;
        }
        const price = Number(entry.price || 0);
        if (playerCoins(state) < price && cfg.autoSellForSeeds) {
            log(`金币不足（${playerCoins(state)}/${price}），尝试安全售卖以购买 1 粒种子...`);
            await autoSellForCoins(price);
            state = runtime.state;
        }
        if (playerCoins(state) < price) return false;
        await buyItem(entry.id, 1); // 按需逐粒购买，避免为了填满所有空地过度变卖
        clearSkip('seed:poor');
        clearSkip(`seed:unavailable:${cropId(crop)}`);
        log(`已购买 ${entry.item?.name || entry.id} ×1（${reason}，花费 ${price}）`);
        return true;
    }

    // ---------- 每日委托 ----------

    function surplusQty(state, itemId, name) {
        return safeUnspecifiedConsumeQty(state, itemId, name);
    }

    // 转发池接单：读取当前协议的 entries；每成功一单都接管新 state 并重新读取池子。
    async function tryTakeCommission() {
        let taken = 0;
        while (taken < CONFIG.commissions.maxTakesPerTick &&
               Number(runtime.state.commissions?.remaining_takes || 0) > 0) {
            let board;
            try {
                board = await getCommissionBoard();
            } catch (e) {
                if (isControlFlowError(e)) throw e;
                logSkip('fail:commission:board', `读取委托转发池失败：${e.message}`);
                return;
            }
            clearSkip('fail:commission:board');
            const list = Array.isArray(board)
                ? board
                : (board?.entries ?? board?.commissions ?? board?.list ?? board?.items ?? []);
            const candidates = list
                .filter(x => x.can_take)
                .sort((a, b) => Number(b.taker_reward || 0) - Number(a.taker_reward || 0));
            let success = false;
            for (const x of candidates) {
                const itemId = x.item_id ?? x.item?.item_id ?? null;
                const name = x.item?.name || x.name || '';
                const qty = Number(x.quantity ?? x.required ?? 1);
                if (itemId == null || qty <= 0) continue;
                if (surplusQty(runtime.state, itemId, name) < qty) continue;
                try {
                    await takeCommission(x.commission_id);
                    clearSkip(`fail:commission:take:${x.commission_id}`);
                    log(`已安全接单：${x.owner_name || x.npc_name || '镇民'} · ${name || itemId} ×${qty}（+${x.taker_reward ?? '?'} 枫火）`);
                    taken += 1;
                    success = true;
                    break;
                } catch (e) {
                    if (isControlFlowError(e)) throw e;
                    logSkip(`fail:commission:take:${x.commission_id}`, `接单失败：${e.message}`);
                }
            }
            if (!success) return;
        }
    }

    async function doCommissions() {
        const cfg = CONFIG.commissions;
        if (!cfg.enabled) return;
        let c = runtime.state.commissions;
        if (!c || !c.unlocked) return;
        const cm = c.commission;
        // 1. 自动交付今日委托
        if (cm && cfg.autoSubmit && !cm.settled && cm.can_submit) {
            try {
                await submitCommission();
                clearSkip('fail:commission:submit');
                log(`已交付今日委托：${cm.npc_name || 'NPC'} 的 ${cm.item?.name || cm.item_id} ×${cm.quantity}（+${cm.reward_maple_flame ?? '?'} 枫火${c.lucky_today ? '，幸运日加成' : ''}）`);
            } catch (e) {
                if (isControlFlowError(e)) throw e;
                logSkip('fail:commission:submit', `交付委托失败：${e.message}`);
            }
        }
        // 2. 自动从转发池接单
        c = runtime.state.commissions;
        if (cfg.autoTake && (c.remaining_takes ?? 0) > 0 && c.board_available) {
            await tryTakeCommission();
        }
    }

    function rememberStaminaNeed(state, cost, label) {
        const n = Number(cost || 0);
        const cap = Number(state.player?.stamina_cap ?? Infinity);
        if (n > cap) {
            logSkip(`stamina:impossible:${label}:${n}`, `${label}：需要体力 ${n}，超过上限 ${cap}，无法执行`);
            return false;
        }
        pendingStaminaCost = pendingStaminaCost == null ? n : Math.min(pendingStaminaCost, n);
        return true;
    }

    async function collectReadyPlots() {
        if (!CONFIG.farming.enabled) return;
        const slots = (runtime.state.plots || []).filter(p => p.ready && !p.empty).map(p => p.slot);
        for (const slot of slots) {
            const plot = (runtime.state.plots || []).find(p => p.slot === slot);
            if (!plot || !plot.ready || plot.empty) continue;
            try {
                await harvestPlot(slot);
                clearSkip(`fail:harvest:${slot}`);
                log(`土地 ${slot + 1}：已收获`);
            } catch (e) {
                if (isControlFlowError(e)) throw e;
                logSkip(`fail:harvest:${slot}`, `土地 ${slot + 1} 收获失败：${e.message}`);
            }
        }
    }

    async function plantEmptyPlots() {
        const cfg = CONFIG.farming;
        if (!cfg.enabled) return;
        const slots = (runtime.state.plots || []).filter(p => p.empty).map(p => p.slot);
        for (const slot of slots) {
            let state = runtime.state;
            let plot = (state.plots || []).find(p => p.slot === slot);
            if (!plot?.empty) continue;
            const target = chooseCropTarget(state, plot);
            if (!target.crop) {
                logSkip(`crop:blocked:${target.blocked}`, `土地 ${slot + 1}：${target.blocked || '没有可种作物'}`);
                if (target.strict) return;
                continue;
            }
            const { crop, reason } = target;
            const cost = Number(crop.stamina_cost || 0);
            if (cost > liveStamina(state)) {
                rememberStaminaNeed(state, cost, `种植 ${crop.name || cropId(crop)}`);
                logSkip(`stamina:farming:${slot}`, `土地 ${slot + 1}：体力不足，等待种植 ${crop.name || cropId(crop)}`);
                continue;
            }
            clearSkip(`stamina:farming:${slot}`);

            if (seedQty(state, crop) <= 0) {
                if (!cfg.autoBuySeeds) {
                    logSkip(`seed:disabled:${cropId(crop)}`, `${crop.name || '目标作物'} 没有种子（可开启 autoBuySeeds）`);
                    if (target.strict) return;
                    continue;
                }
                if (!await buySeedForCrop(crop, reason)) {
                    if (target.strict) return;
                    continue;
                }
                state = runtime.state;
                plot = (state.plots || []).find(p => p.slot === slot);
                if (!plot?.empty || seedQty(state, crop) <= 0) continue;
            }

            try {
                await plantPlot(slot, cropId(crop));
                clearSkip(`fail:plant:${slot}`);
                clearSkip(`seed:disabled:${cropId(crop)}`);
                log(`土地 ${slot + 1}：种下 ${crop.name || '作物#' + cropId(crop)}（${reason}）`);
            } catch (e) {
                if (isControlFlowError(e)) throw e;
                logSkip(`fail:plant:${slot}`, `土地 ${slot + 1} 种植失败：${e.message}`);
            }
        }
    }

    function isPartnerIdle(p) {
        return !p.locked && !p.missing &&
            p.assigned_plot_slot == null &&
            p.assigned_gathering_site_id == null &&
            p.assigned_mining_site_id == null &&
            p.assigned_crafting_station_id == null;
    }

    // 伙伴必须具有对应产业的倾向（tendencies）才能派驻
    function hasTendency(p, industry) {
        return (p.tendencies || []).some(t => t.industry === industry);
    }

    // 伙伴在某产业的有效能力值（前端同款公式：effective_ability ?? current_ability）
    function partnerAbility(p, industry) {
        const t = (p.tendencies || []).find(x => x.industry === industry);
        return t ? (t.effective_ability ?? t.current_ability ?? 0) : 0;
    }

    // ---------- 产业字段适配 ----------
    const INDUSTRY_ADAPTERS = {
        gathering: {
            stateKey: 'gathering_sites', id: node => node.site_id,
            jobs: node => node.available_tasks || [], payloadKey: 'task_id',
            config: () => CONFIG.gathering, strictKey: 'strictTaskId', requiresPartner: true,
        },
        mining: {
            stateKey: 'mining_sites', id: node => node.site_id,
            jobs: node => node.available_tasks || [], payloadKey: 'task_id',
            config: () => CONFIG.mining, strictKey: 'strictTaskId', requiresPartner: false,
        },
        crafting: {
            stateKey: 'crafting_stations', id: node => node.station_id,
            jobs: node => node.recipes || [], payloadKey: 'recipe_id',
            config: () => CONFIG.crafting, strictKey: 'strictRecipeId', requiresPartner: false,
        },
    };

    function industryNodes(state, industry) {
        const adapter = INDUSTRY_ADAPTERS[industry];
        return adapter ? (state[adapter.stateKey] || []) : [];
    }

    function nodeById(state, industry, id) {
        const adapter = INDUSTRY_ADAPTERS[industry];
        return industryNodes(state, industry).find(node => sameId(adapter.id(node), id)) || null;
    }

    function nodeJobs(industry, node) {
        return INDUSTRY_ADAPTERS[industry]?.jobs(node) || [];
    }

    function jobId(job) { return job?.recipe_id ?? job?.id; }

    function siteHasPartner(site) {
        return (site.assigned_partner_ids || []).length > 0 || (site.assigned_partners || []).length > 0;
    }

    function nodeDifficulty(industry, node) {
        return Math.max(0, ...nodeJobs(industry, node)
            .map(job => Number(job.difficulty ?? job.time_difficulty ?? job.yield_difficulty ?? 0)));
    }

    function currentPartnerId(node) {
        return (node?.assigned_partner_ids || [])[0] ?? (node?.assigned_partners || [])[0]?.partner_id ?? null;
    }

    function managedPartnerSlots(state) {
        const slots = [];
        if (CONFIG.farming.enabled && CONFIG.farming.autoAssignPartner) {
            for (const plot of state.plots || []) {
                if (!plot.empty || plot.assignment_locked) continue;
                slots.push({
                    key: `farming:${plot.slot}`, industry: 'farming', id: plot.slot,
                    label: `土地 ${plot.slot + 1}`, node: plot, mandatory: false,
                    difficulty: Math.max(0, ...(state.crops || []).map(c => Number(c.time_difficulty || 0))),
                    assign: pid => assignPlotPartner(plot.slot, pid),
                });
            }
        }
        for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
            const adapter = INDUSTRY_ADAPTERS[industry];
            const cfg = adapter.config();
            if (!cfg.enabled || !cfg.autoAssignPartner) continue;
            for (const node of industryNodes(state, industry)) {
                if (!node.empty || node.task_snapshot || node.assignment_locked) continue;
                const id = adapter.id(node);
                if (id == null) {
                    logSkip(`schema:id:${industry}`, `${industry} 节点缺少 id，已跳过派驻`);
                    continue;
                }
                if (nodeJobOverride(industry, id) === '__off') continue; // 手动关闭的点位不占用伙伴编制
                slots.push({
                    key: `${industry}:${id}`, industry, id,
                    label: `${INDUSTRY_NAMES[industry] || industry}点 ${id}`, node,
                    mandatory: adapter.requiresPartner, difficulty: nodeDifficulty(industry, node),
                    assign: pid => assignSitePartner(industry, id, pid),
                });
            }
        }
        return slots;
    }

    // 全产业统一规划，采集硬约束优先；允许空闲节点之间换岗，避免农田抢走唯一采集伙伴。
    async function optimizePartnerAssignments() {
        const state = runtime.state;
        const allSlots = managedPartnerSlots(state);
        if (!allSlots.length) return;
        const mutableCurrentIds = new Set(allSlots.map(s => currentPartnerId(s.node)).filter(x => x != null).map(String));
        const selectedSlots = [];
        for (const industry of ['gathering', 'mining', 'crafting', 'farming']) {
            const industrySlots = allSlots.filter(s => s.industry === industry)
                .sort((a, b) => Number(b.mandatory) - Number(a.mandatory) || b.difficulty - a.difficulty);
            const mutableAssigned = new Set(industrySlots.map(s => currentPartnerId(s.node)).filter(x => x != null).map(String)).size;
            const fixed = Math.max(0, assignedCount(state, industry) - mutableAssigned);
            const cap = industryCapacity(state, industry);
            const available = cap === Infinity ? industrySlots.length : Math.max(0, cap - fixed);
            selectedSlots.push(...industrySlots.slice(0, available));
        }

        const partners = (state.partners || []).filter(p => {
            const pid = String(p.partner_id ?? p.id);
            return !p.missing && (isPartnerIdle(p) || mutableCurrentIds.has(pid));
        });
        const edges = [];
        for (const slot of selectedSlots) {
            const current = assignedPartner(state, slot.node);
            const currentAbility = current ? partnerAbility(current, slot.industry) : 0;
            for (const partner of partners) {
                if (!hasTendency(partner, slot.industry)) continue;
                const pid = partner.partner_id ?? partner.id;
                const ability = partnerAbility(partner, slot.industry);
                const same = sameId(pid, currentPartnerId(slot.node));
                if (!slot.mandatory && current && !same &&
                    ability < currentAbility * (1 + CONFIG.partnerMinImprovement)) continue;
                const hardPriority = slot.mandatory ? 1e9 :
                    ({ mining: 3e6, crafting: 2e6, farming: 1e6 }[slot.industry] || 0);
                const stability = same ? 1e5 : 0;
                const weight = hardPriority + stability + ability * (1000 + slot.difficulty);
                edges.push({ slot, partner, pid, weight });
            }
        }
        edges.sort((a, b) => b.weight - a.weight);
        const desired = new Map();
        const usedPartners = new Set();
        for (const edge of edges) {
            const pid = String(edge.pid);
            if (desired.has(edge.slot.key) || usedPartners.has(pid)) continue;
            desired.set(edge.slot.key, edge.pid);
            usedPartners.add(pid);
        }

        // 先释放所有需要移动的可调整岗位，响应 state 会逐次确认真实编制。
        for (const slot of allSlots) {
            const current = currentPartnerId(slot.node);
            const target = desired.get(slot.key) ?? null;
            if (current == null || sameId(current, target)) continue;
            try {
                await slot.assign(null);
                clearSkip(`fail:unassign:${slot.key}`);
            } catch (e) {
                if (isControlFlowError(e)) throw e;
                logSkip(`fail:unassign:${slot.key}`, `${slot.label} 释放伙伴失败：${e.message}`);
            }
        }

        const ordered = [...selectedSlots].sort((a, b) => Number(b.mandatory) - Number(a.mandatory) || b.difficulty - a.difficulty);
        for (const slot of ordered) {
            const target = desired.get(slot.key);
            if (target == null) {
                if (slot.mandatory) logSkip(`nopartner:${slot.key}`, `${slot.label}：没有可用的对应倾向伙伴`);
                continue;
            }
            const currentNode = slot.industry === 'farming'
                ? (runtime.state.plots || []).find(p => p.slot === slot.id)
                : nodeById(runtime.state, slot.industry, slot.id);
            if (!currentNode || sameId(currentPartnerId(currentNode), target)) continue;
            try {
                await slot.assign(target);
                clearSkip(`fail:assign:${slot.key}`);
                clearSkip(`nopartner:${slot.key}`);
                const partner = (runtime.state.partners || []).find(p => sameId(p.partner_id ?? p.id, target));
                log(`${slot.label}：派驻 ${partner?.name || '伙伴#' + target}（${INDUSTRY_NAMES[slot.industry] || slot.industry} ${partner ? partnerAbility(partner, slot.industry) : '?'}）`);
            } catch (e) {
                if (isControlFlowError(e)) throw e;
                logSkip(`fail:assign:${slot.key}`, `${slot.label} 派驻伙伴失败：${e.message}`);
            }
        }
    }

    // 产业编制的伙伴容量（state.industry_rules.<industry>.partner_capacity）
    function industryCapacity(state, industry) {
        const cap = state.industry_rules?.[industry]?.partner_capacity;
        return cap == null ? Infinity : cap;
    }

    const ASSIGN_FIELD = {
        farming: 'assigned_plot_slot',
        gathering: 'assigned_gathering_site_id',
        mining: 'assigned_mining_site_id',
        crafting: 'assigned_crafting_station_id',
    };

    // 当前已派驻到该产业的伙伴数
    function assignedCount(state, industry) {
        const field = ASSIGN_FIELD[industry];
        return (state.partners || []).filter(p => p[field] != null).length;
    }

    // 跳过类提示去重：同一原因只提示一次，条件解除后允许再次提示
    const skipNotices = new Set();
    function logSkip(key, msg) {
        if (skipNotices.has(key)) return;
        skipNotices.add(key);
        log(msg);
    }
    function clearSkip(key) { skipNotices.delete(key); }

    function jobDurationSeconds(job, ability) {
        if (Object.prototype.hasOwnProperty.call(job, 'yield_difficulty')) {
            const fixed = Number(job.duration_seconds || 1);
            return Number.isFinite(fixed) ? Math.max(1, fixed) : null;
        }
        return calcSeconds(job.duration_seconds, job.time_difficulty, ability, job.minimum_duration_seconds ?? 1);
    }

    function jobExpectedOutputs(job, ability, { conservative = false } = {}) {
        if (Array.isArray(job.outputs) && job.outputs.length) {
            if (conservative) return []; // 随机抽取不能算作保证产量
            const totalWeight = job.outputs.reduce((sum, out) => sum + Number(out.weight || 0), 0);
            if (totalWeight <= 0) return [];
            const draws = calcDraws(job.draws, ability);
            return job.outputs.map(out => ({
                itemId: out.item_id ?? out.item?.item_id ?? null,
                name: out.item?.name || out.name || '',
                quantity: draws * Number(out.weight || 0) / totalWeight,
                item: out.item || out,
            }));
        }
        const item = job.item || job.produce;
        const itemId = job.item_id ?? item?.item_id ?? null;
        if (!item && itemId == null) return [];
        const min = Number(job.yield_min ?? job.produce_quantity ?? job.output_quantity ?? 1);
        const max = Number(job.yield_max ?? min);
        return [{ itemId, name: item?.name || '', quantity: conservative ? min : (min + max) / 2, item }];
    }

    function recipeInputValue(state, recipe) {
        let total = 0;
        for (const input of recipe.inputs || []) {
            const itemId = input.item_id ?? input.item?.item_id;
            const price = itemSellPrice(state, itemId, input.item?.name || '', input.item?.sell_price);
            if (price != null) total += price * Number(input.quantity || 0);
        }
        return total;
    }

    function jobHourlyValue(state, industry, job, ability) {
        const seconds = jobDurationSeconds(job, ability);
        if (!seconds) return null;
        let outputValue = 0;
        let known = false;
        for (const out of jobExpectedOutputs(job, ability)) {
            const price = itemSellPrice(state, out.itemId, out.name, out.item?.sell_price);
            if (price == null) continue;
            known = true;
            outputValue += price * out.quantity;
        }
        if (!known) return null;
        const net = outputValue - (industry === 'crafting' ? recipeInputValue(state, job) : 0);
        return net / Math.max(1e-6, seconds / 3600);
    }

    function outputMatchesNeed(out, need) {
        return need.itemId != null ? sameId(out.itemId, need.itemId) : (!!need.name && out.name === need.name);
    }

    function jobDemandScore(state, job, ability) {
        let score = 0;
        const outputs = jobExpectedOutputs(job, ability);
        for (const need of gatherNeeds(state, { productionOnly: true })) {
            const shortage = needShortage(state, need);
            if (shortage <= 0) continue;
            const amount = outputs.filter(out => outputMatchesNeed(out, need)).reduce((sum, out) => sum + out.quantity, 0);
            if (amount <= 0) continue;
            score += (need.source === 'commission' ? 1e9 : 1e7) + Math.min(shortage, amount) * 1e5;
        }
        return score;
    }

    function recipeInputsSafe(state, recipe) {
        const totals = new Map();
        for (const input of recipe.inputs || []) {
            const id = input.item_id ?? input.item?.item_id;
            if (id == null) return false;
            const key = String(id);
            const row = totals.get(key) || { itemId: id, name: input.item?.name || '', quantity: 0 };
            row.quantity += Number(input.quantity || 0);
            totals.set(key, row);
        }
        return [...totals.values()].every(row =>
            safeUnspecifiedConsumeQty(state, row.itemId, row.name) >= row.quantity);
    }

    function jobAvailable(state, industry, job) {
        if (industry !== 'crafting') return true;
        return job.unlocked !== false && job.ingredients_available !== false && recipeInputsSafe(state, job);
    }

    function configuredJobId(industry, cfg, nodeId) {
        // 点位级锁定（面板下拉）优先级最高，其次是脚本配置项
        const siteWanted = nodeId != null ? nodeJobOverride(industry, nodeId) : null;
        if (siteWanted != null) return siteWanted;
        return industry === 'crafting' ? cfg.recipeId : cfg.taskId;
    }

    function pickJob(state, industry, node) {
        const adapter = INDUSTRY_ADAPTERS[industry];
        const cfg = adapter.config();
        const jobs = adapter.jobs(node).filter(job => jobAvailable(state, industry, job));
        if (!jobs.length) return { blocked: industry === 'crafting' ? '没有已解锁且材料安全的配方' : '没有可执行任务' };

        const nodeId = adapter.id(node);
        const wanted = configuredJobId(industry, cfg, nodeId);
        if (wanted === '__off') return { blocked: '已手动关闭', strict: true };
        // 面板锁定（点位级）始终严格；配置项锁定由 strictTaskId/strictRecipeId 决定
        const strict = !!cfg[adapter.strictKey] ||
            (nodeId != null && nodeJobOverride(industry, nodeId) != null);
        let candidates = jobs;
        if (wanted != null) {
            const exact = jobs.find(job => sameId(jobId(job), wanted));
            if (exact) candidates = [exact];
            else if (strict) return { blocked: `锁定目标 #${wanted} 当前不在此节点`, strict: true };
        }

        const stamina = liveStamina(state);
        const affordable = candidates.filter(job => Number(job.stamina_cost || 0) <= stamina);
        if (!affordable.length) {
            const minCost = Math.min(...candidates.map(job => Number(job.stamina_cost || 0)));
            rememberStaminaNeed(state, minCost, `${INDUSTRY_NAMES[industry] || industry}任务`);
            return { blocked: `体力不足（当前约 ${stamina}/${state.player?.stamina_cap ?? '?'}）`, stamina: true };
        }

        const partner = assignedPartner(state, node);
        const ability = Number(state.industry_rules?.[industry]?.character_base_ability || 0) +
            (partner ? partnerAbility(partner, industry) : 0);
        const scored = affordable.map((job, index) => {
            const hourly = jobHourlyValue(state, industry, job, ability);
            const seconds = jobDurationSeconds(job, ability) || 1;
            const value = hourly == null ? null : hourly * seconds / 3600;
            const cost = Number(job.stamina_cost || 0);
            const efficiency = value == null ? -Infinity : (cost > 0 ? value / cost : hourly);
            return { job, index, ability, hourly: hourly ?? -Infinity, efficiency, demand: jobDemandScore(state, job, ability) };
        }).sort((a, b) => b.demand - a.demand || b.efficiency - a.efficiency || b.hourly - a.hourly || a.index - b.index);
        return scored[0] || { blocked: '没有可执行任务' };
    }

    function inFlightIndustryGuaranteedQty(state, need) {
        let qty = 0;
        for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
            const base = Number(state.industry_rules?.[industry]?.character_base_ability || 0);
            for (const node of industryNodes(state, industry)) {
                if (node.empty || node.ready) continue;
                const active = node.task || node.recipe;
                if (!active) continue;
                const partner = assignedPartner(state, node);
                const ability = base + (partner ? partnerAbility(partner, industry) : 0);
                for (const out of jobExpectedOutputs(active, ability, { conservative: true })) {
                    if (outputMatchesNeed(out, need)) qty += out.quantity;
                }
            }
        }
        return qty;
    }

    async function collectReadyIndustries() {
        for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
            const adapter = INDUSTRY_ADAPTERS[industry];
            if (!adapter.config().enabled) continue;
            const ids = industryNodes(runtime.state, industry).filter(node => node.ready && !node.empty).map(adapter.id);
            for (const id of ids) {
                const node = nodeById(runtime.state, industry, id);
                if (!node?.ready || node.empty) continue;
                try {
                    await collectSite(industry, id);
                    clearSkip(`fail:collect:${industry}:${id}`);
                    log(`${INDUSTRY_NAMES[industry] || industry}点 ${id}：已领取`);
                } catch (e) {
                    if (isControlFlowError(e)) throw e;
                    logSkip(`fail:collect:${industry}:${id}`, `${INDUSTRY_NAMES[industry] || industry}点 ${id} 领取失败：${e.message}`);
                }
            }
        }
    }

    // 每次只规划全产业中最优的一个开工动作，执行后用新 state 重新排名，避免固定顺序抢体力。
    async function startEmptyIndustries() {
        while (true) {
            const state = runtime.state;
            const plans = [];
            for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
                const adapter = INDUSTRY_ADAPTERS[industry];
                if (!adapter.config().enabled) continue;
                for (const node of industryNodes(state, industry)) {
                    if (!node.empty || node.task_snapshot) continue;
                    const id = adapter.id(node);
                    if (id == null) {
                        logSkip(`schema:start-id:${industry}`, `${industry} 节点缺少 id，已禁止请求 undefined`);
                        continue;
                    }
                    if (nodeJobOverride(industry, id) === '__off') continue; // 面板手动关闭的点位不开工
                    if (adapter.requiresPartner && !siteHasPartner(node)) {
                        logSkip(`nopartner:${industry}:${id}`, `${INDUSTRY_NAMES[industry]}点 ${id}：必须派驻伙伴才能开工`);
                        continue;
                    }
                    const picked = pickJob(state, industry, node);
                    if (!picked.job) {
                        logSkip(`job:blocked:${industry}:${id}:${picked.blocked}`, `${INDUSTRY_NAMES[industry]}点 ${id}：${picked.blocked}`);
                        continue;
                    }
                    plans.push({ industry, adapter, node, id, ...picked });
                }
            }
            if (!plans.length) return;
            plans.sort((a, b) => b.demand - a.demand || b.efficiency - a.efficiency || b.hourly - a.hourly);
            const plan = plans[0];
            try {
                await startSite(plan.industry, plan.id, plan.adapter.payloadKey, jobId(plan.job));
                clearSkip(`fail:start:${plan.industry}:${plan.id}`);
                log(`${INDUSTRY_NAMES[plan.industry]}点 ${plan.id}：开工「${plan.job.name || '任务#' + jobId(plan.job)}」`);
            } catch (e) {
                if (isControlFlowError(e)) throw e;
                logSkip(`fail:start:${plan.industry}:${plan.id}`, `${INDUSTRY_NAMES[plan.industry]}点 ${plan.id} 开工失败：${e.message}`);
                return; // 状态可能发生竞争，结束本阶段，下一轮重新规划
            }
        }
    }

    // ---------- 角色库扫描 ----------
    const INDUSTRY_NAMES = {
        farming: '农作', gathering: '采集', mining: '矿产',
        aquatic: '水产', livestock: '畜牧', crafting: '加工',
    };

    function partnerPost(p) {
        if (p.locked) return '任务中·已锁定';
        for (const [industry, field] of Object.entries(ASSIGN_FIELD)) {
            if (p[field] != null) return `派驻于${INDUSTRY_NAMES[industry] || industry}`;
        }
        return '空闲';
    }

    function scanRoster(state) {
        const partners = (state.partners || []).filter(p => !p.missing);
        if (!partners.length) { log('角色库为空'); return; }
        log(`角色库共 ${partners.length} 名伙伴：`);
        for (const p of partners) {
            const tend = (p.tendencies || [])
                .map(t => `${INDUSTRY_NAMES[t.industry] || t.industry}${t.effective_ability ?? t.current_ability ?? 0}`)
                .join(' / ');
            log(`· ${p.name || p.partner_id}｜${tend || '无产业倾向'}｜${partnerPost(p)}`);
        }
    }

    // 面板状态摘要：各产业 进行中任务数/点位数，采集附带编制占用
    function summarize(state) {
        const parts = [];
        const groups = [
            ['农', state.plots, null],
            ['采', state.gathering_sites, 'gathering'],
            ['矿', state.mining_sites, 'mining'],
            ['工', state.crafting_stations, 'crafting'],
        ];
        for (const [label, sites, industry] of groups) {
            if (!sites || !sites.length) continue;
            const runningCount = sites.filter(s => !s.empty || s.task_snapshot).length;
            let text = `${label}${runningCount}/${sites.length}`;
            if (industry) {
                const cap = industryCapacity(state, industry);
                if (cap !== Infinity) text += `(编${assignedCount(state, industry)}/${cap})`;
            }
            parts.push(text);
        }
        return parts.join(' ');
    }

    async function tick() {
        if (busy) return;
        busy = true;
        let delay = CONFIG.pollInterval;
        try {
            pendingStaminaCost = null; // 每轮重新统计体力缺口
            runtime.actionCount = 0;   // 单轮写操作计数归零
            runtime.soldUnits = 0;     // 单轮售卖计数归零
            const state = await getState();
            clearSkip('story:active');
            if (CONFIG.rosterScanOnStart && !rosterScanned) {
                rosterScanned = true;
                scanRoster(state);
            }
            await doCommissions();
            await collectReadyPlots();
            await collectReadyIndustries();
            // 伙伴只能在生产前派驻/调整（开工后即锁定），所以先收取腾点位，再派伙伴，最后种植/开工
            await optimizePartnerAssignments();
            await plantEmptyPlots();
            await startEmptyIndustries();
            refreshConfigRows(runtime.state);
            statusLine.textContent = `运行中 ${new Date().toLocaleTimeString()} · ${summarize(runtime.state)}`;
            // 有实际操作时，触发游戏自带的 state 刷新，让页面 UI 立即同步（不刷新网页）
            if (dirty) {
                dirty = false;
                refreshGameUI();
            }
            // 自适应：对齐最近任务的完成时刻，无事可做时拉长间隔
            delay = nextDelay(runtime.state);
        } catch (e) {
            if (e.code === 'aborted') return; // 用户停止，不记为失败
            if (e.code === 'story_active') { // 剧情播放/奖励同步中：按提示时间等待，不算失败
                delay = Math.max(1000, Number(e.retryAfter || 1000));
                logSkip('story:active', '剧情播放或奖励同步中，写操作暂停');
                return;
            }
            if (/401|403|登录/.test(e.message)) {
                log('未登录或会话失效，请先登录水鱼账号');
                stop();
                return;
            }
            log(`状态刷新失败：${e.message}`);
        } finally {
            busy = false;
            if (running) {
                clearTimeout(timer);
                timer = setTimeout(tick, delay);
            }
        }
    }

    // 单标签页主节点：持有 Web Lock 的标签页才能运行，避免多页同时写操作
    const TAB_LOCK_NAME = 'rlt-auto-helper-leader';
    let releaseTabLock = null;

    async function start() {
        if (running) return;
        if (CONFIG.singleTab) {
            if (!navigator.locks) {
                log('当前环境不支持 Web Locks，无法保证单标签页运行');
            } else {
                const acquired = await new Promise(resolve => {
                    navigator.locks.request(TAB_LOCK_NAME, { ifAvailable: true }, lock => {
                        resolve(!!lock);
                        if (!lock) return undefined;
                        return new Promise(r => { releaseTabLock = r; }); // 持锁直到 stop()
                    }).catch(() => resolve(null));
                });
                if (acquired === false) {
                    statusLine.textContent = '已在其他标签页运行';
                    log('另一个标签页已在运行自动助手，本页不启动');
                    return;
                }
                if (acquired === null) log('Web Locks 请求失败，无法保证单标签页运行');
            }
        }
        running = true;
        runtime.controller = new AbortController();
        runtime.actionCount = 0;
        runtime.soldUnits = 0;
        toggleBtn.textContent = '停止';
        log('自动助手已启动');
        tick();
    }

    function stop() {
        running = false;
        clearTimeout(timer);
        if (runtime.controller) {
            runtime.controller.abort(new DOMException('已停止', 'AbortError'));
            runtime.controller = null;
        }
        if (releaseTabLock) {
            releaseTabLock();
            releaseTabLock = null;
        }
        toggleBtn.textContent = '启动';
        statusLine.textContent = '已停止';
        log('自动助手已停止');
    }

    toggleBtn.textContent = '启动';
    statusLine.textContent = '待启动';
    toggleBtn.onclick = () => (running ? stop() : start());

    // 默认自动启动
    start();
})();
