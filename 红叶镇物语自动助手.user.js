// ==UserScript==
// @name         红叶镇物语 · 自动农场助手 0824修复版
// @namespace    http://tampermonkey.net/
// @version      1.9.0
// @description  红叶镇物语自动收菜/种菜、采集、采矿、加工、每日委托循环脚本（基于游戏自身 API）
// @author       -
// @match        https://chiyuki.diving-fish.com/red-leaf-town/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /******************** 配置区 ********************/
    const CONFIG = {
        // 空闲时的最短轮询间隔（毫秒）；有任务在进行时会自动对齐到完成时间，无事可做时用 maxPollInterval
        pollInterval: 15000,
        // 无事可做时的最长轮询间隔（毫秒）
        maxPollInterval: 120000,

        farming: {
            enabled: true,            // 自动收获 + 种菜
            cropId: null,             // 指定作物 id；null = 自动选择
            prefer: 'first',          // 自动选择策略: 'first' 列表第一种 | 'fastest' 生长最快 | 'slowest' 生长最慢
            autoBuySeeds: false,      // 没种子时是否自动去商店买
            autoSellForSeeds: true,   // 买种子金币不足时，自动售卖多余物资凑钱（配合 autoBuySeeds）
            seedStrategy: 'portal',   // 种植/购买策略: 'portal' 传送门需求优先，满足后按经济价值 | 'profit' 始终按经济价值最高
            seedShopId: null,         // 可选：强制指定商店条目 id，优先级最高
            autoAssignPartner: true,  // 自动派驻/优化驻场伙伴（有更强的空闲伙伴时自动更换）
        },

        gathering: {
            enabled: true,            // 林野采集：自动领取 + 重新开工
            taskId: null,             // 指定任务 id；null = 用该点第一个可接任务
            autoAssignPartner: true,  // 采集必须派驻伙伴：自动安排/优化驻场伙伴
        },

        mining: {
            enabled: true,            // 矿山采矿：自动收取 + 重新开工
            taskId: null,             // 指定任务 id；null = 用该点第一个可接任务
            autoAssignPartner: true,  // 自动派驻/优化协助伙伴（不设则会独自采矿）
        },

        crafting: {
            enabled: false,           // 加工：会消耗背包材料，默认关闭，需要时打开
            recipeId: null,           // 指定配方 id；null = 用第一个配方
            autoAssignPartner: true,  // 自动派驻/优化协助伙伴
        },

        commissions: {
            enabled: true,            // 每日委托
            autoSubmit: true,         // 库存够时自动交付今日委托（奖励枫火）
            autoTake: true,           // 自动从转发池接单（只动超出传送门/自委托需求的富余物资）
        },

        rosterScanOnStart: true,      // 启动时自动扫描并打印角色库
    };
    /****************** 配置区结束 ******************/

    const API = '/api/red-leaf-town';

    // ---------- 基础请求（与游戏前端一致：cookie 会话 + JSON） ----------
    async function api(path, { method = 'GET', payload } = {}) {
        let resp;
        try {
            resp = await fetch(API + path, {
                method,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: payload === undefined ? undefined : JSON.stringify(payload),
            });
        } catch (e) {
            throw new Error('网络错误：无法连接红叶镇');
        }
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.message || `请求失败 (${resp.status})`);
        return json.data;
    }

    const getState = () => api('/state');
    const plantPlot = (slot, cropId) => api(`/plots/${slot}/plant`, { method: 'POST', payload: { crop_id: cropId, task_item_id: '' } });
    const harvestPlot = (slot) => api(`/plots/${slot}/harvest`, { method: 'POST' });
    const buyItem = (shopId, qty = 1) => api('/shop/buy', { method: 'POST', payload: { shop_id: shopId, quantity: qty } });
    const sellItem = (itemId, qty, quality = 0) =>
        api(`/inventory/${itemId}/sell`, { method: 'POST', payload: { quantity: qty, quality } });
    const siteUrl = (industry, siteId) => `/${industry}/${industry === 'crafting' ? 'stations' : 'sites'}/${siteId}`;
    const startSite = (industry, siteId, payloadKey, id) =>
        api(`${siteUrl(industry, siteId)}/start`, { method: 'POST', payload: { [payloadKey]: id, task_item_id: '' } });
    const collectSite = (industry, siteId) => api(`${siteUrl(industry, siteId)}/collect`, { method: 'POST' });
    const assignSitePartner = (industry, siteId, partnerId) =>
        api(`${siteUrl(industry, siteId)}/partner`, { method: 'PUT', payload: { partner_id: partnerId || '' } });
    const assignPlotPartner = (slot, partnerId) =>
        api(`/plots/${slot}/partners`, { method: 'PUT', payload: { partner_id: partnerId || '' } });
    const submitCommission = () => api('/commissions/submit', { method: 'POST' });
    const getCommissionBoard = () => api('/commissions/board');
    const takeCommission = (commissionId) => api(`/commissions/${commissionId}/take`, { method: 'POST' });

    // ---------- 小面板 ----------
    const panel = document.createElement('div');
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

    // 采矿任务手动选择器（应对体力限制：锁定只挖某个矿）
    const mineRow = document.createElement('div');
    mineRow.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:6px';
    const mineLabel = document.createElement('span');
    mineLabel.textContent = '采矿:';
    mineLabel.style.opacity = '.8';
    const mineSelect = document.createElement('select');
    mineSelect.style.cssText = 'flex:1;max-width:230px;background:#17211b;color:#e8e0cf;border:1px solid #555f52;border-radius:4px;font:11px monospace;padding:1px 4px';
    mineSelect.title = '选择要挖的矿；选「自动」则按每小时期望价值选择';
    mineRow.appendChild(mineLabel);
    mineRow.appendChild(mineSelect);
    panel.appendChild(mineRow);
    panel.appendChild(logBox);
    document.body.appendChild(panel);

    // 手动选矿：null = 自动；否则为任务 id（记忆在 localStorage）
    let miningTaskOverride = (() => {
        const v = localStorage.getItem('rlt-mining-task');
        return v === null || v === '' ? null : v;
    })();
    mineSelect.onchange = () => {
        miningTaskOverride = mineSelect.value || null;
        localStorage.setItem('rlt-mining-task', miningTaskOverride || '');
        log(miningTaskOverride ? '已锁定采矿目标' : '采矿恢复为自动选择');
    };

    // 每轮用最新 state 刷新采矿下拉选项（保留当前选择）
    function refreshMineOptions(state) {
        const keep = miningTaskOverride != null ? String(miningTaskOverride) : mineSelect.value;
        mineSelect.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = '自动（按价值选）';
        mineSelect.appendChild(auto);
        for (const site of state.mining_sites || []) {
            const siteName = site.definition?.name || site.site_id;
            for (const t of site.available_tasks || []) {
                const opt = document.createElement('option');
                opt.value = String(t.id);
                opt.textContent = `${siteName} · ${t.name || '任务#' + t.id}${t.stamina_cost ? `（体力${t.stamina_cost}）` : ''}`;
                mineSelect.appendChild(opt);
            }
        }
        mineSelect.value = keep;
        if (mineSelect.value !== keep) { // 选项已不存在（比如矿点换班）
            mineSelect.value = '';
            miningTaskOverride = null;
            localStorage.setItem('rlt-mining-task', '');
        }
    }

    // 收起/展开（记住选择）
    let collapsed = localStorage.getItem('rlt-helper-collapsed') === '1';
    function applyCollapsed() {
        logBox.style.display = collapsed ? 'none' : '';
        mineRow.style.display = collapsed ? 'none' : '';
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
    function refreshGameUI() {
        try {
            const app = document.querySelector('#app')?.__vue_app__;
            const pinia = app?._context?.config?.globalProperties?.$pinia;
            const store = pinia?._s?.get('game');
            if (typeof store?.refresh === 'function') { store.refresh(); return true; }
        } catch (e) { /* 忽略，下一轮轮询会自然同步 */ }
        return false;
    }

    // ---------- 体力估算 ----------

    // 估算实时体力：stamina + 随时间恢复（以 state.server_time 为基准）
    function liveStamina(state) {
        const p = state.player;
        if (!p) return Infinity;
        const base = p.stamina ?? 0;
        const restore = p.stamina_restore_seconds || 0;
        if (!restore) return base;
        const regen = Math.floor(Math.max(0, (state.server_time || 0) - (p.stamina_updated_at || 0)) / restore);
        return Math.min(p.stamina_cap ?? Infinity, base + regen);
    }

    // 体力恢复到 target 还要多少秒；无法估算返回 null
    function staminaWaitSeconds(state, target) {
        const p = state.player;
        if (!p || !p.stamina_restore_seconds) return null;
        const cur = liveStamina(state);
        if (cur >= target) return 0;
        return (target - cur) * p.stamina_restore_seconds;
    }

    // 本轮因体力不足未能开工所需的最低体力（tick 开始时重置，pickTask 里记录）
    let pendingStaminaCost = null;

    // ---------- 自适应调度 ----------

    // 根据 state 算下次唤醒时间：对齐最近的任务完成时刻，无事可做则用上限
    function nextDelay(state) {
        const now = state.server_time || 0;
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
            if (sw != null) wait = Math.min(wait, sw);
        }
        if (!isFinite(wait)) return CONFIG.maxPollInterval;
        // +2s 缓冲，且不低于 pollInterval、不超过 maxPollInterval
        return Math.min(CONFIG.maxPollInterval, Math.max(CONFIG.pollInterval, Math.ceil(wait * 1000) + 2000));
    }

    function seedQty(state, crop) {
        const inv = (state.inventory || []).find(i => i.item_id === crop.seed_item_id);
        return inv ? inv.quantity || 0 : 0;
    }

    // ---------- 经济价值评估 ----------

    // 时长公式（与游戏前端一致）：能力越高耗时越短
    function calcSeconds(base, difficulty, ability) {
        const d = Math.max(1e-4, Number(difficulty) || 0);
        const sum = ability + d;
        const factor = sum > 0 ? 1 + 2 * ability / sum : 1;
        return Math.max(1, Math.ceil((Number(base) || 1) / factor));
    }

    // 抽取次数公式（与游戏前端一致）：能力越高抽得越多
    function calcDraws(draws, ability) {
        if (!draws) return 1;
        const n = Math.max(0, ability);
        const s = 1 + (Number(draws.ability_bonus) || 0) * n / (n + (Number(draws.difficulty) || 1));
        return Math.max(1, Math.floor((Number(draws.base_draws) || 1) * s + .5));
    }

    // 作物每小时净利润 = (平均产量 × 产物售价 - 种子价格) / 实际小时数
    // （复刻游戏管理端的收益公式，品质期望简化为基础售价；数据缺失返回 null）
    function cropHourlyProfit(crop, ability = 0) {
        const producePrice = Number(crop.produce_sell_price);
        const seedPrice = Number(crop.seed_price);
        if (!isFinite(producePrice) || !isFinite(seedPrice)) return null;
        const yieldAvg = ((Number(crop.yield_min) + Number(crop.yield_max)) / 2) || 1;
        const hours = calcSeconds(crop.growth_seconds, crop.time_difficulty, ability) / 3600;
        return (yieldAvg * producePrice - seedPrice) / hours;
    }

    function farmingAbility(state) {
        return state.industry_rules?.farming?.character_base_ability || 0;
    }

    // 从候选作物中挑每小时净利润最高的；利润数据全部缺失时回退到 prefer 策略
    function bestCrop(state, crops) {
        const ability = farmingAbility(state);
        let best = null, bestV = -Infinity, hasData = false;
        for (const c of crops) {
            const v = cropHourlyProfit(c, ability);
            if (v == null) continue;
            hasData = true;
            if (v > bestV) { bestV = v; best = c; }
        }
        if (hasData) return best;
        const list = [...crops];
        if (CONFIG.farming.prefer === 'fastest') list.sort((a, b) => a.growth_seconds - b.growth_seconds);
        if (CONFIG.farming.prefer === 'slowest') list.sort((a, b) => b.growth_seconds - a.growth_seconds);
        return list[0] || null;
    }

    // 贡品在背包中的合格库存（品质需 >= min_quality）
    function tributeInventoryQty(state, tr) {
        return (state.inventory || [])
            .filter(i => (tr.item_id != null ? i.item_id === tr.item_id : i.name === tr.name))
            .filter(i => (i.quality || 0) >= (tr.min_quality || 0))
            .reduce((s, i) => s + (i.quantity || 0), 0);
    }

    // 传送门仍有缺口（贡品未交齐且现有合格库存也不够）的第一个作物
    function portalNeededCrop(state) {
        for (const portal of state.portals || []) {
            if (!portal.unlocked || portal.completed) continue;
            for (const tr of portal.tributes || []) {
                if (tr.completed) continue;
                const shortage = (tr.quantity || 0) - (tr.delivered || 0) - tributeInventoryQty(state, tr);
                if (shortage <= 0) continue; // 已交齐或库存已足够
                const crop = findCropForTribute(state, tr);
                if (crop) return { crop, portal, tribute: tr, shortage };
            }
        }
        return null;
    }

    // 今日委托仍缺的物品对应的作物（委托每日限时，优先级高于传送门）
    function commissionNeededCrop(state) {
        const cm = state.commissions?.commission;
        if (!commissionActive(cm)) return null;
        const itemId = cm.item_id ?? cm.item?.item_id;
        const shortage = (cm.quantity || 0) - (cm.owned || 0);
        if (itemId == null || shortage <= 0) return null;
        const crops = state.crops || [];
        const crop = crops.find(c =>
            c.produce_item_id === itemId || c.item_id === itemId || c.produce?.item_id === itemId) ||
            (cm.item?.name ? crops.find(c => c.name === cm.item.name || c.produce?.name === cm.item.name) : null);
        return crop ? { crop, shortage, commission: cm } : null;
    }

    // 选作物：返回 { crop, reason } 或 null（null = 有缺口但没种子，或完全没有种子）
    function pickCrop(state) {
        const withSeeds = (state.crops || []).filter(c => seedQty(state, c) > 0);
        // 1. 用户指定作物
        if (CONFIG.farming.cropId != null) {
            const chosen = withSeeds.find(c => c.id === CONFIG.farming.cropId);
            if (chosen) return { crop: chosen, reason: '指定作物' };
        }
        // 2. 今日委托缺口（每日限时，优先级高于传送门）
        if (CONFIG.commissions.enabled) {
            const needC = commissionNeededCrop(state);
            if (needC) {
                const owned = withSeeds.find(c => c.id === needC.crop.id);
                if (owned) return { crop: owned, reason: `今日委托缺 ${needC.commission.item?.name || ''} ×${needC.shortage}` };
                const buyableC = CONFIG.farming.autoBuySeeds &&
                    seedShopEntries(state).some(e => e.item.item_id === needC.crop.seed_item_id);
                if (buyableC) return null; // 停下等购买
            }
        }
        // 3. 传送门缺口（库存已足够或已交齐时跳过）
        if (CONFIG.farming.seedStrategy !== 'profit') {
            const need = portalNeededCrop(state);
            if (need) {
                const owned = withSeeds.find(c => c.id === need.crop.id);
                if (owned) {
                    return { crop: owned, reason: `传送门「${need.portal.name || need.portal.portal_id || ''}」缺 ${need.tribute.name}` };
                }
                // 缺口作物没种子：只有开了自动购买且商店有售时才停下等购买，否则按经济价值继续种
                const buyable = CONFIG.farming.autoBuySeeds &&
                    seedShopEntries(state).some(e => e.item.item_id === need.crop.seed_item_id);
                if (buyable) return null;
            }
        }
        // 4. 经济价值最高
        if (!withSeeds.length) return null;
        const crop = bestCrop(state, withSeeds);
        return crop ? { crop, reason: '经济价值最高' } : null;
    }

    // ---------- 种子购买 ----------

    // 商店里可买的种子条目（未锁定、且对应一种已知作物）
    function seedShopEntries(state) {
        return (state.shop || []).filter(e =>
            e.item?.kind === 'seed' && !e.locked &&
            (state.crops || []).some(c => c.seed_item_id === e.item.item_id));
    }

    function playerCoins(state) {
        return state.player?.coins ?? 0;
    }

    // 把贡品匹配到作物：优先按 item_id，其次按名称（作物的产物字段名未确认，做多路尝试）
    function findCropForTribute(state, tr) {
        const crops = state.crops || [];
        if (tr.item_id != null) {
            const byId = crops.find(c =>
                c.produce_item_id === tr.item_id || c.item_id === tr.item_id ||
                c.produce?.item_id === tr.item_id || c.seed_item_id === tr.item_id);
            if (byId) return byId;
        }
        if (tr.name) {
            return crops.find(c => c.name === tr.name || c.produce?.name === tr.name) || null;
        }
        return null;
    }

    // 多余物资全部卖出能凑到的总金额
    function maxSellableValue(state) {
        return computeSellables(state).reduce((sum, s) => sum + s.surplus * s.item.sell_price, 0);
    }

    // ---------- 需求汇总（传送门贡品 + 今日委托） ----------

    // 委托是否仍在进行中（未交付且未转发出去）
    function commissionActive(cm) {
        return !!cm && !cm.settled &&
            cm.status !== 'forwarded' && cm.status !== 'forward_completed' && cm.status !== 'completed';
    }

    // 所有需要保护的物资需求：传送门贡品缺口 + 今日委托所需
    function gatherNeeds(state) {
        const needs = [];
        for (const portal of state.portals || []) {
            if (!portal.unlocked || portal.completed) continue;
            for (const tr of portal.tributes || []) {
                const need = (tr.quantity || 0) - (tr.delivered || 0);
                if (tr.completed || need <= 0) continue;
                needs.push({ itemId: tr.item_id ?? null, name: tr.name || '', minQuality: tr.min_quality || 0, need });
            }
        }
        const cm = state.commissions?.commission;
        if (commissionActive(cm)) {
            needs.push({
                itemId: cm.item_id ?? cm.item?.item_id ?? null,
                name: cm.item?.name || '',
                minQuality: 0,
                need: cm.quantity || 0, // 委托要多少就保护多少，直到交付
            });
        }
        return needs;
    }

    // ---------- 自动售卖凑金币 ----------

    // 计算可售卖的物资：完全不被需要的（全额可卖）+ 需求已足额后的超额部分
    function computeSellables(state) {
        const needs = gatherNeeds(state);
        const sellables = [];
        for (const item of state.inventory || []) {
            if (!item.sell_price || !(item.quantity > 0)) continue; // 种子等无售价物品自然排除
            const matched = needs.filter(n =>
                (n.itemId != null && n.itemId === item.item_id) ||
                (n.itemId == null && n.name && n.name === item.name));
            if (!matched.length) {
                sellables.push({ item, surplus: item.quantity, needed: false });
                continue;
            }
            // 品质低于贡品 min_quality 的部分不算入需求，全额可卖
            let reserve = 0;
            for (const n of matched) {
                if ((item.quality || 0) >= n.minQuality) reserve += n.need;
            }
            const surplus = Math.max(0, item.quantity - reserve);
            if (surplus > 0) sellables.push({ item, surplus, needed: true });
        }
        // 优先卖传送门完全不需要的，再卖足额后的超额；各自按单价从高到低（最快凑够钱）
        sellables.sort((a, b) => (a.needed - b.needed) || (b.item.sell_price - a.item.sell_price));
        return sellables;
    }

    // 售卖多余物资直到金币达到 target；达到返回 true，否则 false
    async function autoSellForCoins(state, target) {
        let coins = playerCoins(state);
        if (coins >= target) return true;
        const sellables = computeSellables(state);
        if (!sellables.length) {
            log(`错误：金币不足（${coins}/${target}），且没有传送门不需要或已足额的多余物资可卖`);
            return false;
        }
        for (const s of sellables) {
            if (coins >= target) break;
            const qty = Math.min(s.surplus, Math.ceil((target - coins) / s.item.sell_price));
            if (qty <= 0) continue;
            try {
                await sellItem(s.item.item_id, qty, s.item.quality || 0);
                markDirty();
                clearSkip(`fail:sell:${s.item.item_id}:${s.item.quality || 0}`);
                coins += qty * s.item.sell_price;
                s.item.quantity -= qty;
                log(`已卖出 ${s.item.quality_name || ''}${s.item.name} ×${qty}，+${qty * s.item.sell_price} 金币（现有 ${coins}）`);
            } catch (e) {
                logSkip(`fail:sell:${s.item.item_id}:${s.item.quality || 0}`, `卖出 ${s.item.name} 失败：${e.message}`);
            }
        }
        if (state.player) state.player.coins = coins;
        if (coins < target) {
            log(`错误：多余物资已全部卖出，金币仍不足（${coins}/${target}）`);
            return false;
        }
        return true;
    }

    // 没种子时按策略购买；买到返回 true，买不到返回 false
    async function buySeeds(state) {
        const cfg = CONFIG.farming;
        const emptyPlots = Math.max(1, (state.plots || []).filter(p => p.empty).length);
        let coins = playerCoins(state);
        let entry = null;
        let reason = '';

        if (cfg.seedShopId != null) {
            entry = (state.shop || []).find(e => e.id === cfg.seedShopId) || null;
            reason = '指定条目';
        }
        // 今日委托缺口最优先：缺什么买什么种子
        if (!entry && CONFIG.commissions.enabled) {
            const needC = commissionNeededCrop(state);
            if (needC) {
                entry = seedShopEntries(state).find(e => e.item.item_id === needC.crop.seed_item_id) || null;
                if (entry) reason = `今日委托缺 ${needC.commission.item?.name || ''} ×${needC.shortage}`;
            }
        }
        // 传送门缺口其次：缺口作物没种子时买它的种子
        if (!entry && cfg.seedStrategy !== 'profit') {
            const need = portalNeededCrop(state);
            if (need) {
                entry = seedShopEntries(state).find(e => e.item.item_id === need.crop.seed_item_id) || null;
                if (entry) {
                    reason = `传送门「${need.portal.name || need.portal.portal_id || ''}」缺 ${need.tribute.name}`;
                } else {
                    logSkip('portal:noseed', `传送门需要 ${need.tribute.name}，但商店买不到对应种子，改按经济价值购买`);
                }
            }
        }
        if (!entry) {
            // 经济价值（每小时净利润）最高且预算够得着的种子；预算含可卖物资价值
            const ability = farmingAbility(state);
            const budget = cfg.autoSellForSeeds ? coins + maxSellableValue(state) : coins;
            const candidates = seedShopEntries(state)
                .map(e => ({ e, crop: (state.crops || []).find(c => c.seed_item_id === e.item.item_id) }))
                .filter(x => x.crop && x.e.price <= budget)
                .sort((a, b) =>
                    (cropHourlyProfit(b.crop, ability) ?? -Infinity) - (cropHourlyProfit(a.crop, ability) ?? -Infinity) ||
                    b.e.price - a.e.price);
            entry = candidates[0]?.e || null;
            reason = reason || '经济价值最高';
        }
        if (!entry) {
            logSkip('seed:none', `错误：商店里没有种子在预算内（现有 ${coins}${cfg.autoSellForSeeds ? '，且没有可售卖的多余物资补足差价' : ''}），跳过种菜`);
            return false;
        }
        clearSkip('seed:none');

        // 金币不足：优先自动售卖传送门不需要/已足额的物资凑钱
        if (coins < entry.price && cfg.autoSellForSeeds) {
            log(`红叶币不足（${coins}/${entry.price * emptyPlots}），尝试自动售卖多余物资...`);
            await autoSellForCoins(state, entry.price * emptyPlots);
            coins = playerCoins(state);
        }
        if (coins < entry.price) {
            logSkip('seed:poor', `错误：红叶币不足（${coins}）且没有可售卖的多余物资，买不起 ${entry.item.name}（单价 ${entry.price}）`);
            return false;
        }
        clearSkip('seed:poor');

        const qty = Math.max(1, Math.min(emptyPlots, Math.floor(coins / entry.price)));
        try {
            await buyItem(entry.id, qty);
            if (state.player) state.player.coins = Math.max(0, coins - entry.price * qty);
            markDirty();
            clearSkip('fail:buy');
            log(`种子不足，已购买 ${entry.item.name} ×${qty}（${reason}，花费 ${entry.price * qty}）`);
            return true; // 背包已变，等下一轮 state 刷新再种
        } catch (e) {
            logSkip('fail:buy', `购买种子失败：${e.message}`);
            return false;
        }
    }

    // ---------- 每日委托 ----------

    // 某物品扣除所有保护需求（传送门贡品 + 今日自委托）后的富余数量
    function surplusQty(state, itemId, name) {
        const needs = gatherNeeds(state).filter(n =>
            (n.itemId != null && n.itemId === itemId) ||
            (n.itemId == null && n.name && n.name === name));
        let reserved = 0;
        for (const n of needs) reserved += n.need;
        const qty = (state.inventory || [])
            .filter(i => (itemId != null ? i.item_id === itemId : i.name === name))
            .reduce((s, i) => s + (i.quantity || 0), 0);
        return qty - reserved;
    }

    // 转发池接单：只动富余物资，报酬最高的优先
    async function tryTakeCommission(state) {
        let board;
        try {
            board = await getCommissionBoard();
        } catch (e) {
            logSkip('fail:commission:board', `读取委托转发池失败：${e.message}`);
            return;
        }
        clearSkip('fail:commission:board');
        const list = Array.isArray(board) ? board : (board?.commissions || board?.list || board?.items || []);
        const candidates = list
            .filter(x => x.can_take)
            .sort((a, b) => (b.taker_reward || 0) - (a.taker_reward || 0));
        for (const x of candidates) {
            const itemId = x.item_id ?? x.item?.item_id ?? null;
            const qty = x.quantity ?? x.required ?? 1;
            if (itemId == null) continue; // 字段不明，没法验证富余，跳过
            if (surplusQty(state, itemId, x.item?.name || x.name || '') < qty) continue; // 会动到保护物资，不接
            try {
                await takeCommission(x.commission_id);
                markDirty();
                log(`已接单：替 ${x.owner_name || x.npc_name || '镇民'} 跑一趟，交出 ${x.item?.name || x.name || itemId} ×${qty}（+${x.taker_reward ?? '?'} 枫火）`);
                if (state.commissions) state.commissions.remaining_takes = Math.max(0, (state.commissions.remaining_takes || 1) - 1);
                const inv = (state.inventory || []).find(i => i.item_id === itemId);
                if (inv) inv.quantity = Math.max(0, (inv.quantity || 0) - qty);
                return;
            } catch (e) {
                logSkip(`fail:commission:take:${x.commission_id}`, `接单失败：${e.message}`);
            }
        }
    }

    async function doCommissions(state) {
        const cfg = CONFIG.commissions;
        if (!cfg.enabled) return;
        const c = state.commissions;
        if (!c || !c.unlocked) return;
        const cm = c.commission;
        // 1. 自动交付今日委托
        if (cm && cfg.autoSubmit && !cm.settled && cm.can_submit) {
            try {
                await submitCommission();
                markDirty();
                clearSkip('fail:commission:submit');
                cm.settled = true;
                log(`已交付今日委托：${cm.npc_name || 'NPC'} 的 ${cm.item?.name || cm.item_id} ×${cm.quantity}（+${cm.reward_maple_flame ?? '?'} 枫火${cm.lucky ? '，幸运日加成' : ''}）`);
            } catch (e) {
                logSkip('fail:commission:submit', `交付委托失败：${e.message}`);
            }
        }
        // 2. 自动从转发池接单
        if (cfg.autoTake && (c.remaining_takes ?? 0) > 0 && c.board_available) {
            await tryTakeCommission(state);
        }
    }

    async function doFarming(state) {
        const cfg = CONFIG.farming;
        if (!cfg.enabled) return;
        for (const plot of state.plots || []) {
            // 0. 驻场伙伴：没有就派最强的，有更优的空闲伙伴就换人（锁定时不动）
            if (cfg.autoAssignPartner) {
                await ensureBestPartner(state, 'farming', plot, `土地 ${plot.slot + 1}`,
                    (pid) => assignPlotPartner(plot.slot, pid));
            }
            // 1. 收获成熟的
            if (plot.ready && !plot.empty) {
                try {
                    await harvestPlot(plot.slot);
                    markDirty();
                    clearSkip(`fail:harvest:${plot.slot}`);
                    log(`土地 ${plot.slot + 1}：已收获`);
                    plot.empty = true;
                    plot.ready = false;
                } catch (e) {
                    logSkip(`fail:harvest:${plot.slot}`, `土地 ${plot.slot + 1} 收获失败：${e.message}`);
                    continue;
                }
            }
            // 2. 空地种菜
            if (plot.empty) {
                const picked = pickCrop(state);
                if (!picked) {
                    if (cfg.autoBuySeeds && await buySeeds(state)) return;
                    if (!cfg.autoBuySeeds) logSkip('seed:disabled', '仓库没有可用种子，跳过种菜（可开启 autoBuySeeds 自动购买）');
                    return;
                }
                clearSkip('seed:disabled');
                const { crop, reason } = picked;
                try {
                    await plantPlot(plot.slot, crop.id);
                    markDirty();
                    clearSkip(`fail:plant:${plot.slot}`);
                    log(`土地 ${plot.slot + 1}：种下 ${crop.name || '作物#' + crop.id}（${reason}）`);
                    plot.empty = false;
                    const inv = (state.inventory || []).find(i => i.item_id === crop.seed_item_id);
                    if (inv) inv.quantity = Math.max(0, (inv.quantity || 0) - 1);
                } catch (e) {
                    logSkip(`fail:plant:${plot.slot}`, `土地 ${plot.slot + 1} 种植失败：${e.message}`);
                }
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

    // 从空闲伙伴中选出该产业能力最高的（能力同时缩短耗时、增加产出，越高越好）
    function bestIdlePartner(state, industry) {
        return (state.partners || [])
            .filter(p => isPartnerIdle(p) && hasTendency(p, industry))
            .sort((a, b) => partnerAbility(b, industry) - partnerAbility(a, industry))[0] || null;
    }

    // 最优伙伴检查：没有驻场就派最强的空闲伙伴；已有驻场但仓库里有更强的空闲伙伴就换人
    // 任务进行/驻场锁定（assignment_locked）时不做任何变更
    async function ensureBestPartner(state, industry, obj, label, assignFn) {
        if (obj.assignment_locked) return;
        const current = (obj.assigned_partners || [])[0] || null;
        const best = bestIdlePartner(state, industry);
        if (!best) return; // 没有更合适的空闲伙伴
        const curAbility = current ? partnerAbility(current, industry) : null;
        const bestAbility = partnerAbility(best, industry);
        if (curAbility != null && bestAbility <= curAbility) return; // 当前驻场已是最优
        if (!current) {
            // 新派驻占用编制；换人则编制不变
            const cap = industryCapacity(state, industry);
            const used = assignedCount(state, industry);
            if (used >= cap) {
                logSkip(`cap:${industry}:${label}`, `${label}：编制已满（${used}/${cap}），等有伙伴空闲才能派驻`);
                return;
            }
            clearSkip(`cap:${industry}:${label}`);
        }
        const pid = best.partner_id ?? best.id;
        try {
            await assignFn(pid);
            markDirty();
            clearSkip(`fail:assign:${industry}:${label}`);
            const indName = INDUSTRY_NAMES[industry] || industry;
            if (current) {
                current[ASSIGN_FIELD[industry]] = null; // 本地标记为空闲
                log(`${label}：驻场更换 ${current.name || '伙伴'}（${indName} ${curAbility}）→ ${best.name || '伙伴#' + pid}（${indName} ${bestAbility}）`);
            } else {
                log(`已派 ${best.name || '伙伴#' + pid}（${indName}能力 ${bestAbility}）前往${label}`);
            }
            best[ASSIGN_FIELD[industry]] = obj.site_id ?? obj.slot ?? true;
            obj.assigned_partners = [best];
            obj.assigned_partner_ids = [pid];
        } catch (e) {
            logSkip(`fail:assign:${industry}:${label}`, `${label} 派驻伙伴失败：${e.message}`);
        }
    }

    // 任务难度（用于把最强的伙伴优先派到最难的点）
    function siteDifficulty(site) {
        return Math.max(0, ...(site.available_tasks || [])
            .map(t => t.difficulty ?? t.time_difficulty ?? t.yield_difficulty ?? 0));
    }

    function siteHasPartner(site) {
        return (site.assigned_partner_ids || []).length > 0 ||
               (site.assigned_partners || []).length > 0;
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

    // 任务每小时期望价值 = 单次抽取期望售价 × 抽取次数 / 实际小时数
    // （售价数据缺失时返回 null，调用方回退）
    function taskHourlyValue(task, ability) {
        const outs = task.outputs || [];
        const totalW = outs.reduce((s, o) => s + (o.weight || 0), 0);
        if (!outs.length || !totalW) return null;
        let perDraw = 0;
        for (const o of outs) {
            const price = o.item?.sell_price ?? o.sell_price;
            if (price == null) return null;
            perDraw += ((o.weight || 0) / totalW) * price;
        }
        const draws = calcDraws(task.draws, ability);
        // 带 yield_difficulty 的任务能力只影响产量不影响耗时
        const seconds = task.time_difficulty != null
            ? calcSeconds(task.duration_seconds, task.time_difficulty, ability)
            : (Number(task.duration_seconds) || 1);
        return perDraw * draws / Math.max(1e-6, seconds / 3600);
    }

    // 选任务：手动锁定的采矿目标 > 指定 taskId > 体力够得着的任务里每小时期望价值最高
    function pickTask(state, industry, site, cfg) {
        const tasks = site.available_tasks || [];
        if (!tasks.length) return null;
        const wantId = (industry === 'mining' && miningTaskOverride != null) ? miningTaskOverride : cfg.taskId;
        if (wantId != null) {
            const t = tasks.find(x => String(x.id) === String(wantId));
            if (t) {
                // 锁定任务也要过体力检查：不够就等恢复，不去挖别的
                const cost = t.stamina_cost || 0;
                if (cost > liveStamina(state)) {
                    pendingStaminaCost = pendingStaminaCost == null ? cost : Math.min(pendingStaminaCost, cost);
                    return null;
                }
                return t;
            }
        }
        // 体力检查：过滤掉当前体力不够开工的任务
        const stamina = liveStamina(state);
        const affordable = tasks.filter(t => (t.stamina_cost || 0) <= stamina);
        if (!affordable.length) {
            const minCost = Math.min(...tasks.map(t => t.stamina_cost || 0));
            pendingStaminaCost = pendingStaminaCost == null ? minCost : Math.min(pendingStaminaCost, minCost);
            return null;
        }
        const base = state.industry_rules?.[industry]?.character_base_ability || 0;
        const partner = (site.assigned_partners || [])[0];
        const ability = base + (partner ? partnerAbility(partner, industry) : 0);
        let best = null, bestV = -Infinity, hasData = false;
        for (const t of affordable) {
            const v = taskHourlyValue(t, ability);
            if (v == null) continue;
            hasData = true;
            if (v > bestV) { bestV = v; best = t; }
        }
        return hasData ? best : affordable[0];
    }

    async function doIndustry(state, industry, sites, cfg, payloadKey, verb) {
        if (!cfg.enabled) return;
        // 需要自动派驻时，先处理任务难度高的点，让最强的伙伴去最难的点
        const ordered = [...(sites || [])];
        if (cfg.autoAssignPartner) ordered.sort((a, b) => siteDifficulty(b) - siteDifficulty(a));
        for (const site of ordered) {
            const id = site.site_id;
            // 1. 领取完成的
            if (site.ready && !site.empty) {
                try {
                    await collectSite(industry, id);
                    markDirty();
                    clearSkip(`fail:collect:${industry}:${id}`);
                    log(`${verb}点 ${id}：已领取`);
                    site.ready = false;
                    site.empty = true;
                    site.task_snapshot = null;
                } catch (e) {
                    logSkip(`fail:collect:${industry}:${id}`, `${verb}点 ${id} 领取失败：${e.message}`);
                    continue;
                }
            }
            if (!site.empty || site.task_snapshot) continue; // 任务进行中（task_snapshot 存在即在采集/开采）
            // 2. 驻场伙伴：采集强制派驻；采矿/加工可选。有更优的空闲伙伴时自动更换
            const mustHavePartner = industry === 'gathering';
            if (cfg.autoAssignPartner) {
                await ensureBestPartner(state, industry, site, `${verb}点 ${id}`,
                    (pid) => assignSitePartner(industry, id, pid));
            }
            if (mustHavePartner && !siteHasPartner(site)) {
                logSkip(`nopartner:${industry}:${id}`, `${verb}点 ${id}：没有空闲的${verb}倾向伙伴，跳过`);
                continue;
            }
            clearSkip(`nopartner:${industry}:${id}`);
            // 3. 开工：在体力够得着的任务里按每小时期望价值选最优
            const allTasks = site.available_tasks || [];
            if (!allTasks.length) continue;
            const task = pickTask(state, industry, site, cfg);
            if (!task) {
                logSkip(`stamina:${industry}:${id}`, `${verb}点 ${id}：体力不足（当前约 ${liveStamina(state)}/${state.player?.stamina_cap ?? '?'}），等体力恢复`);
                continue;
            }
            clearSkip(`stamina:${industry}:${id}`);
            try {
                await startSite(industry, id, payloadKey, task.id);
                markDirty();
                clearSkip(`fail:start:${industry}:${id}`);
                log(`${verb}点 ${id}：开工「${task.name || '任务#' + task.id}」`);
                site.task_snapshot = { id: task.id }; // 本地标记，防止本轮重复开工
            } catch (e) {
                logSkip(`fail:start:${industry}:${id}`, `${verb}点 ${id} 开工失败：${e.message}`);
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
            const state = await getState();
            if (CONFIG.rosterScanOnStart && !rosterScanned) {
                rosterScanned = true;
                scanRoster(state);
            }
            await doCommissions(state);
            await doFarming(state);
            refreshMineOptions(state);
            await doIndustry(state, 'gathering', state.gathering_sites, CONFIG.gathering, 'task_id', '采集');
            await doIndustry(state, 'mining', state.mining_sites, CONFIG.mining, 'task_id', '矿');
            await doIndustry(state, 'crafting', state.crafting_stations, { ...CONFIG.crafting, taskId: CONFIG.crafting.recipeId }, 'recipe_id', '加工');
            statusLine.textContent = `运行中 ${new Date().toLocaleTimeString()} · ${summarize(state)}`;
            // 有实际操作时，触发游戏自带的 state 刷新，让页面 UI 立即同步（不刷新网页）
            if (dirty) {
                dirty = false;
                refreshGameUI();
            }
            // 自适应：对齐最近任务的完成时刻，无事可做时拉长间隔
            delay = nextDelay(state);
        } catch (e) {
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

    function start() {
        if (running) return;
        running = true;
        toggleBtn.textContent = '停止';
        log('自动助手已启动');
        tick();
    }

    function stop() {
        running = false;
        clearTimeout(timer);
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
