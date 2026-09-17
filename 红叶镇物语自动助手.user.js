// ==UserScript==
// @name         红叶镇物语 · 自动农场助手
// @namespace    http://tampermonkey.net/
// @version      4.0.3
// @description  红叶镇物语自动生产、批量加工流程、航海、均衡饲料补充与图形化管理面板
// @author       -
// @match        https://chiyuki.diving-fish.com/red-leaf-town/*
// @downloadURL  none
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_KEY = '__redLeafTownAutoHelperV2__';
    if (window[INSTANCE_KEY]) return; // 防止同一页面重复注入两套面板和循环
    const SCRIPT_VERSION = '4.0.3';
    const SCRIPT_IDENTITY = {
        name: '红叶镇物语 · 自动农场助手',
        namespace: 'http://tampermonkey.net/',
    };
    // 手动检查会并行查询全部可信源并选择版本最高者，避免单个 CDN 节点缓存滞后。
    // jsDelivr 三个域名属于同一官方服务；GitHub raw 只作为最后兜底。
    const UPDATE_SOURCES = [
        { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/gh/ZGRay00/Red_leaf_town_script@main/red-leaf-town-helper.user.js' },
        { name: 'jsDelivr GCore', url: 'https://gcore.jsdelivr.net/gh/ZGRay00/Red_leaf_town_script@main/red-leaf-town-helper.user.js' },
        { name: 'jsDelivr Fastly', url: 'https://fastly.jsdelivr.net/gh/ZGRay00/Red_leaf_town_script@main/red-leaf-town-helper.user.js' },
        { name: 'GitHub Raw', url: 'https://raw.githubusercontent.com/ZGRay00/Red_leaf_town_script/main/red-leaf-town-helper.user.js' },
    ];
    window[INSTANCE_KEY] = { version: SCRIPT_VERSION };

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
        // 官网构建基线：null = 启动时自动识别当前构建作为基线，运行中检测到构建变化（游戏更新）则暂停，刷新页面即可恢复；
        // 也可填具体构建名（如 'index-XXXX.js'）强制锁定
        expectedBuild: null,
        pauseOnBuildChange: true,
        // 剧情结束后给 /story/:id/seen 留出回写奖励 state 的时间
        storySyncGrace: 1200,
        // aquatic.bigCatch 为 'manual' 时：垂钓出现“大物”则保留体力并暂停自动写操作，等待玩家选择挑战或放生
        pauseOnPendingBigCatch: true,

        farming: {
            enabled: true,            // 自动收获 + 种菜
            autoCollect: true,
            autoPlant: true,
            cropId: null,             // 指定作物 id；null = 自动选择
            strictCropId: true,       // 指定作物无种子/不可种时等待，不偷偷改种其他作物
            prefer: 'first',          // 自动选择策略: 'first' 列表第一种 | 'fastest' 生长最快 | 'slowest' 生长最慢
            autoBuySeeds: true,       // 没种子时自动去商店买（逐粒按需购买；金币不足时按 selling 白名单安全售卖凑钱）
            autoSellForSeeds: true,   // 买种子金币不足时，自动售卖多余物资凑钱（配合 autoBuySeeds）
            seedStrategy: 'portal',   // 种植/购买策略: 'portal' 传送门需求优先，满足后按经济价值 | 'profit' 始终按经济价值最高
            seedShopId: null,         // 可选：强制指定商店条目 id，优先级最高
            autoAssignPartner: true,  // 自动派驻/优化驻场伙伴（有更强的空闲伙伴时自动更换）
        },

        gathering: {
            enabled: true,            // 林野采集：自动领取 + 重新开工
            autoCollect: true,
            autoStart: true,
            taskId: null,             // 指定任务 id；null = 用该点第一个可接任务
            strictTaskId: true,       // 指定任务不存在时等待，不回退到其他任务
            autoAssignPartner: true,  // 采集必须派驻伙伴：自动安排/优化驻场伙伴
        },

        mining: {
            enabled: true,            // 矿山采矿：自动收取 + 重新开工
            autoCollect: true,
            autoStart: true,
            taskId: null,             // 指定任务 id；null = 用该点第一个可接任务
            strictTaskId: true,
            autoAssignPartner: true,  // 自动派驻/优化协助伙伴（不设则会独自采矿）
        },

        crafting: {
            enabled: true,            // 加工总开关默认值；面板「加工启停」开关优先（本地记忆）。站点需在面板配置流程或锁定配方才会开工
            autoCollect: true,
            autoStart: true,
            batchEnabled: true,
            batchLimit: 10,           // 每次提交的份数，最大 99
            staminaReserve: 0,
            useTaskItems: true,
            partialTaskItems: true,   // 道具不足时仅队列前段使用，仍遵守道具保留量
            repeatPipeline: false,
            recipeId: null,           // 指定配方 id；null = 用第一个配方
            strictRecipeId: true,
            autoAssignPartner: true,  // 自动派驻/优化协助伙伴
        },

        aquatic: {
            enabled: true,            // 水产：自动垂钓 + 鱼塘管理
            fishing: true,            // 自动垂钓（消耗体力，当场结算，不占生产格）
            spotId: null,             // 指定钓点 id；null = 沿用聚鱼度所在钓点，否则第一个已解锁钓点
            staminaReserve: 0,        // 垂钓体力保底：实时体力低于该值时不再抛竿，留给其他产业用（同时挖矿时建议设为挖矿单次的体力消耗）
            chainCasts: 5,            // 连钓次数：攒够 N 竿的体力后一次性连钓 N 次（体力恢复比聚鱼度衰退慢，滴钓保不住连击）
            castIntervalMs: 1500,     // 连钓时每竿之间的间隔（服务器限制最小抛竿间隔，太短会被拒并中止本轮）
            reserveBigCatch: true,    // 每次连钓为大物搏斗预留一竿体力（大物消耗 = 当前钓点单竿消耗；仅 bigCatch 为 'fight' 时生效）
            bigCatch: 'fight',        // 大物处理: 'fight' 搏一把 | 'release' 放线 | 'manual' 暂停等人工
            fightMinChance: 0,        // 大物成功率（0~1）低于该值时直接放线
            ponds: true,              // 鱼塘：捞走超出保留线的成鱼（保持世代加值），再用手头鱼苗补到目标尾数
            autoHarvestPonds: true,
            autoStockPonds: true,
            pondKeepStock: 30,        // 捞鱼保留线：成鱼捞到剩 N 尾为止（同时不低于游戏稳态线，取两者较大值）
            pondRestockTarget: 37,    // 投苗目标：捞鱼后用手头鱼苗把塘内总数补到 N（不超过鱼塘容量）
            autoBuildPonds: false,    // 自动挖塘（一次性投入红叶币，默认关闭）
            autoAssignPartner: true,  // 自动安排陪钓/看塘伙伴（水产倾向中挑特性最贴合、能力最强的）
        },

        livestock: {
            enabled: true,            // 畜牧：照料 + 收取 + 派驻（购买/配种/孵蛋需人工决策，不自动化）
            autoCare: false,           // 自动照料动物（每次 1 体力，提高亲密度；只花体力保底之上的余量）
            autoCollect: true,        // 自动收取设施产出（不耗体力）
            autoAssignPartner: true,  // 自动安排看场伙伴（畜牧倾向中挑特性最贴合、能力最强的）
        },

        feed: {
            enabled: false,          // 独立于水产总开关，仅投入商店的“均衡饲料”
            autoBuy: true,
            batchBuy: true,          // 识别每件换算份数后，按缺口和预算批量购买
            thresholdMode: 'percent', // percent = 容量百分比，units = 饲料份数
            low: 20,
            target: 80,
            coinReserve: 1000,
            maxSpendPerTick: 1000,
        },
        sailing: {
            enabled: false,
            autoCollect: true,
            autoStart: false,
            autoBuild: false,
            autoUpgrade: false,
            autoAssign: true,
            reservePartners: true,
            routeId: '',             // 必须在面板明确选择航线
            supplyId: 'none',
            partnerIds: '',          // JSON 数组；留空由空闲伙伴中选择
            partySize: 1,
            staminaReserve: 10,
            coinReserve: 1000,
            maxSpendPerTick: 1000,
            upgradeLimit: 1,
        },
        taskItems: { enabled: true },
        ui: { showGraphs: true, showLogs: true, compact: false, autoStart: true },

        achievements: {
            enabled: true,            // 有可领取的成就奖励时自动一键领取（枫火）
        },

        commissions: {
            enabled: true,            // 每日委托
            autoSubmit: true,         // 库存够时自动交付今日委托（奖励枫火）
            autoTake: true,           // 自动从转发池接单（只动超出传送门/自委托需求的富余物资）
            maxTakesPerTick: 5,       // 单轮最多安全接单次数
        },

        selling: {
            // 额外加入自动售卖范围的物品 id；仍受需求、保留量和永不售卖名单保护。
            allowedItemIds: [],
            // 默认把当前 state 中可识别的农作/采集/采矿产物并入白名单，否则空 allowedItemIds 会让自动售卖永远无候选。
            inferredOutputWhitelist: true,
            includeRareTaskOutputs: false, // 是否把采集/采矿任务中低权重的稀有随机产物也加入自动售卖范围
            neverSellItemIds: [],     // 永不售卖的物品 id
            keepByItemId: {},         // 每种物品最低保留量，例如 { 123: 20 }
            defaultKeep: 5,           // 白名单物品默认至少保留数量
            maxUnitsPerTick: 20,      // 单轮最多卖出数量
            protectLockedPortals: true,
            protectCraftingInputs: true, // 每个加工站为已解锁配方保留至少一批原料
            protectExplorationGear: true, // 永不售卖探索装备（武器/饰品）与探索道具（库存中带 equipment/delve_use 字段），即使误入白名单
        },

        partnerAutoSwap: true,       // 自动换人：已有伙伴的岗位出现更优人选时自动更换（关闭后只补空岗；面板「伙伴」分组可开关，面板设置优先）
        partnerTraitBonus: 20,       // 换人评分时，每个与岗位产业相关的特性折算的能力加成（特性优先于纯能力值比较）
        partnerMinImprovement: 0.05, // 非必需岗位换人至少提升 5%，避免频繁抖动

        rosterScanOnStart: true,      // 启动时自动扫描并打印角色库
    };
    /****************** 配置区结束 ******************/

    // 标量设置统一持久化，兼容旧版开关；配置文件仍提供默认值。
    let settingsRevision = 0;
    const LEGACY_SETTINGS = {
        'crafting.enabled': 'rlt-craft-enabled', 'aquatic.fishing': 'rlt-aquatic-fishing',
        'aquatic.reserveBigCatch': 'rlt-aquatic-reserve-big', 'feed.enabled': 'rlt-feed-auto',
        'livestock.autoCare': 'rlt-livestock-care', 'livestock.autoCollect': 'rlt-livestock-collect',
        'livestock.autoAssignPartner': 'rlt-livestock-partner', 'partnerAutoSwap': 'rlt-partner-auto-swap',
        'aquatic.chainCasts': 'rlt-aquatic-chain', 'aquatic.staminaReserve': 'rlt-aquatic-stamina-reserve',
    };
    function installSettings(object, prefix = '') {
        for (const key of Object.keys(object)) {
            const path = prefix ? `${prefix}.${key}` : key;
            const fallback = object[key];
            if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
                installSettings(fallback, path);
            } else if (['boolean', 'number', 'string'].includes(typeof fallback)) {
                Object.defineProperty(object, key, {
                    enumerable: true, configurable: true,
                    get() {
                        try {
                            const value = JSON.parse(getOverride(`rlt-setting:${path}`) ?? 'null');
                            if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) return value;
                        } catch { /* 损坏的新配置回退到旧配置或默认值 */ }
                        const legacy = LEGACY_SETTINGS[path] && getOverride(LEGACY_SETTINGS[path]);
                        if (legacy != null) {
                            if (typeof fallback === 'boolean' && ['on', 'off'].includes(legacy)) return legacy === 'on';
                            if (typeof fallback === 'number' && Number.isFinite(Number(legacy))) return Number(legacy);
                        }
                        return fallback;
                    },
                    set(value) { setSetting(path, value); },
                });
            }
        }
    }
    function setting(path) { return path.split('.').reduce((value, key) => value?.[key], CONFIG); }
    function setSetting(path, value) {
        setOverride(`rlt-setting:${path}`, JSON.stringify(value));
    }
    installSettings(CONFIG);

    // ---------- 槽位级覆盖配置（localStorage 记忆） ----------
    function getOverride(key) {
        const v = localStorage.getItem(key);
        return v === null || v === '' ? null : v;
    }
    function setOverride(key, value) {
        const next = value == null || value === '' ? null : String(value);
        if (getOverride(key) === next) return false;
        if (next === null) localStorage.removeItem(key);
        else localStorage.setItem(key, next);
        settingsRevision++;
        return true;
    }
    const plotCropKey = slot => `rlt-plot-crop:${slot}`;
    const nodeJobKey = (industry, id) => `rlt-node-job:${industry}:${id}`;
    const AQUATIC_SPOT_KEY = 'rlt-aquatic-spot';
    const nodeTaskItemKey = (industry, id) => `rlt-node-task-item:${industry}:${id}`;
    const nodeTaskItemKeepKey = (industry, id) => `rlt-node-task-item-keep:${industry}:${id}`;
    const plotCropOverride = slot => getOverride(plotCropKey(slot));
    const nodeJobOverride = (industry, id) => getOverride(nodeJobKey(industry, id));
    const NODE_JOB_OFF_RELEASE = '__off';
    const NODE_JOB_OFF_KEEP = '__off_keep';
    const nodeJobClosed = (industry, id) => {
        const value = nodeJobOverride(industry, id);
        return value === NODE_JOB_OFF_RELEASE || value === NODE_JOB_OFF_KEEP;
    };

    // ---------- 加工计划、进度与提交记录（每站最多 4 步） ----------
    const CRAFT_PIPELINE_MAX_STEPS = 4;
    const craftPipelineKey = stationId => `rlt-craft-pipe:${stationId}`;
    const craftPipelineProgKey = stationId => `rlt-craft-pipe-prog:${stationId}`;

    // 读取并校验流程：只保留 recipeId 非空、批次数 ≥1 的步骤，最多 4 步；非法一律视为未配置
    // taskItemId：该步开工携带的道具——'' 跟随站点「道具」行（默认）、'__off' 不使用、其余为指定道具 id
    function craftPipelineSteps(stationId) {
        let raw;
        try { raw = JSON.parse(getOverride(craftPipelineKey(stationId)) || '[]'); }
        catch { return []; }
        if (!Array.isArray(raw)) return [];
        return raw
            .map(s => ({
                recipeId: s?.recipeId ?? '',
                times: Math.floor(Number(s?.times) || 0),
                taskItemId: typeof s?.taskItemId === 'string' ? s.taskItemId : (s?.useItem === false ? '__off' : ''),
            }))
            .filter(s => s.recipeId !== '' && s.times >= 1)
            .slice(0, CRAFT_PIPELINE_MAX_STEPS); // 先过滤无效步再截断，避免无效步占用 4 步名额
    }

    // 进度签名只含配方与批次数：切换某步的道具选择不改变签名，不会误重置进度
    function craftPipelineSig(steps) {
        return JSON.stringify(steps.map(s => ({ recipeId: s.recipeId, times: s.times })));
    }

    // 进度与流程内容绑定：流程被编辑（sig 变化）后进度自动归零，避免新旧步骤错位
    function craftPipelineProgress(stationId, steps) {
        const sig = craftPipelineSig(steps);
        let saved = null;
        try { saved = JSON.parse(getOverride(craftPipelineProgKey(stationId)) || 'null'); }
        catch { saved = null; }
        const done = steps.map((_, i) =>
            Math.max(0, Math.floor(Number(saved?.sig === sig ? saved?.done?.[i] : 0) || 0)));
        const stepIndex = steps.findIndex((s, i) => done[i] < s.times);
        return { done, finished: stepIndex === -1, stepIndex, legacy: saved?.sig === sig && saved?.version !== 2 };
    }

    function advanceCraftPipeline(stationId, steps, stepIndex, count = 1) {
        const prog = craftPipelineProgress(stationId, steps);
        if (stepIndex < 0 || stepIndex >= steps.length) return prog;
        prog.done[stepIndex] = Math.min(steps[stepIndex].times, prog.done[stepIndex] + Math.max(0, count));
        setOverride(craftPipelineProgKey(stationId), JSON.stringify({ version: 2, sig: craftPipelineSig(steps), done: prog.done }));
        return craftPipelineProgress(stationId, steps);
    }

    function resetCraftPipeline(stationId) {
        setOverride(craftPipelineProgKey(stationId), '');
    }

    // 流程启停：默认停止，面板「开始」后置 '1'；停止不清进度，开始后从当前进度继续
    const craftPipelineRunKey = stationId => `rlt-craft-pipe-run:${stationId}`;
    const craftPipelineRunning = stationId => getOverride(craftPipelineRunKey(stationId)) === '1';

    // 锁定配方批次数：0/未设置 = 不限；设 N = 做满 N 批后停工（与流程共用进度存储，靠签名区分模式）
    const craftLockTimesKey = stationId => `rlt-craft-lock-times:${stationId}`;

    const craftFlightKey = id => `rlt-craft-flight:${id}`;
    function readJson(key, fallback = null) {
        try { return JSON.parse(getOverride(key) || 'null') ?? fallback; } catch { return fallback; }
    }
    function craftFlight(id) { return readJson(craftFlightKey(id)); }
    function saveCraftFlight(id, value) { setOverride(craftFlightKey(id), value ? JSON.stringify(value) : ''); }
    function configuredCraftSteps(id) {
        const selected = nodeJobOverride('crafting', id);
        if (selected === NODE_JOB_OFF_RELEASE || selected === NODE_JOB_OFF_KEEP) return [];
        if (selected == null) return craftPipelineSteps(id);
        const times = Math.max(0, Math.floor(Number(getOverride(craftLockTimesKey(id))) || 0));
        return times ? [{ recipeId: selected, times, taskItemId: '' }] : [];
    }
    function craftCollectable(node) {
        return !!node && (Number(node.completed_count || 0) > 0 || (!node.empty && node.ready));
    }
    function creditCraftFlight(id, count) {
        const flight = craftFlight(id);
        if (!flight) return;
        const amount = Math.min(Math.max(0, count), flight.quantity - flight.credited);
        if (amount <= 0) return;
        if (flight.steps?.length) advanceCraftPipeline(id, flight.steps, flight.stepIndex, amount);
        flight.credited += amount;
        saveCraftFlight(id, flight);
    }
    // 服务端队列计数用于恢复刷新/手动领取；不能确认归属或结果时只暂停这个站点。
    function reconcileCraftFlights(state) {
        for (const node of state.crafting_stations || []) {
            const id = node.station_id;
            let flight = craftFlight(id);
            if (!flight) continue;
            const recipe = node.recipe?.id ?? node.recipe?.recipe_id ?? node.task_snapshot?.recipe_id;
            if (flight.phase === 'submitting') {
                flight.phase = 'uncertain';
                flight.reason = '开工结果未确认，请核对游戏队列';
                saveCraftFlight(id, flight);
            }
            if (flight.phase === 'uncertain') continue;
            if (recipe != null && !sameId(recipe, flight.recipeId) && !node.empty) {
                flight.phase = 'uncertain'; flight.reason = '检测到其他加工队列，请核对本批已领取份数';
                saveCraftFlight(id, flight); continue;
            }
            const collected = Number(node.collected_count || 0);
            if (collected > flight.observedCollected) creditCraftFlight(id, collected - flight.observedCollected);
            flight = craftFlight(id);
            flight.observedCollected = Math.max(flight.observedCollected, collected);
            if (flight.credited >= flight.quantity && node.empty) {
                saveCraftFlight(id, null);
            } else if (node.empty && flight.credited < flight.quantity) {
                flight.phase = 'uncertain'; flight.reason = '队列已结束或取消，无法确认剩余部分是否领取';
                saveCraftFlight(id, flight);
            } else saveCraftFlight(id, flight);
        }
    }
    function craftBatchSize(state, node, plan) {
        const cfg = CONFIG.crafting;
        let count = cfg.batchEnabled ? Math.min(99, Math.max(1, Math.floor(cfg.batchLimit))) : 1;
        if (plan.pipeline) count = Math.min(count, plan.pipeline.steps[plan.pipeline.stepIndex].times - plan.pipeline.done[plan.pipeline.stepIndex]);
        const cost = Number(plan.job.stamina_cost || 0);
        if (cost > 0) count = Math.min(count, Math.floor(Math.max(0, liveStamina(state) - cfg.staminaReserve) / cost));
        const totals = new Map();
        for (const input of plan.job.inputs || []) {
            const key = input.item_id ?? input.item?.item_id;
            const qty = Number(input.quantity);
            if (key == null || !Number.isFinite(qty) || qty <= 0) return 0;
            totals.set(String(key), (totals.get(String(key)) || 0) + qty);
        }
        for (const [itemId, quantity] of totals) {
            const safe = safeUnspecifiedConsumeQty(state, itemId, '', { reserveCraftingInputs: false, applyKeep: false });
            count = Math.min(count, Math.floor(safe / quantity));
        }
        if (plan.taskItem) {
            const keep = Math.max(0, Number(getOverride(nodeTaskItemKeepKey('crafting', node.station_id))) || 0);
            const available = Math.max(0, Number(plan.taskItem.quantity || 0) - keep);
            // 服务端按队列逐份预留道具。保留量非零时，限制批量，禁止服务器动用保留部分。
            if (keep > 0 || !cfg.partialTaskItems) count = Math.min(count, available);
        }
        return Math.max(0, Math.floor(count));
    }
    function uncertainWrite(error) {
        return error?.code === 'aborted' || (!isControlFlowError(error) && (isFatalTickError(error) || error?.code === 'invalid_state'));
    }
    async function startCraftPlan(plan) {
        const beforeState = runtime.state;
        const quantity = craftBatchSize(runtime.state, plan.node, plan);
        if (!quantity) return false;
        const flight = {
            phase: 'submitting', recipeId: jobId(plan.job), quantity, credited: 0, observedCollected: 0,
            steps: plan.pipeline?.steps || [], stepIndex: plan.pipeline?.stepIndex ?? 0,
            taskItemChoice: plan.pipeline?.taskItemId || null,
        };
        saveCraftFlight(plan.id, flight); // 写前保存，刷新和网络结果不确定时不会重复开工。
        try {
            await startSite('crafting', plan.id, 'recipe_id', flight.recipeId, plan.taskItemId ?? '', quantity);
            flight.phase = 'active';
            saveCraftFlight(plan.id, flight);
            log(`加工点 ${plan.id}：已提交「${plan.job.name || flight.recipeId}」×${quantity}，领取后累计流程进度`);
            return true;
        } catch (error) {
            // aborted 也可能发生在请求已经发出后，保留待核对记录。
            if (uncertainWrite(error) || error?.code === 'aborted' || runtime.state !== beforeState) {
                flight.phase = 'uncertain'; flight.reason = '开工返回中断，请核对已提交的队列';
                saveCraftFlight(plan.id, flight);
            } else saveCraftFlight(plan.id, null);
            throw error;
        }
    }

    // 自动垂钓总开关：配置允许 + 面板未手动关闭（面板开关优先，记忆在 localStorage）
    function fishingEnabled() { return CONFIG.aquatic.enabled && CONFIG.aquatic.fishing; }
    function fishingChainCasts() { return Math.max(1, Math.floor(CONFIG.aquatic.chainCasts)); }
    function fishingStaminaReserve() { return Math.max(0, Math.floor(CONFIG.aquatic.staminaReserve)); }
    function bigCatchReserveEnabled() { return CONFIG.aquatic.reserveBigCatch; }
    function industryEnabled(industry) { return !!INDUSTRY_ADAPTERS[industry]?.config().enabled; }

    async function processCraftCancel() {
        const request = runtime.cancelCraft;
        if (!request) return;
        runtime.cancelCraft = null;
        const node = nodeById(runtime.state, 'crafting', request.id);
        const recipeId = node?.recipe?.id ?? node?.task_snapshot?.recipe_id;
        if (!node || node.empty || taskReadyAt(node) !== request.readyAt || !sameId(recipeId, request.recipeId)) {
            log('加工队列已变化，本次取消未执行，请重新查看'); return;
        }
        try {
            await mutate('/tasks/cancel', { payload: { industry: 'crafting', slot_id: String(request.id) }, cue: 'action:cancel_crafting' });
            const flight = craftFlight(request.id), fresh = nodeById(runtime.state, 'crafting', request.id);
            if (flight) {
                flight.quantity = flight.credited + Number(fresh?.completed_count || 0);
                flight.phase = 'active';
                saveCraftFlight(request.id, flight.quantity > flight.credited ? flight : null);
            }
            log(`加工点 ${request.id}：队列已取消，本站后续提交已暂停，已完成产物仍可领取`);
        } catch (error) {
            const flight = craftFlight(request.id);
            if (flight && (uncertainWrite(error) || error.code === 'aborted')) {
                flight.phase = 'uncertain'; flight.reason = '取消结果待核对'; saveCraftFlight(request.id, flight);
            }
            throw error;
        }
    }
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
        feedPurchase: null, // 当前页面通过购买响应识别的饲料品质与换算量
    };

    // ---------- 运行生命周期状态 ----------
    let running = false;
    let timer = null;
    let busy = false; // 防止上一轮还没跑完又开新一轮
    let rosterScanned = false; // 角色库是否已自动扫描过
    let wakeRequested = false; // 面板操作请求尽快唤醒主循环

    // 单标签页主节点：持有 Web Lock 的标签页才能运行，避免多页同时写操作
    const TAB_LOCK_NAME = 'rlt-auto-helper-leader';
    let releaseTabLock = null;
    let starting = false;

    let lifecycleRevision = 0;
    let tickSettled = Promise.resolve();
    let retryNotBefore = 0;

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

    function sleep(ms, signal = runtime.controller?.signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(new ApiError('操作已停止', { code: 'aborted' })); return; }
            const onAbort = () => {
                clearTimeout(timeout);
                reject(new ApiError('操作已停止', { code: 'aborted' }));
            };
            const timeout = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, Math.max(0, Number(ms) || 0));
            signal?.addEventListener('abort', onAbort, { once: true });
        });
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

    let buildBaseline = null; // 本次运行识别到的官网构建基线（CONFIG.expectedBuild 为空时启用）

    function validateClientEnvironment() {
        const build = detectedGameBuild();
        if (CONFIG.pauseOnBuildChange) {
            const expected = CONFIG.expectedBuild || buildBaseline;
            if (build && !expected) {
                // 首次识别：以当前构建为基线，不再要求手动维护 expectedBuild
                buildBaseline = build;
                log(`已识别官网构建 ${build}，作为本次运行基线`);
            } else if (build && expected && build !== expected) {
                throw new ApiError(`检测到官网构建从 ${expected} 变为 ${build}，游戏已在运行中更新，请刷新页面后再启动`, {
                    code: 'unknown_build',
                });
            }
            // 构建识别失败（页面结构异常）时不暂停：无法用基线比较，交由 state 结构校验兜底
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
        requireArray('shop', (CONFIG.farming.enabled && CONFIG.farming.autoBuySeeds) || CONFIG.feed.enabled);
        requireArray('gathering_sites', CONFIG.gathering.enabled);
        requireArray('mining_sites', CONFIG.mining.enabled);
        const needsSafeInventory = (CONFIG.commissions.enabled && CONFIG.commissions.autoTake) ||
            (CONFIG.farming.enabled && CONFIG.farming.autoBuySeeds && CONFIG.farming.autoSellForSeeds);
        requireArray('crafting_stations', CONFIG.crafting.enabled ||
            (needsSafeInventory && CONFIG.selling.protectCraftingInputs));
        requireArray('portals', needsSafeInventory ||
            (CONFIG.farming.enabled && CONFIG.farming.seedStrategy === 'portal'));
        if (CONFIG.commissions.enabled && (!state.commissions || typeof state.commissions !== 'object')) {
            errors.push('commissions');
        }
        const needsPartners = (CONFIG.farming.enabled && CONFIG.farming.autoAssignPartner) ||
            (CONFIG.gathering.enabled && CONFIG.gathering.autoAssignPartner) ||
            (CONFIG.mining.enabled && CONFIG.mining.autoAssignPartner) ||
            (CONFIG.crafting.enabled && CONFIG.crafting.autoAssignPartner) ||
            (CONFIG.aquatic.enabled && CONFIG.aquatic.autoAssignPartner) ||
            (CONFIG.livestock.enabled && CONFIG.livestock.autoAssignPartner) || CONFIG.sailing.enabled;
        requireArray('partners', needsPartners);
        // 面板道具下拉和槽位级道具选择都依赖 task_items，任一产业启用即要求该字段
        const needsTaskItems = CONFIG.farming.enabled || CONFIG.gathering.enabled ||
            CONFIG.mining.enabled || CONFIG.crafting.enabled;
        requireArray('task_items', needsTaskItems);

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

    function isFatalTickError(error) {
        return ['network_error', 'request_timeout', 'invalid_response', 'invalid_state',
            'invalid_story_bridge', 'unknown_build', 'action_limit'].includes(error?.code) ||
            [401, 403, 408, 429].includes(Number(error?.status || 0)) || Number(error?.status || 0) >= 500;
    }

    function shouldAbortTick(error) {
        return isControlFlowError(error) || isFatalTickError(error);
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
        validateClientEnvironment(); // 每次写入前复检，消除 tick 预检后的桥接/构建竞态窗口
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
            if (['network_error', 'request_timeout', 'invalid_response', 'aborted'].includes(e.code) ||
                e.status === 408 || e.status >= 500) {
                runtime.stateUncertain = true;
            }
            if (runtime.stateUncertain && runtime.controller && !runtime.controller.signal.aborted) {
                try { await getState(); } catch (_) { /* 下一轮仍会先 GET /state */ }
            }
            throw e;
        }
        markDirty(); // 请求已成功返回；即使随后协议校验失败，也必须在恢复后同步游戏官网 UI
        if (data?.state) {
            try {
                acceptState(data.state);
            } catch (responseError) {
                runtime.stateUncertain = true;
                // 写响应 state 异常时只做一次权威 GET；GET 自身失败则直接交由顶层退避。
                if (runtime.controller && !runtime.controller.signal.aborted) await getState();
                throw responseError;
            }
        } else {
            runtime.stateUncertain = true;
            await getState();
        }
        if (await emitOfficialStoryCue(cue)) runtime.storyWasBusy = true;
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
    const startSite = (industry, siteId, payloadKey, id, taskItemId = '', quantity = 1) =>
        mutate(`${siteUrl(industry, siteId)}/start`, {
            payload: { [payloadKey]: id, task_item_id: taskItemId || '', ...(industry === 'crafting' ? { quantity } : {}) }, cue: `action:start_${industry}`,
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
    const takeCommission = (commissionId) => mutate(`/commissions/${commissionId}/take`, {
        cue: 'action:submit_commission',
    });
    const useTaskItem = (industry, slotId, taskItemId) => mutate('/tasks/use-item', {
        payload: { industry, slot_id: String(slotId), task_item_id: taskItemId },
    });

    // 水产接口（与官网前端一致；抛竿带幂等 request_id）
    const castLine = (spotId) => mutate(`/fishing/spots/${spotId}/cast`, {
        payload: { request_id: crypto.randomUUID() }, cue: 'action:cast_line',
    });
    const resolveBigCatch = (action) => mutate('/fishing/big-catch', {
        payload: { action }, cue: 'action:big_catch',
    });
    const assignFishingCompanion = (partnerId) =>
        mutate('/fishing/companion', { method: 'PUT', payload: { partner_id: partnerId ?? '' } });
    const buildPond = (siteId) => mutate(`/ponds/${siteId}/build`);
    const assignPondPartner = (pondId, partnerId) =>
        mutate(`/ponds/${pondId}/partner`, { method: 'PUT', payload: { partner_id: partnerId ?? '' } });
    const stockPond = (pondId, speciesId, qty) => mutate(`/ponds/${pondId}/stock`, {
        payload: { species_id: speciesId, quantity: qty }, cue: 'action:stock_pond',
    });
    const harvestPond = (pondId, qty) => mutate(`/ponds/${pondId}/harvest`, {
        payload: { quantity: qty }, cue: 'action:harvest_pond',
    });
    const depositFeed = (itemId, quality, count) => mutate('/feed-slot/deposit', {
        payload: { item_id: itemId, quality, count },
    });

    // 畜牧接口（照料每次 1 体力；收取不耗体力，animal_id 传空串 = 整栋全收）
    const careAnimal = (animalId) => mutate(`/livestock/animals/${animalId}/care`, { cue: 'action:care_animal' });
    const collectLivestock = (facilityId) => mutate(`/livestock/facilities/${facilityId}/collect`, {
        payload: { animal_id: '' }, cue: 'action:collect_livestock',
    });
    const assignLivestockPartner = (facilityId, partnerId) =>
        mutate(`/livestock/facilities/${facilityId}/partner`, { method: 'PUT', payload: { partner_id: partnerId ?? '' } });

    // 成就：一键领取全部可领奖励
    const claimAllAchievements = () => mutate('/achievements/claim-all');

    // ---------- 小面板 ----------
    const panel = document.createElement('div');
    panel.id = 'rlt-auto-helper-panel';
    panel.setAttribute('aria-label', '红叶镇自动助手');
    const toggleBtn = document.createElement('button');
    const updateBtn = document.createElement('button');
    updateBtn.textContent = '检查更新';
    updateBtn.title = '检查可信发布源；发现新版本时打开 Tampermonkey 更新确认页';
    const rosterBtn = document.createElement('button');
    rosterBtn.textContent = '伙伴库';
    rosterBtn.title = '扫描并打印当前角色库';
    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '—';
    collapseBtn.title = '收起/展开面板';
    const statusLine = document.createElement('span');
    statusLine.style.cursor = 'move'; // 按住状态行可拖动面板
    statusLine.title = '按住可拖动面板';
    const logBox = document.createElement('div');
    // 只有日志区滚动，按钮行始终固定在面板顶部
    const brand = document.createElement('div');
    brand.className = 'rlt-brand';
    brand.innerHTML = `<span class="rlt-brand-icon" aria-hidden="true">🍁</span><div><strong>红叶镇 · 管理手册</strong><small>生产有序，远航可期 · v${SCRIPT_VERSION}</small></div>`;
    brand.appendChild(collapseBtn);
    panel.appendChild(brand);
    const toolbar = document.createElement('div');
    toolbar.className = 'rlt-toolbar';
    toolbar.append(toggleBtn, updateBtn, rosterBtn);
    panel.appendChild(toolbar);
    panel.appendChild(statusLine);
    const tabBar = document.createElement('nav');
    tabBar.className = 'rlt-tabs';
    tabBar.setAttribute('aria-label', '助手功能导航');
    const dashboard = document.createElement('div');
    dashboard.className = 'rlt-dashboard';
    panel.append(tabBar, dashboard);

    // 槽位配置区：每块土地/采集点/矿点/加工站各一行下拉，选择记忆在 localStorage
    const configBox = document.createElement('div');
    configBox.className = 'rlt-config';
    logBox.className = 'rlt-log';
    panel.appendChild(configBox);
    panel.appendChild(logBox);
    document.body.appendChild(panel);
    let activeDashboardPage = getOverride('rlt-ui-page') || 'overview';
    let lastConfigState = null;
    let lastConfigRevision = -1;
    let lastConfigActivity = null;
    let lastConfigPage = null;
    const pageScroll = new Map();
    let dashboardTimer = null;

    function uiElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text != null) element.textContent = text;
        return element;
    }
    function applyDashboardPage() {
        const isCollapsed = panel.classList.contains('rlt-collapsed');
        dashboard.style.display = !isCollapsed && activeDashboardPage === 'overview' ? '' : 'none';
        configBox.style.display = !isCollapsed && activeDashboardPage !== 'overview' ? '' : 'none';
        logBox.style.display = !isCollapsed && CONFIG.ui.showLogs ? '' : 'none';
        panel.classList.toggle('rlt-compact', CONFIG.ui.compact);
        panel.classList.toggle('rlt-no-graphs', !CONFIG.ui.showGraphs);
        for (const button of tabBar.children) {
            const selected = button.dataset.page === activeDashboardPage;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-current', selected ? 'page' : 'false');
        }
    }
    function initializeDashboard() {
        const style = uiElement('style');
        style.textContent = `
        #rlt-auto-helper-panel{--rlt-text:#eef3e9;--rlt-muted:#adb9a9;--rlt-accent:#dca46d;--rlt-line:#3b493b;position:fixed;right:12px;bottom:12px;z-index:99999;box-sizing:border-box;width:470px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;padding:16px;border:1px solid #687458;border-radius:20px;background:linear-gradient(145deg,#253328,#15211c);box-shadow:0 18px 65px #0008;color:var(--rlt-text);font:13px/1.6 system-ui,'Microsoft YaHei',sans-serif;overflow:hidden;color-scheme:dark}
        #rlt-auto-helper-panel *{box-sizing:border-box}
        #rlt-auto-helper-panel button,#rlt-auto-helper-panel input,#rlt-auto-helper-panel select{font:inherit!important;line-height:1.45!important;border-radius:8px!important;min-height:30px;outline-offset:3px}
        #rlt-auto-helper-panel button{cursor:pointer;transition:filter .15s}
        #rlt-auto-helper-panel button:hover{filter:brightness(1.16)}
        #rlt-auto-helper-panel button:disabled{opacity:.45;cursor:not-allowed}
        #rlt-auto-helper-panel :focus-visible{outline:2px solid var(--rlt-accent)}
        #rlt-auto-helper-panel select{min-width:0;max-width:none!important;padding:5px 7px!important}
        #rlt-auto-helper-panel input{padding:5px!important}
        #rlt-auto-helper-panel small{font-size:11px;color:var(--rlt-muted)}
        #rlt-auto-helper-panel .rlt-brand{display:flex;align-items:center;gap:10px;margin-bottom:12px}
        #rlt-auto-helper-panel .rlt-brand>div{flex:1}
        #rlt-auto-helper-panel .rlt-brand strong{display:block;font-size:18px;letter-spacing:1px}
        #rlt-auto-helper-panel .rlt-brand small{display:block;margin-top:1px}
        #rlt-auto-helper-panel .rlt-brand-icon{font-size:29px;background:#ffffff09;border:1px solid #a4855d66;border-radius:13px;padding:3px 8px}
        #rlt-auto-helper-panel .rlt-toolbar{display:flex;gap:7px;margin-bottom:8px}
        #rlt-auto-helper-panel .rlt-toolbar button{flex:1;margin:0!important;padding:7px!important}
        #rlt-auto-helper-panel .rlt-toolbar+span{font-size:11px;color:var(--rlt-muted);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:19px}
        #rlt-auto-helper-panel .rlt-tabs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px;padding:9px 0 11px;flex-shrink:0;border-bottom:1px solid var(--rlt-line)}
        #rlt-auto-helper-panel .rlt-tabs button{background:transparent;border:0;color:#adb9a9;padding:7px 0}
        #rlt-auto-helper-panel .rlt-tabs .selected{background:#dca46d;color:#20271c;font-weight:700}
        #rlt-auto-helper-panel .rlt-dashboard{overflow:auto;min-height:0;padding:12px 2px 4px;max-height:52vh;scrollbar-width:thin}
        #rlt-auto-helper-panel .rlt-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
        #rlt-auto-helper-panel .rlt-stat{background:#ffffff06;border:1px solid var(--rlt-line);border-radius:12px;padding:10px}
        #rlt-auto-helper-panel .rlt-stat strong{display:block;font-size:20px;font-variant-numeric:tabular-nums}
        #rlt-auto-helper-panel .rlt-stat small{display:block}
        #rlt-auto-helper-panel .rlt-meter{height:6px;border-radius:6px;background:#080e0980;overflow:hidden;margin:8px 0 3px}
        #rlt-auto-helper-panel .rlt-meter>i{height:100%;display:block;background:linear-gradient(90deg,#7d9c69,#c9d49e);border-radius:6px;transition:width .5s}
        #rlt-auto-helper-panel .rlt-section-label{font-size:12px;letter-spacing:1px;color:#dca46d;margin:16px 0 8px}
        #rlt-auto-helper-panel .rlt-work{padding:9px 11px;background:#ffffff05;border:1px solid var(--rlt-line);border-radius:10px;margin:6px 0}
        #rlt-auto-helper-panel .rlt-work-head{display:flex;justify-content:space-between;gap:8px}
        #rlt-auto-helper-panel .rlt-work-head>span:last-child{color:var(--rlt-muted);font-size:11px}
        #rlt-auto-helper-panel .rlt-empty{color:var(--rlt-muted);font-size:12px;margin:8px 0}
        #rlt-auto-helper-panel .rlt-voyage{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px dashed #8ba39855;color:#9db9b5}
        #rlt-auto-helper-panel .rlt-voyage b{font-size:26px}
        #rlt-auto-helper-panel .rlt-warning{color:#e4b185;font-size:12px;margin:8px 0}
        #rlt-auto-helper-panel .rlt-note{color:var(--rlt-muted);font-size:12px;margin:7px 0}
        #rlt-auto-helper-panel .rlt-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
        #rlt-auto-helper-panel .rlt-group{border:1px solid var(--rlt-line);border-radius:12px;background:#ffffff04;padding:9px 11px;margin:8px 0}
        #rlt-auto-helper-panel .rlt-group[hidden]{display:none}
        #rlt-auto-helper-panel .rlt-group-title{width:100%;text-align:left;border:0;background:none;color:var(--rlt-text);font-weight:700;margin:0!important;padding:2px 0 6px}
        #rlt-auto-helper-panel .rlt-group-title+div{margin:0!important;padding:0!important;border:0!important}
        #rlt-auto-helper-panel .rlt-switch{margin-left:auto!important;min-width:78px;border-radius:16px!important;padding:4px 10px!important}
        #rlt-auto-helper-panel .rlt-switch[aria-checked=true]::before{content:'● ';font-size:9px}
        #rlt-auto-helper-panel .rlt-switch[aria-checked=false]::before{content:'○ ';font-size:9px}
        #rlt-auto-helper-panel .rlt-group label{display:block}
        #rlt-auto-helper-panel .rlt-group .rlt-work{margin:9px 0}
        #rlt-auto-helper-panel .rlt-status-chip{display:inline-block;color:#d6dfb9;background:#8ead7118;padding:2px 8px;border-radius:10px}
        #rlt-auto-helper-panel.rlt-no-graphs .rlt-meter,#rlt-auto-helper-panel.rlt-no-graphs .rlt-voyage{display:none}
        #rlt-auto-helper-panel.rlt-collapsed{width:280px}
        #rlt-auto-helper-panel.rlt-collapsed>:not(.rlt-brand){display:none!important}
        #rlt-auto-helper-panel.rlt-collapsed .rlt-brand{margin:0}
        #rlt-auto-helper-panel.rlt-compact{padding:10px!important;font-size:12px!important}
        #rlt-auto-helper-panel.rlt-compact .rlt-group{padding:6px 9px}
        #rlt-auto-helper-panel .rlt-footer{font-size:10px;color:#91a18a;margin-top:12px}
        @media(max-width:540px),(pointer:coarse){#rlt-auto-helper-panel{right:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));max-width:calc(100vw - 16px)!important;padding:11px!important;border-radius:14px!important}
        #rlt-auto-helper-panel .rlt-brand strong{font-size:16px}
        #rlt-auto-helper-panel .rlt-group select{font-size:11px!important}
        #rlt-auto-helper-panel .rlt-stats{gap:5px}
        #rlt-auto-helper-panel .rlt-stat{padding:7px}
        #rlt-auto-helper-panel .rlt-stat strong{font-size:17px}
        #rlt-auto-helper-panel.rlt-collapsed{width:48px;height:48px;padding:0!important;border-radius:50%!important;bottom:calc(80px + env(safe-area-inset-bottom,0px));box-shadow:0 3px 12px #0005}
        #rlt-auto-helper-panel.rlt-collapsed .rlt-brand{width:100%;height:100%;gap:0}
        #rlt-auto-helper-panel.rlt-collapsed .rlt-brand>div,#rlt-auto-helper-panel.rlt-collapsed .rlt-brand-icon{display:none}
        #rlt-auto-helper-panel.rlt-collapsed .rlt-brand>button{width:100%;height:100%;margin:0;padding:0;background:transparent;border-radius:50%!important;font-size:0!important;touch-action:none;user-select:none;-webkit-user-select:none}
        #rlt-auto-helper-panel.rlt-collapsed .rlt-brand>button::before{content:'🍁';font-size:25px;line-height:1}
        #rlt-auto-helper-panel.rlt-collapsed .rlt-brand>button:focus-visible{outline-offset:-4px}}
        #rlt-auto-helper-panel .rlt-toolbar+span{touch-action:none;user-select:none;-webkit-user-select:none}
        #rlt-auto-helper-panel .rlt-config{min-height:0;max-height:54vh;overflow:auto;scrollbar-width:thin;padding:2px}
        #rlt-auto-helper-panel .rlt-log{font-size:11px;white-space:pre-wrap;max-height:100px;flex-shrink:1;overflow:auto;border-top:1px solid var(--rlt-line);margin-top:10px;padding-top:8px;scrollbar-width:thin}
        #rlt-auto-helper-panel .rlt-toolbar button,#rlt-auto-helper-panel .rlt-brand>button{background:#8ead71;color:#17211b;border:0;font-weight:700;padding:4px 10px}
        #rlt-auto-helper-panel .rlt-control{margin-top:6px;display:flex;align-items:center;gap:8px;min-width:0}
        #rlt-auto-helper-panel .rlt-control>span{opacity:.85;overflow-wrap:anywhere;flex-shrink:0;max-width:48%}
        #rlt-auto-helper-panel .rlt-input{background:#17211b;color:#e8e0cf;border:1px solid #555f52;min-width:0}
        #rlt-auto-helper-panel select.rlt-input{flex:1}
        #rlt-auto-helper-panel .rlt-switch{border:0;background:#555f52;color:#e8e0cf}
        #rlt-auto-helper-panel .rlt-switch[aria-checked=true]{background:#8ead71;color:#17211b}
        #rlt-auto-helper-panel [hidden]{display:none!important}
        @media(prefers-reduced-motion:reduce){#rlt-auto-helper-panel *{transition:none!important}}
        `;
        document.head.appendChild(style);
        const pages = [['overview', '概览'], ['production', '生产'], ['crafting', '加工'], ['sailing', '航海'], ['feed', '饲料'], ['settings', '设置']];
        if (!pages.some(([id]) => id === activeDashboardPage)) activeDashboardPage = 'overview';
        for (const [id, name] of pages) {
            const button = uiElement('button', '', name);
            button.dataset.page = id;
            button.onclick = () => {
                if (id === activeDashboardPage) return;
                if (configBox.contains(document.activeElement)) document.activeElement.blur();
                pageScroll.set(activeDashboardPage, configBox.scrollTop);
                activeDashboardPage = id; localStorage.setItem('rlt-ui-page', id);
                refreshConfigRows(currentViewState());
                applyDashboardPage();
            };
            tabBar.appendChild(button);
        }
        configBox.addEventListener('focusout', () => setTimeout(() => refreshConfigRows(currentViewState()), 0));
        configBox.addEventListener('change', () => {
            wakeSoon();
            setTimeout(() => refreshConfigRows(currentViewState()), 0);
        });
        startDashboardTimer();
        applyDashboardPage();
    }
    function currentViewState() {
        const gameState = getPageStore('game')?.state;
        return (running || busy ? runtime.state || gameState : gameState || runtime.state) || { inventory: [] };
    }
    function startDashboardTimer() {
        if (dashboardTimer !== null) return;
        dashboardTimer = setInterval(() => {
            if (!document.hidden && activeDashboardPage === 'overview') renderDashboard(currentViewState());
        }, 1000);
    }
    function durationLabel(seconds) {
        const value = Math.max(0, Math.ceil(Number(seconds) || 0));
        if (value >= 3600) return `${Math.floor(value / 3600)}时${Math.floor(value % 3600 / 60)}分`;
        return value >= 60 ? `${Math.floor(value / 60)}分${value % 60}秒` : `${value}秒`;
    }
    function meter(value, label) {
        const bar = uiElement('div', 'rlt-meter');
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', label);
        const percent = Math.max(0, Math.min(100, Number(value) || 0));
        bar.setAttribute('aria-valuenow', String(Math.round(percent))); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
        const fill = uiElement('i'); fill.style.width = `${percent}%`; bar.appendChild(fill);
        return bar;
    }
    function workCard(name, status, percent = null, note = '') {
        const card = uiElement('div', 'rlt-work');
        const head = uiElement('div', 'rlt-work-head'); head.append(uiElement('strong', '', name), uiElement('span', '', status));
        card.appendChild(head);
        if (percent != null) card.appendChild(meter(percent, name));
        if (note) card.appendChild(uiElement('small', '', note));
        return card;
    }
    const dashboardViews = new Map();
    function setText(element, value) {
        const text = String(value ?? '');
        if (element.textContent !== text) element.textContent = text;
    }
    function updateMeter(bar, value, label) {
        bar.hidden = value == null;
        const percent = Math.max(0, Math.min(100, Number(value) || 0));
        bar.setAttribute('aria-label', label);
        bar.setAttribute('aria-valuenow', String(Math.round(percent)));
        bar.children[0].style.width = `${percent}%`;
    }
    function dashboardCard(stat = false) {
        const element = uiElement('div', stat ? 'rlt-stat' : 'rlt-work');
        const title = uiElement(stat ? 'small' : 'strong');
        const value = uiElement(stat ? 'strong' : 'span');
        const bar = meter(0, ''), note = uiElement('small');
        if (stat) element.append(title, value);
        else { const head = uiElement('div', 'rlt-work-head'); head.append(title, value); element.appendChild(head); }
        element.append(bar, note);
        return { element, update(name, status, percent = null, detail = '') {
            setText(title, name); setText(value, status); setText(note, detail);
            note.hidden = !detail; updateMeter(bar, percent, name);
        } };
    }
    function renderDashboard(state) {
        if (!state || activeDashboardPage !== 'overview' || panel.classList.contains('rlt-collapsed')) return;
        const scroll = dashboard.scrollTop, next = [], keys = new Set();
        const use = (key, create, update) => {
            let view = dashboardViews.get(key);
            if (!view) { view = create(); dashboardViews.set(key, view); }
            update(view); keys.add(key); next.push(view.element);
        };
        const text = (key, tag, className, value) => use(key, () => ({ element: uiElement(tag, className) }), view => setText(view.element, value));
        const card = (key, ...values) => use(key, () => dashboardCard(), view => view.update(...values));
        if (!state.player) text('empty', 'p', 'rlt-empty', '登录游戏后显示生产概况。可先切换标签配置各功能。');
        else {
            const now = serverNowSeconds(), stamina = liveStamina(state), cap = Number(state.player.stamina_cap || 0);
            use('stats', () => {
                const element = uiElement('div', 'rlt-stats'), cards = [dashboardCard(true), dashboardCard(true), dashboardCard(true)];
                element.append(...cards.map(view => view.element)); return { element, cards };
            }, view => {
                view.cards[0].update('⚡ 体力', `${Math.floor(stamina)} / ${cap}`, cap ? stamina / cap * 100 : null);
                view.cards[1].update('◈ 红叶币', playerCoins(state).toLocaleString());
                view.cards[2].update('▣ 库存估值', Math.round(memoizedForState(state, 'inventoryValue', () => inventoryTotalValue(state))).toLocaleString());
            });
            text('production-title', 'h3', 'rlt-section-label', '生产进度');
            let count = 0;
            const groups = [['农田', state.plots, 'farming'], ['采集', state.gathering_sites, 'gathering'], ['采矿', state.mining_sites, 'mining'], ['加工', state.crafting_stations, 'crafting']];
            for (const [name, nodes, industry] of groups) for (const [index, node] of (nodes || []).entries()) {
                if (node.empty) continue;
                count++;
                const readyAt = taskReadyAt(node), started = Number(node.task_snapshot?.started_at ?? node.planted_at ?? node.started_at ?? 0);
                const progress = node.ready ? 100 : started > 0 && readyAt > started ? (now - started) / (readyAt - started) * 100 : null;
                const readyCount = Number(node.completed_count || 0);
                const status = industry === 'crafting' && readyCount > 0 ? `${readyCount} 份可领` : node.ready ? '待领取' : readyAt > now ? durationLabel(readyAt - now) : '等待结算';
                const nameText = node.definition?.name || `${name} ${node.slot != null ? Number(node.slot) + 1 : node.site_id ?? node.station_id}`;
                card(`${industry}:${node.slot ?? node.site_id ?? node.station_id ?? index}`, nameText, status, progress, node.recipe?.name || node.crop?.name || node.task?.name || '');
            }
            if (!count) text('production-empty', 'p', 'rlt-empty', '暂无进行中的生产任务');
            text('sea-title', 'h3', 'rlt-section-label', '航海与饲料');
            const sail = state.sailing?.active_run;
            if (sail) {
                use('voyage', () => {
                    const element = uiElement('div', 'rlt-voyage'), destination = uiElement('span');
                    element.append(uiElement('span', '', '红叶港'), uiElement('b', '', '⛵'), destination); return { element, destination };
                }, view => setText(view.destination, sail.route_name || '远方海域'));
                card('sailing', sail.route_name || '航海', sail.ready_at <= now ? '已回港' : durationLabel(sail.ready_at - now), (now - sail.started_at) / Math.max(1, sail.ready_at - sail.started_at) * 100);
            } else card('sailing', '初帆号', CONFIG.sailing.enabled ? '港口待命' : '自动航海关闭');
            const slot = state.aquatic?.feed_slot;
            if (slot) {
                const bounds = feedThresholds(slot);
                card('feed', '均衡饲料', `${Math.floor(slot.units)} / ${slot.capacity} 份`, slot.capacity > 0 ? slot.units / slot.capacity * 100 : null,
                    bounds.valid ? `底限 ${Math.floor(bounds.low)} → 目标 ${Math.ceil(bounds.target)} 份 · ${CONFIG.feed.enabled ? '自动补充' : '自动补充关闭'}` : '请检查上下限设置');
            }
            text('footer', 'div', 'rlt-footer', `状态同步 ${state.server_time ? new Date(state.server_time * 1000).toLocaleTimeString() : '待同步'} · ${running ? '助手运行中' : '助手已停止'}`);
        }
        for (const key of dashboardViews.keys()) if (!keys.has(key)) dashboardViews.delete(key);
        if (next.length !== dashboard.children.length || next.some((node, index) => node !== dashboard.children[index])) dashboard.replaceChildren(...next);
        dashboard.scrollTop = scroll;
    }
    function appendSetting(body, state, path, label, options = {}) {
        const value = setting(path);
        if (typeof value === 'boolean') {
            body.appendChild(makeToggleRow(state, label, options.title || label, value, () => setSetting(path, !setting(path)), path));
        } else if (typeof value === 'number') {
            body.appendChild(makeNumberRow(label, value, { min: 0, title: label, ...options, onchange: number => setSetting(path, number) }));
        } else if (options.choices) {
            const { row, select } = makeSelectRow(label, options.title || label);
            fillSelect(select, options.choices, value || null, options.empty || '请选择');
            select.onchange = () => { setSetting(path, select.value); if (path.startsWith('feed.')) setOverride(FEED_FILL_KEY, ''); wakeSoon(); };
            body.appendChild(row);
        }
    }
    function renderModuleSettings(state, activePage) {
        const sections = [
            ['农场开关', 'production', [['farming.enabled', '农场总开关'], ['farming.autoCollect', '自动收获'], ['farming.autoPlant', '自动种植'], ['farming.autoBuySeeds', '自动买种'], ['farming.autoSellForSeeds', '卖出余料凑种子钱'], ['farming.autoAssignPartner', '农场伙伴派驻']]],
            ['采集与采矿开关', 'production', [['gathering.enabled', '采集总开关'], ['gathering.autoCollect', '采集自动领取'], ['gathering.autoStart', '采集自动开工'], ['gathering.autoAssignPartner', '采集伙伴派驻'], ['mining.enabled', '采矿总开关'], ['mining.autoCollect', '采矿自动领取'], ['mining.autoStart', '采矿自动开工'], ['mining.autoAssignPartner', '采矿伙伴派驻']]],
            ['水产与畜牧开关', 'production', [['aquatic.enabled', '水产总开关'], ['aquatic.fishing', '自动垂钓'], ['aquatic.ponds', '鱼塘管理'], ['aquatic.autoBuildPonds', '自动挖塘'], ['aquatic.autoAssignPartner', '水产伙伴派驻'], ['livestock.enabled', '畜牧总开关'], ['livestock.autoCollect', '畜牧自动收取'], ['livestock.autoCare', '畜牧自动照料'], ['livestock.autoAssignPartner', '畜牧伙伴派驻']]],
            ['加工策略', 'crafting', [['crafting.enabled', '加工总开关'], ['crafting.autoStart', '自动提交队列'], ['crafting.autoCollect', '自动领取成品'], ['crafting.batchEnabled', '批量加工'], ['crafting.autoAssignPartner', '加工伙伴派驻'], ['crafting.useTaskItems', '加工使用道具'], ['crafting.partialTaskItems', '道具不足时部分使用'], ['crafting.repeatPipeline', '流程完成后循环'], ['crafting.batchLimit', '每次最多份数', { min: 1, max: 99 }], ['crafting.staminaReserve', '加工体力保底']]],
            ['均衡饲料策略', 'feed', [['feed.enabled', '自动补充饲料'], ['feed.autoBuy', '库存不足自动购买'], ['feed.batchBuy', '批量购买均衡饲料'], ['feed.thresholdMode', '上下限单位', { choices: [{ value: 'percent', text: '容量百分比（%）' }, { value: 'units', text: '饲料份数' }] }], ['feed.low', '触发底限', { max: CONFIG.feed.thresholdMode === 'percent' ? 99 : Number.MAX_SAFE_INTEGER }], ['feed.target', '填充至', { min: 1, max: CONFIG.feed.thresholdMode === 'percent' ? 100 : Number.MAX_SAFE_INTEGER }], ['feed.coinReserve', '购买后金币保底'], ['feed.maxSpendPerTick', '每轮购买预算']]],
            ['每日事务', 'settings', [['commissions.enabled', '委托总开关'], ['commissions.autoSubmit', '自动交付自己的委托'], ['commissions.autoTake', '自动接取转发委托'], ['achievements.enabled', '自动领取成就']]],
            ['显示与工具', 'settings', [['ui.showGraphs', '图形进度与航线'], ['ui.showLogs', '显示操作日志'], ['ui.compact', '紧凑布局'], ['ui.autoStart', '刷新后自动启动'], ['taskItems.enabled', '特殊道具总开关'], ['partnerAutoSwap', '允许自动换人']]],
        ];
        for (const [title, page, fields] of sections) {
            if (page !== activePage) continue;
            const { group, body } = makeGroup(title, page);
            for (const [path, label, options] of fields) appendSetting(body, state, path, label, options || {});
            if (page === 'feed') {
                body.appendChild(uiElement('p', 'rlt-note', '只购买并投入商店中的“均衡饲料”。达到底限后补至目标；整件投料可能略超目标，始终不超容量。预算为 0 时不购买。'));
                const slot = state.aquatic?.feed_slot;
                if (slot) {
                    const bounds = feedThresholds(slot);
                    body.appendChild(workCard('饲料余量', `${Math.floor(slot.units)} / ${slot.capacity} 份`, slot.units / slot.capacity * 100,
                        bounds.valid ? `触发 ${Math.floor(bounds.low)} 份 → 补至 ${Math.ceil(bounds.target)} 份` : '上下限无效，自动补料暂停'));
                }
            }
            if (page === 'crafting') body.appendChild(uiElement('p', 'rlt-note', '流程按已领取份数推进。暂停后续提交不会取消服务器队列；总开关关闭后，自动领取也会暂停。'));
            configBox.appendChild(group);
        }
        if (activePage !== 'production') return;
        const { group, body } = makeGroup('鱼塘与大物设置', 'production');
        appendSetting(body, state, 'aquatic.autoHarvestPonds', '自动捞成鱼');
        appendSetting(body, state, 'aquatic.autoStockPonds', '自动补鱼苗');
        appendSetting(body, state, 'aquatic.pondKeepStock', '成鱼保留尾数');
        appendSetting(body, state, 'aquatic.pondRestockTarget', '补苗目标尾数');
        appendSetting(body, state, 'aquatic.bigCatch', '大物处理', { choices: [{ value: 'fight', text: '体力够时挑战' }, { value: 'release', text: '放线' }, { value: 'manual', text: '暂停并手动处理' }] });
        configBox.appendChild(group);
    }

    function makeCraftQueueCard(state, node) {
        const id = node.station_id, flight = craftFlight(id), steps = configuredCraftSteps(id);
        const progress = craftPipelineProgress(id, steps);
        const total = steps.reduce((sum, step) => sum + step.times, 0);
        const done = progress.done.reduce((sum, value) => sum + value, 0);
        const card = workCard(node.definition?.name || `加工点 ${id}`,
            flight?.phase === 'uncertain' ? '需要核对' : node.empty ? '空闲' : `${Number(node.completed_count || 0)} 份可领取`,
            total ? done / total * 100 : null,
            total ? `流程已领取 ${done} / ${total} 份` : '锁定配方可设置总份数，0 为持续生产');
        if (!node.empty) card.appendChild(uiElement('p', 'rlt-note', `队列 ${node.queue_total || flight?.quantity || 1} 份 · 待加工 ${node.queued_count || 0} 份 · 剩余约 ${durationLabel(node.queue_remaining_seconds || Math.max(0, taskReadyAt(node) - serverNowSeconds()))}`));
        const paused = getOverride(`rlt-craft-paused:${id}`) === '1';
        card.appendChild(makeToggleRow(state, '本站允许提交', '只控制后续开工，已提交的队列继续执行', !paused, () => setOverride(`rlt-craft-paused:${id}`, paused ? '' : '1'), `craft:${id}:submit`));
        if (progress.legacy) card.appendChild(uiElement('p', 'rlt-warning', '旧版以开工次数计数，请在本站空闲时重置为新版领取进度。'));
        if (steps.length) {
            const reset = uiElement('button', '', '重置本站进度');
            reset.disabled = !!flight || !node.empty || busy;
            reset.onclick = () => {
                const fresh = nodeById(runtime.state || state, 'crafting', id);
                if (busy || !fresh?.empty || craftFlight(id)) return;
                if (!window.confirm('将已领取进度归零，下次从头执行当前配置。是否重置？')) return;
                resetCraftPipeline(id); reset.blur(); wakeSoon(); refreshConfigRows(runtime.state || state);
            };
            card.appendChild(reset);
        }
        if (flight?.phase === 'uncertain') {
            card.appendChild(uiElement('p', 'rlt-warning', flight.reason || '请核对游戏中的加工状态'));
            const actions = uiElement('div', 'rlt-actions');
            const count = makeNumberInput(flight.credited, { min: flight.credited, max: flight.quantity, title: '本批累计已领取份数（不是队列总数）' });
            const settle = uiElement('button', '', '确认已领取份数');
            settle.disabled = busy || !node.empty;
            settle.title = '队列结束后填写本批累计已领取数量；未完成份数仍留在流程中';
            settle.onclick = () => {
                const fresh = nodeById(runtime.state || state, 'crafting', id);
                const current = craftFlight(id);
                if (busy || !fresh?.empty || !current) return;
                const value = Math.min(current.quantity, Math.max(current.credited, Math.floor(Number(count.value) || 0)));
                if (!window.confirm(`确认本批已累计领取 ${value} / ${current.quantity} 份？流程将按此数量结算。`)) return;
                creditCraftFlight(id, value - current.credited); saveCraftFlight(id, null);
                settle.blur(); wakeSoon(); refreshConfigRows(runtime.state || state);
            };
            actions.append(count, settle); card.appendChild(actions);
            if (!node.empty) {
                const adopt = uiElement('button', '', '确认这是本批队列');
                adopt.disabled = busy;
                adopt.onclick = () => {
                    const fresh = nodeById(runtime.state || state, 'crafting', id), current = craftFlight(id);
                    if (busy || !fresh || fresh.empty || !current) return;
                    const recipeId = fresh.recipe?.id ?? fresh.recipe?.recipe_id ?? fresh.task_snapshot?.recipe_id;
                    if (!sameId(recipeId, current.recipeId) || Number(fresh.queue_total || 1) !== current.quantity) {
                        log('当前配方或队列数量与本批不符，无法接管'); return;
                    }
                    if (!window.confirm('确认游戏中当前队列由本次助手提交？确认后恢复自动领取与计数。')) return;
                    current.phase = 'active'; current.reason = ''; saveCraftFlight(id, current);
                    adopt.blur(); wakeSoon(); refreshConfigRows(runtime.state || state);
                };
                card.appendChild(adopt);
            }
        }
        if (!node.empty && node.task_snapshot && Number(node.queued_count || 0) >= 0) {
            const cancel = uiElement('button', '', '取消本站队列');
            cancel.disabled = !running || busy;
            cancel.onclick = () => {
                if (!running || busy) return;
                if (!window.confirm('取消会损失当前一份的投入；未开始部分退回，已完成产物保留。本站后续提交会暂停。是否继续？')) return;
                runtime.cancelCraft = { id, recipeId: node.recipe?.id ?? node.task_snapshot?.recipe_id, readyAt: taskReadyAt(node) };
                setOverride(`rlt-craft-paused:${id}`, '1');
                wakeSoon(); cancel.disabled = true;
            };
            card.appendChild(cancel);
        }
        return card;
    }
    function renderSailingSettings(state) {
        const { group, body } = makeGroup('航海', 'sailing');
        const fields = [['sailing.enabled', '航海总开关'], ['sailing.autoCollect', '到港自动领取'], ['sailing.autoStart', '自动再次出航'], ['sailing.autoBuild', '自动建造初帆号'], ['sailing.autoUpgrade', '自动改装船舶'], ['sailing.upgradeLimit', '改装目标等级', { min: 1, max: 3 }], ['sailing.autoAssign', '未指定时选择空闲伙伴'], ['sailing.reservePartners', '为航海保留指定伙伴'], ['sailing.partySize', '自动选人数量', { min: 1, max: 3 }], ['sailing.staminaReserve', '出航后体力保底'], ['sailing.coinReserve', '花费后金币保底'], ['sailing.maxSpendPerTick', '每轮花费预算']];
        for (const [path, label, options] of fields) appendSetting(body, state, path, label, options || {});
        const sail = state.sailing;
        if (!sail?.unlocked) body.appendChild(uiElement('p', 'rlt-note', '航海尚未解锁或游戏数据未加载。开关与预算可提前设置。'));
        appendSetting(body, state, 'sailing.routeId', '航线', { choices: (sail?.routes || []).map(route => ({ value: route.id, text: `${route.name} · ${durationLabel(route.duration)} · ${route.coins} 币 / ${route.stamina} 体力`, disabled: !route.unlocked })), empty: '请选择航线（未选不出航）' });
        appendSetting(body, state, 'sailing.supplyId', '航海补给', { choices: [{ value: 'none', text: '基础补给' }, ...(sail?.supplies || []).filter(supply => supply.id !== 'none').map(supply => ({ value: supply.id, text: `${supply.name} · ${supply.owned ?? 0}/${supply.quantity ?? 0}` }))], empty: '请选择补给' });
        const selected = sailingConfiguredIds();
        const partnerSelectors = [];
        for (let index = 0; index < 3; index++) {
            const { row, select } = makeSelectRow(`伙伴 ${index + 1}`, '明确指定的伙伴忙碌时等待，不撤销其他岗位派驻');
            fillSelect(select, (state.partners || []).map(partner => ({ value: partnerRecordId(partner), text: `${partner.name}${partner.locked ? '（忙碌）' : ''}`, disabled: selected.some((id, slot) => slot !== index && sameId(id, partnerRecordId(partner))) })), selected[index] || null, '不指定');
            partnerSelectors.push(select);
            select.onchange = () => {
                // 编辑期间不会重建页面，必须读取三个当前控件，避免旧闭包覆盖刚选的伙伴。
                const next = partnerSelectors.map(control => control.value);
                setSetting('sailing.partnerIds', JSON.stringify(next.filter(Boolean)));
                partnerSelectors.forEach((control, slot) => {
                    for (const option of control.options) option.disabled = !!option.value && next.some((id, other) => other !== slot && id === option.value);
                });
                wakeSoon();
            };
            body.appendChild(row);
        }
        body.appendChild(uiElement('p', 'rlt-note', '指定任一伙伴后严格使用指定队伍；全部留空才自动选人。自动出航优先于本轮生产派驻。建造、改装、出航共用每轮预算。'));
        if (sail?.active_run) {
            const run = sail.active_run, now = serverNowSeconds();
            body.appendChild(workCard(run.route_name || '航海', run.ready_at <= now ? '已回港，等待领取' : durationLabel(run.ready_at - now), (now - run.started_at) / Math.max(1, run.ready_at - run.started_at) * 100));
        }
        if (readJson(SAILING_INTENT_KEY) && !sail?.active_run) {
            body.appendChild(uiElement('p', 'rlt-warning', '上次出航结果未确认，已暂停重复出航。请先在游戏中检查船只状态。'));
            const clear = uiElement('button', '', '确认当前没有航程');
            clear.disabled = busy;
            clear.onclick = () => {
                if (busy || (runtime.state || state).sailing?.active_run) return;
                if (!window.confirm('确认已经在游戏中检查，当前没有进行中的航程？清除后将重新规划出航。')) return;
                setOverride(SAILING_INTENT_KEY, ''); clear.blur(); wakeSoon(); refreshConfigRows(runtime.state || state);
            };
            body.appendChild(clear);
        }
        configBox.appendChild(group);
    }

    function makeControlRow(labelText) {
        const row = uiElement('div', 'rlt-control');
        const label = uiElement('span', '', labelText);
        return { row, label };
    }

    function makeSelectRow(labelText, title) {
        const { row, label } = makeControlRow(labelText);
        const select = document.createElement('select');
        select.className = 'rlt-input';
        if (title) select.title = title;
        select.setAttribute('aria-label', labelText);
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

    // ---------- 面板分组折叠（记忆在 localStorage） ----------
    const groupCollapseKey = name => `rlt-group-collapsed:${name}`;

    // 分组容器：标题点击折叠/展开
    function makeGroup(title, page = 'production') {
        const group = document.createElement('div');
        group.className = 'rlt-group';
        group.dataset.page = page;
        const header = document.createElement('button');
        header.className = 'rlt-group-title';
        header.style.cssText = 'margin-top:5px;cursor:pointer;user-select:none;font-weight:bold;opacity:.85;transition:opacity .15s';
        header.title = '点击折叠/展开';
        header.onmouseenter = () => { header.style.opacity = '1'; };
        header.onmouseleave = () => { header.style.opacity = '.85'; };
        const body = document.createElement('div');
        body.style.cssText = 'margin-left:4px;padding-left:7px;border-left:1px solid #3a4636';
        const isCollapsed = () => localStorage.getItem(groupCollapseKey(title)) === '1';
        const render = () => {
            header.textContent = `${isCollapsed() ? '▸' : '▾'} ${title}`;
            header.setAttribute('aria-expanded', String(!isCollapsed()));
            body.style.display = isCollapsed() ? 'none' : '';
        };
        header.onclick = () => {
            localStorage.setItem(groupCollapseKey(title), isCollapsed() ? '0' : '1');
            render();
        };
        render();
        group.appendChild(header);
        group.appendChild(body);
        return { group, body };
    }

    // 开关行：统一保存、唤醒与界面更新
    function makeToggleRow(state, labelText, title, on, onToggle, focusKey = labelText) {
        const { row, label } = makeControlRow(labelText);
        const btn = document.createElement('button');
        btn.textContent = on ? '开启中' : '已关闭';
        btn.className = 'rlt-switch';
        btn.dataset.focusKey = focusKey;
        btn.setAttribute('role', 'switch');
        btn.setAttribute('aria-label', labelText);
        btn.setAttribute('aria-checked', String(on));
        btn.title = title;
        btn.onclick = () => {
            onToggle();
            wakeSoon();
            refreshConfigRows(runtime.state || state);
        };
        row.appendChild(label);
        row.appendChild(btn);
        return row;
    }

    // 数字输入框：失焦时取整并夹到 [min, +∞)，回显规范化后的值
    function makeNumberInput(value, { min = 0, max = Number.MAX_SAFE_INTEGER, width = '72px', placeholder = '', title = '', onchange } = {}) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(min);
        input.max = String(max);
        input.setAttribute('aria-label', title || placeholder || '数量');
        input.value = String(value);
        input.placeholder = placeholder;
        input.title = title;
        input.className = 'rlt-input';
        input.style.cssText = `width:${width};flex:none`;
        input.onchange = () => {
            const raw = Number(input.value);
            const n = Math.min(max, Math.max(min, Number.isFinite(raw) ? Math.floor(raw) : min));
            input.value = String(n);
            onchange?.(n);
            wakeSoon();
        };
        return input;
    }

    // 标签 + 数字输入框的一整行
    function makeNumberRow(labelText, value, opts) {
        const { row, label } = makeControlRow(labelText);
        row.appendChild(label);
        row.appendChild(makeNumberInput(value, opts));
        return row;
    }

    // 槽位级特殊道具行：下拉列出当前拥有且适用于该产业的道具（时机 + 效果描述 + 数量），可设保留数量
    function makeTaskItemRow(state, industry, id) {
        const items = (state.task_items || []).filter(it => {
            const eligible = it?.eligible_industries;
            return !Array.isArray(eligible) || eligible.length === 0 || eligible.includes(industry);
        });
        if (!items.length) return null;
        const itemKey = nodeTaskItemKey(industry, id);
        const keepKey = nodeTaskItemKeepKey(industry, id);
        const stored = getOverride(itemKey);
        const current = stored === '__off' ? null : stored; // 旧版“停用”值归入默认的“不使用”
        const labelPrefix = industry === 'farming' ? `土地 ${id + 1}` : `${INDUSTRY_NAMES[industry] || industry}点 ${id}`;
        const { row, select } = makeSelectRow('└ 道具:', '选择该点位使用的特殊道具；默认不使用');
        select.style.maxWidth = '150px'; // 给保留数量输入留出行内空间
        fillSelect(select, items.map(it => ({
            value: taskItemRecordId(it),
            text: `${it.timing === 'active' ? '【途中】' : '【开工】'}${it.name || '道具#' + taskItemRecordId(it)} ×${it.quantity || 0}${it.description ? ` · ${it.description}` : ''}`,
            disabled: Number(it.quantity || 0) <= 0,
        })), current, '不使用特殊道具');
        const keep = makeNumberInput(getOverride(keepKey) || '0', {
            placeholder: '留0',
            title: '保留数量：该道具至少留下多少个不使用',
            onchange: n => {
                setOverride(keepKey, n ? String(n) : '');
                log(`${labelPrefix}：道具保留数量设为 ${n}`);
            },
        });
        select.onchange = () => {
            setOverride(itemKey, select.value);
            log(`${labelPrefix}：${select.value ? '已锁定道具' : '不使用道具'}`);
        };
        row.appendChild(keep);
        return row;
    }

    // 加工流程编辑器（每站最多 4 步：配方 × 份数；循环由设置控制）：
    // 步骤留空即忽略；改配方或份数重置进度，只改道具不重置
    function makeCraftPipelineRows(state, node, stationId) {
        const recipes = INDUSTRY_ADAPTERS.crafting.jobs(node);
        if (!recipes.length) return null;
        const steps = craftPipelineSteps(stationId);
        const prog = craftPipelineProgress(stationId, steps);
        const editLocked = !!craftFlight(stationId) || !node.empty;
        const frag = document.createElement('div');

        const title = document.createElement('div');
        title.textContent = '流程（最多 4 步，按领取份数推进）：';
        title.title = '配置后需点下方「开始」才执行；按顺序执行：当前步领满份数才推进下一步；缺材料会原地等待；每步可单独选开工道具（跟随站点道具行/不使用/指定道具，切换不影响进度）；改配方/份数自动重置进度';
        title.style.cssText = 'margin-top:4px;opacity:.8';
        frag.appendChild(title);

        // 加工适用的道具列表，供每步单独指定开工道具
        const craftItems = (state.task_items || []).filter(it => {
            const eligible = it?.eligible_industries;
            return !Array.isArray(eligible) || eligible.length === 0 || eligible.includes('crafting');
        });
        const editors = [];
        const save = () => {
            if (editLocked) return;
            const prevSig = craftPipelineSig(craftPipelineSteps(stationId));
            const next = editors
                .map(({ select, count, itemSel }) => ({
                    recipeId: select.value,
                    times: Math.floor(Number(count.value) || 0),
                    taskItemId: itemSel.value,
                }))
                .filter(s => s.recipeId !== '' && s.times >= 1);
            setOverride(craftPipelineKey(stationId), next.length ? JSON.stringify(next) : '');
            // 道具选择不参与签名：只换道具不会重置进度，改配方/份数才会
            const sigChanged = craftPipelineSig(next) !== prevSig;
            log(`加工点 ${stationId}：流程已更新（${next.length} 步）${sigChanged ? '，进度已重置' : ''}`);
            wakeSoon();
        };
        for (let i = 0; i < CRAFT_PIPELINE_MAX_STEPS; i++) {
            const { row, select } = makeSelectRow(`　第${i + 1}步:`, '选择该步配方；留空则忽略此步');
            fillSelect(select, recipes.map(j => ({
                value: jobId(j),
                text: `${j.name || '配方#' + jobId(j)}${j.unlocked === false ? '（未解锁）' : ''}`,
                disabled: j.unlocked === false,
            })), steps[i]?.recipeId ?? null, '（空）');
            select.onchange = save;
            // 每步单独的开工道具：默认跟随上方站点「道具」行，可改为不使用或指定道具；切换不影响流程进度
            const itemSel = document.createElement('select');
            itemSel.title = '本步开工道具：默认跟随上方「道具」行，可改为不使用或指定道具（切换不影响进度）';
            itemSel.className = 'rlt-input';
            itemSel.setAttribute('aria-label', `第 ${i + 1} 步道具`);
            fillSelect(itemSel, [
                { value: '__off', text: '不使用道具' },
                ...craftItems.map(it => ({
                    value: taskItemRecordId(it),
                    text: `【${it.timing === 'active' ? '途中' : '开工'}】${it.name || '道具#' + taskItemRecordId(it)} ×${it.quantity || 0}`,
                    disabled: Number(it.quantity || 0) <= 0,
                })),
            ], steps[i]?.taskItemId || null, '站点道具');
            itemSel.onchange = save;
            const count = makeNumberInput(steps[i]?.times ?? 1, {
                min: 1, width: '38px', placeholder: '份数',
                title: '份数：该步累计领取多少份后推进下一步',
                onchange: save,
            });
            select.disabled = itemSel.disabled = count.disabled = editLocked;
            editors.push({ select, count, itemSel });
            row.appendChild(itemSel);
            row.appendChild(count);
            frag.appendChild(row);
        }

        const statusRow = document.createElement('div');
        statusRow.style.cssText = 'margin-top:4px;display:flex;align-items:center;gap:6px;opacity:.85';
        const flowRunning = craftPipelineRunning(stationId);
        const status = document.createElement('span');
        const stationBusy = steps.length > 0 && node && !node.empty;
        const stepName = idx => recipes.find(r => sameId(jobId(r), steps[idx]?.recipeId))?.name || `#${steps[idx]?.recipeId}`;
        const progText = prog.finished ? '' :
            `第 ${prog.stepIndex + 1}/${steps.length} 步「${stepName(prog.stepIndex)}」 · 第 ${Math.min(prog.done[prog.stepIndex] + 1, steps[prog.stepIndex].times)}/${steps[prog.stepIndex].times} 份`;
        if (prog.legacy) status.textContent = '旧版开工进度：请待队列结束后重置，改用领取计数';
        else if (!steps.length) status.textContent = '未配置自动流程；现有队列仍可自动领取';
        else if (stationBusy) status.textContent = `${flowRunning ? '流程运行中' : '暂停后续提交'} · 累计已领取 ${prog.done.reduce((a, b) => a + b, 0)} / ${steps.reduce((sum, step) => sum + step.times, 0)} 份`;
        else if (prog.finished) status.textContent = `流程已完成（${steps.length} 步），点开始再跑一轮`;
        else status.textContent = `${flowRunning ? '运行中' : '已停止'} · 待开工 ${progText}`;
        statusRow.appendChild(status);
        if (steps.length) {
            const runBtn = document.createElement('button');
            runBtn.textContent = flowRunning ? '停止' : '开始';
            runBtn.dataset.focusKey = `craft:${stationId}:run`;
            runBtn.setAttribute('aria-label', `本站流程${flowRunning ? '停止' : '开始'}`);
            runBtn.disabled = !flowRunning && prog.finished && (editLocked || busy);
            runBtn.title = flowRunning ? '暂停流程（进度保留，可随时继续）' :
                (prog.finished ? '重置进度并从头再跑一轮' : '从当前进度开始执行流程');
            runBtn.style.cssText = `padding:0 8px;cursor:pointer;border:none;border-radius:4px;font:11px monospace;background:${flowRunning ? '#555f52' : '#8ead71'};color:${flowRunning ? '#e8e0cf' : '#17211b'}`;
            runBtn.onclick = () => {
                if (flowRunning) {
                    setOverride(craftPipelineRunKey(stationId), '0');
                    log(`加工点 ${stationId}：流程已停止（进度保留）`);
                } else {
                    const current = craftPipelineProgress(stationId, craftPipelineSteps(stationId));
                    if (current.finished) {
                        if (busy || craftFlight(stationId) || !nodeById(runtime.state || state, 'crafting', stationId)?.empty) return;
                        resetCraftPipeline(stationId);
                    }
                    setOverride(craftPipelineRunKey(stationId), '1');
                    log(`加工点 ${stationId}：流程已启动`);
                }
                wakeSoon(); // 立即唤醒主循环，不必等下一轮轮询
                refreshConfigRows(runtime.state || state);
            };
            statusRow.appendChild(runBtn);
        }
        frag.appendChild(statusRow);
        return frag;
    }

    // 按页生成槽位编辑器；选项来自最新状态，选择从持久化配置恢复
    function renderFarmSettings(state) {
        const { group, body } = makeGroup('农场');
        // 未解锁的土地不在 state.plots 里，额外补一行“下一块地”，便于提前锁定作物（解锁后沿用同一 key）
        const slots = (state.plots || []).map(p => p.slot);
        slots.push(slots.length ? Math.max(...slots) + 1 : 0);
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
            body.appendChild(row);
            const itemRow = makeTaskItemRow(state, 'farming', slot);
            if (itemRow) body.appendChild(itemRow);
        }
        configBox.appendChild(group);
    }

    function renderIndustrySettings(state, industries) {
        for (const industry of industries) {
            const adapter = INDUSTRY_ADAPTERS[industry];
            const nodes = industryNodes(state, industry).filter(node => adapter.id(node) != null);
            if (!nodes.length) continue;
            const { group, body } = makeGroup(INDUSTRY_NAMES[industry] || industry, industry === 'crafting' ? 'crafting' : 'production');
            for (const node of nodes) {
                const id = adapter.id(node);
                const key = nodeJobKey(industry, id);
                const nodeName = node.definition?.name || id;
                const label = `${nodeName}:`;
                const { row, select } = makeSelectRow(label,
                    industry === 'crafting' ? '「流程」= 按下方配置的加工流程执行；也可锁定单一配方；关闭时可选择是否释放伙伴' : '选择这个点位的任务；关闭时可选择是否释放伙伴');
                fillSelect(select, [
                    { value: NODE_JOB_OFF_RELEASE, text: '关闭（释放伙伴）' },
                    { value: NODE_JOB_OFF_KEEP, text: '关闭（保留伙伴）' },
                    ...adapter.jobs(node).map(j => ({
                        value: jobId(j),
                        text: `${j.name || '任务#' + jobId(j)}${j.stamina_cost ? `（体力${j.stamina_cost}）` : ''}${industry === 'crafting' && j.unlocked === false ? '（未解锁）' : ''}`,
                        disabled: industry === 'crafting' && j.unlocked === false,
                    })),
                ], getOverride(key), industry === 'crafting' ? '流程' : '自动');
                select.onchange = () => {
                    setOverride(key, select.value);
                    const what = select.value === NODE_JOB_OFF_RELEASE ? '已关闭，将释放伙伴' :
                        select.value === NODE_JOB_OFF_KEEP ? '已关闭，将保留伙伴' :
                        (select.value ? '已锁定目标' : (industry === 'crafting' ? '按加工流程执行' : '恢复自动选择'));
                    log(`${INDUSTRY_NAMES[industry] || industry}点 ${nodeName}：${what}`);
                    wakeSoon();
                };
                if (industry === 'crafting') {
                    select.disabled = !!craftFlight(id) || !node.empty;
                    const lockTimes = makeNumberInput(Number(getOverride(craftLockTimesKey(id))) || 0, {
                        min: 0, width: '48px', placeholder: '不限',
                        title: '锁定配方的批次数：留空/0 = 不限；设 N = 做满 N 批后停工（改一下数字即可重跑）',
                        onchange: n => {
                            setOverride(craftLockTimesKey(id), n > 0 ? String(n) : '');
                            log(`加工点 ${nodeName}：锁定配方批次数${n > 0 ? `设为 ${n}` : '不限'}`);
                            wakeSoon();
                        },
                    });
                    row.appendChild(lockTimes);
                    lockTimes.disabled = !!craftFlight(id) || !node.empty;
                    lockTimes.hidden = nodeJobOverride('crafting', id) == null || nodeJobClosed('crafting', id);
                }
                body.appendChild(row);
                const itemRow = makeTaskItemRow(state, industry, id);
                if (itemRow) body.appendChild(itemRow);
                if (industry === 'crafting') {
                    body.appendChild(makeCraftQueueCard(state, node));
                    const pipeRows = nodeJobOverride('crafting', id) == null ? makeCraftPipelineRows(state, node, id) : null;
                    if (pipeRows) body.appendChild(pipeRows);
                }
            }
            configBox.appendChild(group);
        }
    }

    function renderFishingSettings(state) {
        const { group, body } = makeGroup('垂钓', 'production');
        appendSetting(body, state, 'aquatic.chainCasts', '连钓次数', { min: 1 });
        appendSetting(body, state, 'aquatic.staminaReserve', '垂钓体力保底');
        appendSetting(body, state, 'aquatic.reserveBigCatch', '预留大物体力');
        const { row, select } = makeSelectRow('垂钓钓点:',
            '选择自动垂钓的钓点；「自动」优先留在聚鱼度所在钓点（换钓点会清零聚鱼度）');
        fillSelect(select, (state.aquatic?.spots || []).filter(s => s.unlocked).map(s => ({
            value: s.id, text: `${s.name || `钓点#${s.id}`}${s.stamina_cost ? `（体力${s.stamina_cost}）` : ''}`,
        })), getOverride(AQUATIC_SPOT_KEY), '自动');
        select.onchange = () => {
            setOverride(AQUATIC_SPOT_KEY, select.value);
            log(`垂钓钓点：${select.value ? '已锁定' : '恢复自动选择'}`);
        };
        body.appendChild(row);
        configBox.appendChild(group);
    }

    function refreshConfigRows(state) {
        applyDashboardPage();
        if (panel.classList.contains('rlt-collapsed')) return;
        if (activeDashboardPage === 'overview') { renderDashboard(state); return; }
        const focused = document.activeElement;
        // 正在编辑的值保留到失焦；按钮更新后恢复键盘焦点。
        if (configBox.contains(focused) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(focused?.tagName)) return;
        const activity = `${running}:${busy}`;
        if (state === lastConfigState && settingsRevision === lastConfigRevision && activity === lastConfigActivity && activeDashboardPage === lastConfigPage) return;
        const focusKey = configBox.contains(focused) ? focused?.dataset.focusKey : null;
        if (lastConfigPage === activeDashboardPage) pageScroll.set(activeDashboardPage, configBox.scrollTop);
        configBox.replaceChildren();
        if (activeDashboardPage === 'production') {
            renderModuleSettings(state, 'production');
            renderFarmSettings(state);
            renderIndustrySettings(state, ['gathering', 'mining']);
            renderFishingSettings(state);
        } else if (activeDashboardPage === 'crafting') {
            renderIndustrySettings(state, ['crafting']);
            renderModuleSettings(state, 'crafting');
        } else if (activeDashboardPage === 'sailing') renderSailingSettings(state);
        else renderModuleSettings(state, activeDashboardPage);
        if (focusKey) [...configBox.querySelectorAll('button[data-focus-key]')].find(button => button.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
        configBox.scrollTop = pageScroll.get(activeDashboardPage) || 0;
        lastConfigState = state; lastConfigRevision = settingsRevision;
        lastConfigActivity = activity; lastConfigPage = activeDashboardPage;
    }

    // 收起/展开（记住选择）
    let collapsed = localStorage.getItem('rlt-helper-collapsed') === '1';
    const panelPositions = { expanded: null, collapsed: null };
    let ignoreCollapseClickUntil = 0;
    function applyCollapsed() {
        panel.classList.toggle('rlt-collapsed', collapsed);
        applyDashboardPage();
        collapseBtn.textContent = collapsed ? '+' : '—';
        collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        collapseBtn.setAttribute('aria-label', collapsed ? '展开助手面板' : '收起助手面板');
        collapseBtn.title = collapsed ? '点击展开，拖动可移动位置' : '收起助手面板';
    }
    collapseBtn.onclick = event => {
        if (event?.detail && performance.now() < ignoreCollapseClickUntil) return;
        collapsed = !collapsed;
        localStorage.setItem('rlt-helper-collapsed', collapsed ? '1' : '0');
        applyCollapsed();
        refreshConfigRows(currentViewState());
        restorePanelPosition();
    };
    applyCollapsed();

    // 拖动只改变面板位置；窗口缩小时仍保证标题可见。
    let finishPanelDrag = null;
    function clampPanelPosition(left, top) {
        const rect = panel.getBoundingClientRect();
        panel.style.left = Math.max(0, Math.min(left, window.innerWidth - rect.width)) + 'px';
        panel.style.top = Math.max(0, Math.min(top, window.innerHeight - rect.height)) + 'px';
    }
    function restorePanelPosition() {
        panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
        const position = panelPositions[collapsed ? 'collapsed' : 'expanded'];
        if (position) {
            panel.style.right = panel.style.bottom = 'auto';
            clampPanelPosition(position.left, position.top);
        }
    }
    function beginPanelDrag(e) {
        if (e.button !== 0 || e.isPrimary === false) return;
        finishPanelDrag?.();
        ignoreCollapseClickUntil = 0;
        const rect = panel.getBoundingClientRect();
        const touchLauncher = collapsed && e.currentTarget === collapseBtn && e.pointerType === 'touch';
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        let moved = false;
        const move = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
            moved = true;
            ev.preventDefault();
            panel.style.right = panel.style.bottom = 'auto';
            clampPanelPosition(ev.clientX - dx, ev.clientY - dy);
        };
        const up = ev => {
            if (ev && ev.pointerId !== e.pointerId) return;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            finishPanelDrag = null;
            if (moved) {
                const position = panel.getBoundingClientRect();
                panelPositions[collapsed ? 'collapsed' : 'expanded'] = { left: position.left, top: position.top };
                ignoreCollapseClickUntil = performance.now() + 400;
            } else if (touchLauncher && ev?.type === 'pointerup' &&
                       ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
                // 触摸轻点在松手时响应，不依赖浏览器延迟派发的兼容 click。
                collapseBtn.click();
                ignoreCollapseClickUntil = performance.now() + 400;
            }
        };
        finishPanelDrag = up;
        window.addEventListener('pointercancel', up);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
    statusLine.addEventListener('pointerdown', beginPanelDrag);
    collapseBtn.addEventListener('pointerdown', event => { if (collapsed) beginPanelDrag(event); });
    rosterBtn.onclick = async () => {
        try {
            const snapshot = await api('/state');
            validateStateSchema(snapshot);
            scanRoster(snapshot); // 仅用于显示，避免并发 GET 用旧快照覆盖 runtime.state
        } catch (e) {
            log(`扫描失败：${e.message}`);
        }
    };

    function log(msg) {
        const time = new Date().toLocaleTimeString();
        const line = document.createElement('div');
        line.textContent = `[${time}] ${msg}`;
        if (/失败|不足|错误|暂停|无法|超过上限/.test(msg)) line.style.color = '#d98f7a'; // 异常类日志用暖色标出
        logBox.prepend(line);
        while (logBox.children.length > 30) logBox.lastChild.remove();
    }

    // ---------- 更新检查 ----------
    let checkingUpdate = false;
    let pendingUpdate = null;

    function parseUserscriptMetadata(source) {
        const block = String(source || '').match(/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==/m)?.[0];
        if (!block) return null;
        const read = key => block.match(new RegExp(`^\\/\\/\\s*@${key}\\s+(.+?)\\s*$`, 'm'))?.[1]?.trim() || '';
        return { name: read('name'), namespace: read('namespace'), version: read('version') };
    }

    // 返回正数表示 a 更新，负数表示 b 更新；支持 3.0.2 以及常见预发布后缀。
    function compareVersions(a, b) {
        const parse = value => {
            const [core, prerelease = ''] = String(value || '').trim().replace(/^v/i, '').split('-', 2);
            return { core: core.split('.').map(x => Number(x) || 0), prerelease };
        };
        const av = parse(a), bv = parse(b);
        const length = Math.max(av.core.length, bv.core.length);
        for (let i = 0; i < length; i++) {
            const diff = (av.core[i] || 0) - (bv.core[i] || 0);
            if (diff) return diff;
        }
        if (!av.prerelease && bv.prerelease) return 1;
        if (av.prerelease && !bv.prerelease) return -1;
        return av.prerelease.localeCompare(bv.prerelease, undefined, { numeric: true });
    }

    async function inspectUpdateSource(source) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const separator = source.url.includes('?') ? '&' : '?';
        const requestUrl = `${source.url}${separator}_rlt_check=${Date.now()}`;
        try {
            const response = await fetch(requestUrl, {
                cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const metadata = parseUserscriptMetadata(await response.text());
            if (!metadata || metadata.name !== SCRIPT_IDENTITY.name ||
                metadata.namespace !== SCRIPT_IDENTITY.namespace ||
                !/^\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
                throw new Error('脚本身份或版本元数据不匹配');
            }
            return { ...source, version: metadata.version, installUrl: requestUrl };
        } finally {
            clearTimeout(timeout);
        }
    }

    function resetUpdateButton(delay = 4000) {
        setTimeout(() => {
            if (!checkingUpdate && !pendingUpdate) updateBtn.textContent = '检查更新';
        }, delay);
    }

    async function checkForUpdates() {
        // 异步检查后再 window.open 容易被浏览器当成弹窗拦截；首次点击时先预留安装页。
        const installerWindow = window.open('about:blank', 'rlt-helper-update');
        if (installerWindow) {
            try {
                installerWindow.document.title = '红叶镇助手 · 正在检查更新';
                installerWindow.document.body.textContent = '正在检查可信更新源，请稍候……';
            } catch (_) { /* 某些浏览器不允许操作预留页，不影响后续跳转 */ }
        }

        if (pendingUpdate) {
            if (installerWindow) {
                installerWindow.location.replace(pendingUpdate.installUrl);
                pendingUpdate = null;
                resetUpdateButton();
            } else {
                log(`浏览器阻止了更新页，请允许本站弹出窗口后再次点击（待更新 v${pendingUpdate.version}）`);
            }
            return;
        }
        if (checkingUpdate) {
            installerWindow?.close();
            return;
        }

        checkingUpdate = true;
        updateBtn.disabled = true;
        updateBtn.textContent = '检查中…';
        log(`正在检查更新（当前 v${SCRIPT_VERSION}）…`);
        try {
            const settled = await Promise.allSettled(UPDATE_SOURCES.map(inspectUpdateSource));
            const available = settled.filter(x => x.status === 'fulfilled').map(x => x.value)
                .sort((a, b) => compareVersions(b.version, a.version));
            if (!available.length) throw new Error('所有可信更新源均不可访问');
            const latest = available[0];
            const reachable = available.map(x => `${x.name} v${x.version}`).join('；');
            if (compareVersions(latest.version, SCRIPT_VERSION) <= 0) {
                installerWindow?.close();
                updateBtn.textContent = '已是最新';
                log(`当前已是最新版本 v${SCRIPT_VERSION}（已验证：${reachable}）`);
                resetUpdateButton();
                return;
            }

            pendingUpdate = latest;
            updateBtn.textContent = `安装 v${latest.version}`;
            log(`发现新版本 v${latest.version}（${latest.name}），正在打开 Tampermonkey 更新确认页`);
            if (installerWindow) {
                installerWindow.location.replace(latest.installUrl);
                pendingUpdate = null;
                resetUpdateButton();
            } else {
                log('浏览器阻止了更新页；请允许本站弹出窗口，然后再次点击“安装”按钮');
            }
        } catch (e) {
            installerWindow?.close();
            updateBtn.textContent = '检查失败';
            log(`检查更新失败：${e.message || e}`);
            resetUpdateButton();
        } finally {
            checkingUpdate = false;
            updateBtn.disabled = false;
        }
    }

    updateBtn.onclick = checkForUpdates;

    // 面板操作（启停流程、改配置等）后尽快唤醒主循环：
    // 空闲时 tick 可能睡在最长轮询间隔（默认 120 秒）里，不唤醒会显得“点了没反应”
    function wakeSoon() {
        if (!running) return;
        if (busy) { wakeRequested = true; return; }
        scheduleTick(300);
    }

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
        if (base >= (p.stamina_cap ?? Infinity)) return base;
        const restore = p.stamina_restore_seconds || 0;
        if (!restore) return base;
        const regen = Math.floor(Math.max(0, serverNowSeconds() - (p.stamina_updated_at || 0)) / restore);
        return Math.min(p.stamina_cap ?? Infinity, base + regen);
    }

    // 体力恢复到 target 还要多少秒；无法估算返回 null
    function staminaWaitSeconds(state, target) {
        const p = state.player;
        if (!p || !p.stamina_restore_seconds) return null;
        const cur = liveStamina(state);
        if (cur >= target) return 0;
        if (target > (p.stamina_cap ?? Infinity)) return Infinity;
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
        let activeWait = Infinity;
        const consider = (readyAt, industry, id) => {
            if (readyAt && readyAt > now) wait = Math.min(wait, readyAt - now);
            const item = slotTaskItem(state, industry, id, 'active', { notify: false });
            const threshold = Number(item?.value || 0);
            if (readyAt && readyAt > now && threshold > 0) {
                activeWait = Math.min(activeWait, Math.max(0, readyAt - threshold - now));
            }
        };
        for (const p of state.plots || []) {
            if (!p.empty && !p.ready) consider(p.ready_at ?? p.task_snapshot?.ready_at, 'farming', p.slot);
        }
        for (const [industry, group] of [
            ['gathering', state.gathering_sites],
            ['mining', state.mining_sites],
            ['crafting', state.crafting_stations],
        ]) {
            for (const s of group || []) {
                if (!s.empty && !s.ready) {
                    consider(s.task_snapshot?.ready_at ?? s.ready_at, industry, INDUSTRY_ADAPTERS[industry]?.id(s));
                }
            }
        }
        // 有因体力不足停工的点：对齐体力恢复时间
        if (pendingStaminaCost != null) {
            const sw = staminaWaitSeconds(state, pendingStaminaCost);
            if (sw != null && isFinite(sw)) wait = Math.min(wait, sw);
        }
        if (CONFIG.sailing.enabled && CONFIG.sailing.autoCollect) {
            const readyAt = Number(state.sailing?.active_run?.ready_at || 0);
            if (readyAt > now) wait = Math.min(wait, readyAt - now);
        }
        if (CONFIG.feed.enabled) {
            const slot = state.aquatic?.feed_slot, bounds = feedThresholds(slot);
            if (bounds.valid && Number(slot.hourly_rate) > 0 && slot.units > bounds.low) {
                wait = Math.min(wait, (slot.units - bounds.low) / slot.hourly_rate * 3600);
            }
        }
        // 鱼塘周期：对齐最近的繁殖/投喂结算时刻，及时补料和处理
        if (CONFIG.aquatic.enabled && CONFIG.aquatic.ponds) {
            for (const pond of state.aquatic?.ponds || []) {
                const readyAt = Number(pond.last_settled_at || 0) + Number(pond.next_cycle_seconds || 0);
                if (readyAt > now) wait = Math.min(wait, readyAt - now);
            }
        }
        // 畜牧结算周期：对齐最近的产出结算时刻，及时收取
        if (CONFIG.livestock.enabled) {
            for (const facility of state.livestock?.facilities || []) {
                const readyAt = Number(facility.last_settled_at || 0) + Number(facility.next_cycle_seconds || 0);
                if (readyAt > now) wait = Math.min(wait, readyAt - now);
            }
        }
        const normalDelay = !isFinite(wait) ? CONFIG.maxPollInterval :
            Math.min(CONFIG.maxPollInterval, Math.max(CONFIG.pollInterval, Math.ceil(wait * 1000) + 2000));
        // 尚未进入 active 窗口时精确唤醒，不套用 15 秒下限；窗口内已经尝试过则按普通轮询退避。
        const activeDelay = !isFinite(activeWait) ? CONFIG.maxPollInterval : activeWait > 0
            ? Math.min(CONFIG.maxPollInterval, Math.max(500, Math.ceil(activeWait * 1000) + 300))
            : CONFIG.pollInterval;
        return Math.min(normalDelay, activeDelay);
    }

    function sameId(a, b) {
        return a != null && b != null && String(a) === String(b);
    }

    function taskItemRecordId(item) {
        return item?.id ?? item?.task_item_id ?? null;
    }

    function taskItemDurationMultiplier(item) {
        if (item?.effect !== 'duration_multiplier') return 1;
        const value = Number(item.value);
        return Number.isFinite(value) ? value : 1;
    }

    // 槽位级任务道具：只认面板锁定的道具（支持保留数量），未锁定即不使用
    // forcedId：加工流程步骤单独指定的道具 id，传入时跳过槽位配置查找
    function slotTaskItem(state, industry, slotId, timing, { notify = true, forcedId = null } = {}) {
        if (!CONFIG.taskItems.enabled || (industry === 'crafting' && !CONFIG.crafting.useTaskItems)) return null;
        const override = forcedId != null ? forcedId :
            (industry === 'crafting' && timing === 'active' ? craftFlight(slotId)?.taskItemChoice : null) ?? getOverride(nodeTaskItemKey(industry, slotId));
        if (override == null || override === '__off') return null; // '__off' 兼容旧版存储
        const keep = Math.max(0, Number(getOverride(nodeTaskItemKeepKey(industry, slotId)) || 0));
        const item = (state.task_items || []).find(candidate => {
            const eligible = candidate?.eligible_industries;
            return sameId(taskItemRecordId(candidate), override) && candidate.timing === timing &&
                Number(candidate.quantity || 0) - keep > 0 &&
                (!Array.isArray(eligible) || eligible.length === 0 || eligible.includes(industry));
        }) || null;
        const key = `task-item:${timing}:${industry}:${slotId}:${override}`;
        if (item) clearSkip(key);
        else if (notify) {
            logSkip(key, `${INDUSTRY_NAMES[industry] || industry}点 ${slotId}：道具 #${override} 库存不足（保留 ${keep} 个）、类型不符或不适用于该产业，已跳过`);
        }
        return item;
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

    // 官网同款时长公式：先应用能力与 minimum，再应用 start 道具的 duration_multiplier。
    function calcSeconds(base, difficulty, ability, minimum = 1, durationMultiplier = 1) {
        const b = Number(base);
        const d = Number(difficulty || 0);
        const a = Math.max(0, Number(ability || 0));
        if (!Number.isFinite(b) || b <= 0) return null;
        const sum = a + d;
        const factor = sum > 0 ? 1 + 2 * a / sum : 1;
        const seconds = Math.max(Number(minimum || 1), Math.ceil(b / factor));
        const multiplier = Number(durationMultiplier);
        return Number.isFinite(multiplier) && multiplier !== 1
            ? Math.max(1, Math.ceil(seconds * multiplier))
            : seconds;
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

    function cropHourlyProfit(state, crop, ability = 0, plot = null) {
        const produceId = cropProduceItemId(crop);
        const producePrice = itemSellPrice(state, produceId, cropProduceName(crop), crop.produce_sell_price ?? crop.produce?.sell_price ?? crop.item?.sell_price);
        const shopEntry = (state.shop || []).find(e => sameId(shopEntryItemId(e), crop.seed_item_id));
        const seedRaw = crop.seed_price ?? shopEntry?.price;
        if (producePrice == null) return null;
        // 种子不可购买（树果等探索/航海掉落地）：库存有货时按边际成本 0 估值（种子卖价也是 0，无机会成本）；无货无法估值
        let seedPrice;
        if (seedRaw == null || !Number.isFinite(Number(seedRaw))) {
            if (seedQty(state, crop) <= 0) return null;
            seedPrice = 0;
        } else {
            seedPrice = Number(seedRaw);
        }
        const minYield = Number(crop.yield_min ?? 1);
        const maxYield = Number(crop.yield_max ?? minYield);
        const startItem = plot ? slotTaskItem(state, 'farming', plot.slot, 'start', { notify: false }) : null;
        // 树果等作物带 minimum_duration_seconds 时长下限：能力加成不能把收获压缩到下限以内
        const seconds = calcSeconds(crop.growth_seconds, crop.time_difficulty, ability,
            crop.minimum_duration_seconds ?? 1, taskItemDurationMultiplier(startItem));
        if (!seconds) return null;
        return (((minYield + maxYield) / 2) * producePrice - seedPrice) / (seconds / 3600);
    }

    function bestCrop(state, crops, plot = null) {
        const ability = farmingAbility(state, plot);
        const scored = crops
            .map(crop => ({ crop, value: cropHourlyProfit(state, crop, ability, plot) }))
            .filter(x => x.value != null)
            .sort((a, b) => b.value - a.value);
        if (scored.length) return scored[0].crop;
        const list = [...crops];
        if (CONFIG.farming.prefer === 'fastest') list.sort((a, b) => Number(a.growth_seconds || Infinity) - Number(b.growth_seconds || Infinity));
        if (CONFIG.farming.prefer === 'slowest') list.sort((a, b) => Number(b.growth_seconds || 0) - Number(a.growth_seconds || 0));
        return list[0] || null;
    }

    // ---------- 需求、在途产量与安全库存 ----------

    // 按快照与配置修订缓存；改流程/保留量后，即使状态未刷新也重新计算需求
    const stateMemo = new WeakMap();
    function memoizedForState(state, key, compute) {
        let bucket = stateMemo.get(state);
        if (!bucket || bucket.revision !== settingsRevision) {
            bucket = { revision: settingsRevision };
            stateMemo.set(state, bucket);
        }
        if (!(key in bucket)) bucket[key] = compute();
        return bucket[key];
    }

    function commissionActive(cm) {
        return !!cm && !cm.settled &&
            cm.status !== 'forwarded' && cm.status !== 'forward_completed' && cm.status !== 'completed';
    }

    function gatherNeeds(state, { productionOnly = false } = {}) {
        return memoizedForState(state, productionOnly ? 'needs:production' : 'needs',
            () => gatherNeedsUncached(state, { productionOnly }));
    }

    function gatherNeedsUncached(state, { productionOnly = false } = {}) {
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
        if (CONFIG.commissions.enabled && commissionActive(cm)) {
            needs.unshift({
                source: 'commission', itemId: cm.item_id ?? cm.item?.item_id ?? null,
                name: cm.item?.name || '', minQuality: 0, need: Number(cm.quantity || 0), commission: cm,
            });
        }
        if (!productionOnly) needs.push(...sailingMaterialNeeds(state));
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
        // 槽位级指定作物优先于全局 cropId；锁定后不回退其他作物。
        // 槽位锁定失败只跳过本块地；全局 cropId 严格模式下每块地都锁定同一作物，失败即整轮停种等待（与逐块跳过等价，省掉重复评估）
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
                const v = cropHourlyProfit(state, c, ability, plot);
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

    // 库存按售价估算的总价值：每个品质堆叠自带 sell_price（游戏本体也按 sell_price×数量 逐堆叠计算），
    // 缺失时回退物品元数据的基础价；查不到价的物品不计入
    function inventoryTotalValue(state) {
        let total = 0;
        for (const item of state?.inventory || []) {
            const price = itemSellPrice(state, item.item_id, item?.name || '', item?.sell_price);
            if (price) total += price * Number(item.quantity || 0);
        }
        return total;
    }

    function inferredSellItemIds(state) {
        const ids = new Set();
        if (!CONFIG.selling.inferredOutputWhitelist) return ids;
        for (const crop of state.crops || []) {
            const id = cropProduceItemId(crop);
            if (id != null) ids.add(String(id));
        }
        for (const site of [...(state.gathering_sites || []), ...(state.mining_sites || [])]) {
            for (const task of site.available_tasks || []) {
                const outputs = task.outputs || [];
                const direct = task.item_id ?? task.item?.item_id;
                if (!outputs.length && direct != null) ids.add(String(direct));
                const weights = outputs.map(out => Number(out.weight));
                const weightsValid = weights.every(weight => Number.isFinite(weight) && weight > 0);
                const commonWeight = weightsValid ? Math.max(...weights) : 0;
                for (const [index, out] of outputs.entries()) {
                    const isUnclassifiedRandomDrop = outputs.length > 1 && !weightsValid;
                    const isRareRandomDrop = outputs.length > 1 && weightsValid && weights[index] < commonWeight;
                    if (!CONFIG.selling.includeRareTaskOutputs && (isUnclassifiedRandomDrop || isRareRandomDrop)) continue;
                    const id = out.item_id ?? out.item?.item_id;
                    if (id != null) ids.add(String(id));
                }
            }
        }
        return ids;
    }

    // 按实际启用流程各步骤的下一段队列预留原料；已提交给服务器的部分不重复预留。
    function craftingInputReserves(state) {
        return memoizedForState(state, 'craftingReserves', () => craftingInputReservesUncached(state));
    }

    function craftingInputReservesUncached(state) {
        const reserves = new Map();
        if (!CONFIG.selling.protectCraftingInputs || !CONFIG.crafting.enabled) return reserves;
        for (const station of state.crafting_stations || []) {
            const id = station.station_id;
            if (nodeJobClosed('crafting', id) || getOverride(`rlt-craft-paused:${id}`) === '1') continue;
            const steps = configuredCraftSteps(id), progress = craftPipelineProgress(id, steps), flight = craftFlight(id);
            const selected = nodeJobOverride('crafting', id) ?? CONFIG.crafting.recipeId;
            const wanted = new Map();
            if (steps.length && (selected != null || craftPipelineRunning(id))) {
                steps.forEach((step, index) => {
                    const queued = flight?.stepIndex === index ? Math.max(0, flight.quantity - flight.credited) : 0;
                    const count = Math.max(0, Math.min(CONFIG.crafting.batchEnabled ? CONFIG.crafting.batchLimit : 1, step.times - progress.done[index] - queued));
                    wanted.set(String(step.recipeId), (wanted.get(String(step.recipeId)) || 0) + count);
                });
            } else if (selected != null) wanted.set(String(selected), 1);
            const stationReserves = new Map();
            for (const recipe of station.recipes || []) {
                if (recipe.unlocked === false) continue;
                const count = wanted.get(String(jobId(recipe))) || 0;
                if (!count) continue;
                const recipeTotals = new Map();
                for (const input of recipe.inputs || []) {
                    const id = input.item_id ?? input.item?.item_id;
                    const quantity = Math.max(0, Number(input.quantity || 0)) * count;
                    if (id == null || quantity <= 0) continue;
                    const key = String(id);
                    recipeTotals.set(key, (recipeTotals.get(key) || 0) + quantity);
                }
                for (const [key, quantity] of recipeTotals) {
                    stationReserves.set(key, (stationReserves.get(key) || 0) + quantity);
                }
            }
            for (const [key, quantity] of stationReserves) {
                reserves.set(key, (reserves.get(key) || 0) + quantity);
            }
        }
        return reserves;
    }

    function configuredKeep(itemId, craftingReserves = null, { applyDefaultKeep = true } = {}) {
        const explicit = CONFIG.selling.keepByItemId?.[String(itemId)];
        const inventoryKeep = Math.max(0, Number(explicit ?? (applyDefaultKeep ? CONFIG.selling.defaultKeep : 0) ?? 0));
        const craftingKeep = Math.max(0, Number(craftingReserves?.get(String(itemId)) || 0));
        return Math.max(inventoryKeep, craftingKeep);
    }

    // 为一个物品的全部品质栈统一分配需求：高门槛需求优先，使用最低可满足品质。
    function reservedStacksForItem(state, stacks, craftingReserves = null, { dedicatedFeed = false } = {}) {
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
        let keep = dedicatedFeed
            ? Math.max(0, Number(CONFIG.selling.keepByItemId?.[String(stacks[0]?.item_id)] || 0), Number(craftingReserves?.get(String(stacks[0]?.item_id)) || 0))
            : configuredKeep(stacks[0]?.item_id, craftingReserves);
        for (const row of rows) {
            if (keep <= 0) break;
            const take = Math.min(row.free, keep);
            row.free -= take;
            row.reserved += take;
            keep -= take;
        }
        return rows;
    }

    // 探索物品硬保护：武器/饰品（equipment 字段）与探索携带道具（delve_use 字段）即使 id 进了白名单也永不出售。
    // 官方客户端同样用这两个字段从 inventory 识别可装备/可携带物品。
    function isExplorationGear(item) {
        return !!(item && (item.equipment || item.delve_use));
    }

    function computeSellables(state) {
        const whitelist = new Set((CONFIG.selling.allowedItemIds || []).map(String));
        for (const id of inferredSellItemIds(state)) whitelist.add(id);
        const never = new Set((CONFIG.selling.neverSellItemIds || []).map(String));
        const craftingReserves = craftingInputReserves(state);
        const groups = new Map();
        for (const item of state.inventory || []) {
            if (CONFIG.selling.protectExplorationGear && isExplorationGear(item)) continue;
            const key = String(item.item_id);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }
        const sellables = [];
        for (const [key, stacks] of groups) {
            if (!whitelist.has(key) || never.has(key)) continue;
            for (const row of reservedStacksForItem(state, stacks, craftingReserves)) {
                // 背包条目不一定带 sell_price：回退到物品元数据查价，否则该物品永远进不了可卖列表
                const price = Number(itemSellPrice(state, row.item.item_id, row.item?.name || '', row.item?.sell_price) ?? 0);
                if (price > 0 && row.free > 0) sellables.push({ item: row.item, surplus: row.free, price });
            }
        }
        sellables.sort((a, b) => b.price - a.price || Number(a.item.quality || 0) - Number(b.item.quality || 0));
        return sellables;
    }

    // 接单/加工接口不指定品质：按“服务器优先扣最高品质”的最坏情况计算仍可安全消耗多少。
    // applyKeep：是否套用 selling 的保留量（defaultKeep/keepByItemId）——售卖/接单场景要保留，
    // 加工投料场景不能保留，否则库存不足 defaultKeep 的合法原料会被误判为“材料不足”
    // 航海仅跳过默认售卖保留量；明确指定的保留量和加工预留仍然生效。
    function safeUnspecifiedConsumeQty(state, itemId, name = '', { reserveCraftingInputs = true, applyKeep = true, applyDefaultKeep = true, excludeSailing = false } = {}) {
        const stacks = (state.inventory || []).filter(i => itemId != null ? sameId(i.item_id, itemId) : i.name === name);
        if (!stacks.length) return 0;
        const needs = gatherNeeds(state).filter(n => (!excludeSailing || n.source !== 'sailing') && stacks.some(item => needMatchesItem(n, item)));
        const thresholds = new Set([0, ...needs.map(n => Number(n.minQuality || 0))]);
        const craftingReserves = reserveCraftingInputs ? craftingInputReserves(state) : null;
        const keep = applyKeep ? configuredKeep(itemId, craftingReserves, { applyDefaultKeep }) : 0;
        let safe = Infinity;
        for (const q of thresholds) {
            const eligible = stacks.filter(i => Number(i.quality || 0) >= q)
                .reduce((sum, i) => sum + Number(i.quantity || 0), 0);
            const required = needs.filter(n => Number(n.minQuality || 0) >= q)
                .reduce((sum, n) => sum + n.need, 0) + (q === 0 ? keep : 0);
            safe = Math.min(safe, eligible - required);
        }
        return Math.max(0, Math.floor(safe));
    }

    async function autoSellForCoins(target) {
        const failedStacks = new Set();
        while (playerCoins(runtime.state) < target && runtime.soldUnits < CONFIG.selling.maxUnitsPerTick) {
            const candidate = computeSellables(runtime.state).find(({ item }) =>
                !failedStacks.has(`${item.item_id}:${Number(item.quality || 0)}`));
            if (!candidate) break;
            const needCoins = target - playerCoins(runtime.state);
            const qty = Math.min(
                candidate.surplus,
                CONFIG.selling.maxUnitsPerTick - runtime.soldUnits,
                Math.ceil(needCoins / candidate.price),
            );
            if (qty <= 0) break;
            const item = candidate.item;
            const quality = Number(item.quality || 0);
            const stackKey = `${item.item_id}:${quality}`;
            try {
                await sellItem(item.item_id, qty, quality);
                runtime.soldUnits += qty;
                clearSkip(`fail:sell:${stackKey}`);
                log(`已安全卖出 ${item.quality_name || ''}${item.name} ×${qty}（+${candidate.price * qty} 金币）`);
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                failedStacks.add(stackKey);
                logSkip(`fail:sell:${stackKey}`, `售卖 ${item.name || item.item_id} 失败：${e.message}`);
            }
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

    // 转发池接单：读取当前协议的 entries；每成功一单都接管新 state 并重新读取池子。
    async function tryTakeCommission() {
        let taken = 0;
        while (taken < CONFIG.commissions.maxTakesPerTick &&
               Number(runtime.state.commissions?.remaining_takes || 0) > 0) {
            let board;
            try {
                board = await getCommissionBoard();
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
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
                if (safeUnspecifiedConsumeQty(runtime.state, itemId, name) < qty) continue;
                try {
                    await takeCommission(x.commission_id);
                    clearSkip(`fail:commission:take:${x.commission_id}`);
                    log(`已安全接单：${x.owner_name || x.npc_name || '镇民'} · ${name || itemId} ×${qty}（+${x.taker_reward ?? '?'} 枫火）`);
                    taken += 1;
                    success = true;
                    break;
                } catch (e) {
                    if (shouldAbortTick(e)) throw e;
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
                if (shouldAbortTick(e)) throw e;
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

    function taskReadyAt(node) {
        const value = Number(node?.task_snapshot?.ready_at ?? node?.ready_at ?? 0);
        return Number.isFinite(value) ? value : 0;
    }

    // active 型任务道具只在官网允许的窗口（剩余时间 <= value）使用；未配置且未做槽位锁定时完全不动作。
    async function useConfiguredActiveTaskItems() {
        const targets = [];
        let used = 0;
        const hasActiveItem = (industry, id) => {
            const override = (industry === 'crafting' ? craftFlight(id)?.taskItemChoice : null) ?? getOverride(nodeTaskItemKey(industry, id));
            if (override == null || override === '__off') return false;
            // 仅当锁定的道具确实存在 active（收尾）时机时才纳入巡检；
            // 否则开工类道具（如厚土肥）会在作物生长期间反复误报"库存不足/类型不符"
            return (runtime.state?.task_items || []).some(c =>
                sameId(taskItemRecordId(c), override) && c.timing === 'active');
        };
        if (CONFIG.farming.enabled) {
            for (const plot of runtime.state.plots || []) {
                if (!plot.empty && !plot.ready && hasActiveItem('farming', plot.slot)) {
                    targets.push({
                        industry: 'farming', id: plot.slot, label: `土地 ${plot.slot + 1}`,
                        current: () => (runtime.state.plots || []).find(p => p.slot === plot.slot),
                    });
                }
            }
        }
        for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
            const adapter = INDUSTRY_ADAPTERS[industry];
            if (!industryEnabled(industry)) continue;
            for (const node of industryNodes(runtime.state, industry)) {
                const id = adapter.id(node);
                if (id != null && !node.empty && !node.ready && hasActiveItem(industry, id)) {
                    targets.push({
                        industry, id, label: `${INDUSTRY_NAMES[industry] || industry}点 ${id}`,
                        current: () => nodeById(runtime.state, industry, id),
                    });
                }
            }
        }

        for (const target of targets) {
            const node = target.current();
            if (!node || node.empty || node.ready) continue;
            const item = slotTaskItem(runtime.state, target.industry, target.id, 'active');
            const readyAt = taskReadyAt(node);
            const remaining = readyAt - serverNowSeconds();
            const threshold = Number(item?.value || 0);
            if (!item || readyAt <= 0 || remaining <= 0 || threshold <= 0 || remaining > threshold) continue;
            const itemId = taskItemRecordId(item);
            try {
                await useTaskItem(target.industry, target.id, itemId);
                used += 1;
                clearSkip(`fail:active-item:${target.industry}:${target.id}:${itemId}`);
                log(`${target.label}：已使用 ${item.name || '任务道具#' + itemId}（原剩余约 ${Math.ceil(remaining)} 秒）`);
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                logSkip(`fail:active-item:${target.industry}:${target.id}:${itemId}`,
                    `${target.label} 使用任务道具失败：${e.message}`);
            }
        }
        return used;
    }

    async function collectReadyPlots() {
        if (!CONFIG.farming.enabled || !CONFIG.farming.autoCollect) return;
        const slots = (runtime.state.plots || []).filter(p => p.ready && !p.empty).map(p => p.slot);
        for (const slot of slots) {
            const plot = (runtime.state.plots || []).find(p => p.slot === slot);
            if (!plot || !plot.ready || plot.empty) continue;
            try {
                await harvestPlot(slot);
                clearSkip(`fail:harvest:${slot}`);
                log(`土地 ${slot + 1}：已收获`);
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                logSkip(`fail:harvest:${slot}`, `土地 ${slot + 1} 收获失败：${e.message}`);
            }
        }
    }

    async function plantEmptyPlots() {
        if (!CONFIG.farming.autoPlant) return;
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
                const startItem = slotTaskItem(runtime.state, 'farming', slot, 'start');
                await plantPlot(slot, cropId(crop), taskItemRecordId(startItem) ?? '');
                clearSkip(`fail:plant:${slot}`);
                clearSkip(`seed:disabled:${cropId(crop)}`);
                const itemText = startItem ? `，使用 ${startItem.name || '任务道具#' + taskItemRecordId(startItem)}` : '';
                log(`土地 ${slot + 1}：种下 ${crop.name || '作物#' + cropId(crop)}（${reason}${itemText}）`);
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                logSkip(`fail:plant:${slot}`, `土地 ${slot + 1} 种植失败：${e.message}`);
            }
        }
    }

    function partnerRecordId(partner) {
        if (partner == null) return null;
        return typeof partner === 'object' ? (partner.partner_id ?? partner.id ?? null) : partner;
    }

    function addPartnerIds(ids, values) {
        for (const value of values || []) {
            const id = typeof value === 'object' ? partnerRecordId(value) : value;
            if (id != null) ids.add(String(id));
        }
    }

    // 水产/畜牧的换人可能先进入 pending，实际生效前也必须视为已占用，避免被其他产业抢走或重复排队。
    function aquaticAssignedPartnerIds(state) {
        const ids = new Set();
        const companionId = partnerRecordId(state?.aquatic?.companion);
        if (companionId != null) ids.add(String(companionId));
        for (const pond of state?.aquatic?.ponds || []) {
            addPartnerIds(ids, pond.assigned_partner_ids);
            addPartnerIds(ids, pond.assigned_partners);
            addPartnerIds(ids, pond.pending_partner_ids);
            addPartnerIds(ids, pond.pending_partner ? [pond.pending_partner] : []);
        }
        return ids;
    }

    function livestockAssignedPartnerIds(state) {
        const ids = new Set();
        for (const facility of state?.livestock?.facilities || []) {
            addPartnerIds(ids, facility.assigned_partner_ids);
            addPartnerIds(ids, facility.assigned_partners);
            addPartnerIds(ids, facility.pending_partner_ids);
            addPartnerIds(ids, facility.pending_partner ? [facility.pending_partner] : []);
        }
        return ids;
    }

    function nodeHasAssignedOrPendingPartner(node) {
        return (node?.assigned_partner_ids || []).length > 0 ||
            (node?.assigned_partners || []).length > 0 ||
            (node?.pending_partner_ids || []).length > 0 ||
            partnerRecordId(node?.pending_partner) != null;
    }

    function isPartnerIdle(p, state = runtime.state) {
        const id = partnerRecordId(p);
        if (id == null || p.locked || p.missing || outsidePartnerIds(state).has(String(id)) ||
            p.assigned_plot_slot != null ||
            p.assigned_gathering_site_id != null ||
            p.assigned_mining_site_id != null ||
            p.assigned_crafting_station_id != null) return false;
        return !aquaticAssignedPartnerIds(state).has(String(id)) &&
            !livestockAssignedPartnerIds(state).has(String(id));
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

    // 特性与产业的相关性按名称/描述关键词识别（游戏未提供结构化字段）；“所有产业”类通用特性对所有产业生效
    const TRAIT_GENERIC_KEYWORDS = ['所有产业', '全部产业', '全产业', '任意产业', '各产业'];
    const TRAIT_INDUSTRY_KEYWORDS = {
        farming: ['农作', '种植', '作物', '收获', '耕地', '农田'],
        gathering: ['采集', '林野', '伐木', '拾取', '采摘'],
        mining: ['采矿', '矿产', '矿石', '掘金'],
        crafting: ['加工', '制作', '工艺', '锻造'],
        aquatic: ['水产', '垂钓', '钓鱼', '鱼塘', '鱼类'],
        livestock: ['畜牧', '牧场', '动物', '饲养', '照料'],
    };

    // 伙伴身上与该产业相关的特性列表
    function partnerTraitMatches(partner, industry) {
        return (partner?.traits || []).filter(t => {
            const text = `${t?.name || ''} ${t?.code || ''} ${t?.description || ''}`;
            return TRAIT_GENERIC_KEYWORDS.some(k => text.includes(k)) ||
                (TRAIT_INDUSTRY_KEYWORDS[industry] || []).some(k => text.includes(k));
        });
    }

    // 换人/派驻评分：能力值 + 每个相关特性折算的加成（特性优先于纯能力值）
    function partnerIndustryScore(p, industry) {
        const bonus = Math.max(0, Number(CONFIG.partnerTraitBonus ?? 0));
        return Number(partnerAbility(p, industry) || 0) + bonus * partnerTraitMatches(p, industry).length;
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
        const values = nodeJobs(industry, node)
            .map(job => Number(job.difficulty ?? job.time_difficulty ?? job.yield_difficulty ?? 0))
            .filter(Number.isFinite);
        return Math.max(0, ...values);
    }

    function currentPartnerId(node) {
        return (node?.assigned_partner_ids || [])[0] ?? (node?.assigned_partners || [])[0]?.partner_id ?? null;
    }

    function managedPartnerSlots(state) {
        const slots = [];
        if (CONFIG.farming.enabled && CONFIG.farming.autoAssignPartner) {
            for (const plot of state.plots || []) {
                if (!plot.empty || plot.assignment_locked) continue;
                if (outsidePartnerIds(state).has(String(currentPartnerId(plot)))) continue;
                slots.push({
                    key: `farming:${plot.slot}`, industry: 'farming', id: plot.slot,
                    label: `土地 ${plot.slot + 1}`, node: plot, mandatory: false,
                    difficulty: Math.max(0, ...(state.crops || [])
                        .map(c => Number(c.time_difficulty || 0)).filter(Number.isFinite)),
                    assign: pid => assignPlotPartner(plot.slot, pid),
                });
            }
        }
        for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
            const adapter = INDUSTRY_ADAPTERS[industry];
            const cfg = adapter.config();
            if (!industryEnabled(industry) || !cfg.autoAssignPartner) continue;
            for (const node of industryNodes(state, industry)) {
                if (!node.empty || node.task_snapshot || node.assignment_locked) continue;
                if (outsidePartnerIds(state).has(String(currentPartnerId(node)))) continue;
                const id = adapter.id(node);
                if (id == null) {
                    logSkip(`schema:id:${industry}`, `${industry} 节点缺少 id，已跳过派驻`);
                    continue;
                }
                const override = nodeJobOverride(industry, id);
                // “关闭（保留伙伴）”完全退出换人规划：现有伙伴成为固定占用，空岗也不会自动补人。
                if (override === NODE_JOB_OFF_KEEP) continue;
                const disabled = override === NODE_JOB_OFF_RELEASE;
                slots.push({
                    key: `${industry}:${id}`, industry, id,
                    label: `${INDUSTRY_NAMES[industry] || industry}点 ${id}`, node,
                    mandatory: adapter.requiresPartner, disabled, difficulty: nodeDifficulty(industry, node),
                    assign: pid => assignSitePartner(industry, id, pid),
                });
            }
        }
        return slots;
    }

    // 匈牙利算法求全局最大权匹配；每个岗位额外配一个虚拟列，允许合法地保持空缺。
    // allowSwap=false 时，已有伙伴的岗位只允许保留现任伙伴（只补空岗、不换人）。
    function maximumWeightPartnerMatching(slots, partners, allowSwap = true) {
        if (!slots.length || !partners.length) return new Map();
        const priorities = { gathering: 4, mining: 3, crafting: 2, farming: 1 };
        const edgeAbilities = slots.map(slot => partners.map(partner => {
            const pid = partner.partner_id ?? partner.id;
            const same = sameId(pid, currentPartnerId(slot.node));
            if (!allowSwap && currentPartnerId(slot.node) != null) {
                // 关闭自动换人：已派驻岗位锁定现任伙伴（给一个不会被超越的权重，空岗列权重为 0 无法挤掉它）
                if (!same || !hasTendency(partner, slot.industry)) return null;
                return { pid, same, weightedAbility: Number.MAX_SAFE_INTEGER / 4 };
            }
            if (!hasTendency(partner, slot.industry)) return null;
            const rawAbility = Number(partnerIndustryScore(partner, slot.industry) || 0);
            const rawDifficulty = Number(slot.difficulty || 0);
            const ability = Number.isFinite(rawAbility) ? Math.max(0, rawAbility) : 0;
            const difficulty = Number.isFinite(rawDifficulty) ? Math.max(0, rawDifficulty) : 0;
            let weightedAbility = ability * (1000 + difficulty);
            // 同岗位伙伴获得恰好约等于最低换人门槛的能力加成；覆盖更多岗位时仍允许调动。
            if (!slot.mandatory && same) {
                weightedAbility *= 1 + Math.max(0, Number(CONFIG.partnerMinImprovement || 0));
            }
            return { pid, same, weightedAbility };
        }));
        const abilityBound = edgeAbilities.reduce((sum, row) =>
            sum + Math.max(0, ...row.filter(Boolean).map(edge => edge.weightedAbility)), 0) || 1;
        const stabilityUnit = 1e-6;
        const lowerScoreBound = abilityBound + slots.length * stabilityUnit + 1;
        const maxIndustryTotal = slots.reduce((sum, slot) => sum + (priorities[slot.industry] || 0), 0);
        const coverageUnit = maxIndustryTotal + 2;
        const mandatoryUnit = slots.length * coverageUnit + maxIndustryTotal + 2;
        const forbidden = -1e12;
        const weights = slots.map((slot, rowIndex) => [
            ...partners.map((_, partnerIndex) => {
                const edge = edgeAbilities[rowIndex][partnerIndex];
                if (!edge) return forbidden;
                return coverageUnit + (slot.mandatory ? mandatoryUnit : 0) +
                    (priorities[slot.industry] || 0) +
                    (edge.weightedAbility + (edge.same ? stabilityUnit : 0)) / lowerScoreBound;
            }),
            ...Array(slots.length).fill(0),
        ]);

        const n = weights.length;
        const m = weights[0].length;
        const u = Array(n + 1).fill(0);
        const v = Array(m + 1).fill(0);
        const p = Array(m + 1).fill(0);
        const way = Array(m + 1).fill(0);
        for (let i = 1; i <= n; i += 1) {
            p[0] = i;
            let j0 = 0;
            const minv = Array(m + 1).fill(Infinity);
            const used = Array(m + 1).fill(false);
            do {
                used[j0] = true;
                const i0 = p[j0];
                let delta = Infinity;
                let j1 = 0;
                for (let j = 1; j <= m; j += 1) {
                    if (used[j]) continue;
                    const cur = -weights[i0 - 1][j - 1] - u[i0] - v[j];
                    if (cur < minv[j]) {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if (minv[j] < delta) {
                        delta = minv[j];
                        j1 = j;
                    }
                }
                for (let j = 0; j <= m; j += 1) {
                    if (used[j]) {
                        u[p[j]] += delta;
                        v[j] -= delta;
                    } else {
                        minv[j] -= delta;
                    }
                }
                j0 = j1;
            } while (p[j0] !== 0);
            do {
                const j1 = way[j0];
                p[j0] = p[j1];
                j0 = j1;
            } while (j0 !== 0);
        }

        const rowToColumn = Array(n).fill(-1);
        for (let j = 1; j <= m; j += 1) {
            if (p[j] > 0) rowToColumn[p[j] - 1] = j - 1;
        }
        const desired = new Map();
        for (let row = 0; row < n; row += 1) {
            const column = rowToColumn[row];
            if (column >= 0 && column < partners.length && weights[row][column] > forbidden / 2) {
                desired.set(slots[row].key, partners[column].partner_id ?? partners[column].id);
            }
        }
        return desired;
    }

    // 全产业统一规划，采集硬约束优先；允许空闲节点之间换岗，避免农田抢走唯一采集伙伴。
    async function optimizePartnerAssignments() {
        const state = runtime.state;
        const allSlots = managedPartnerSlots(state);
        if (!allSlots.length) return;
        const mutableCurrentIds = new Set(allSlots.map(s => currentPartnerId(s.node)).filter(x => x != null).map(String));
        const selectedSlots = [];
        for (const industry of ['gathering', 'mining', 'crafting', 'farming']) {
            const mutableIndustrySlots = allSlots.filter(s => s.industry === industry);
            const industrySlots = mutableIndustrySlots.filter(s => !s.disabled)
                .sort((a, b) => Number(b.mandatory) - Number(a.mandatory) || b.difficulty - a.difficulty);
            const mutableAssigned = new Set(mutableIndustrySlots.map(s => currentPartnerId(s.node))
                .filter(x => x != null).map(String)).size;
            const fixed = Math.max(0, assignedCount(state, industry) - mutableAssigned);
            const cap = industryCapacity(state, industry);
            const available = cap === Infinity ? industrySlots.length : Math.max(0, cap - fixed);
            selectedSlots.push(...industrySlots.slice(0, available));
        }

        const occupiedOutsideCore = new Set([
            ...aquaticAssignedPartnerIds(state),
            ...livestockAssignedPartnerIds(state),
            ...outsidePartnerIds(state),
        ]);
        const partners = (state.partners || []).filter(p => {
            const rawId = partnerRecordId(p);
            return rawId != null && !p.missing && !occupiedOutsideCore.has(String(rawId)) &&
                (isPartnerIdle(p) || mutableCurrentIds.has(String(rawId)));
        });
        const desired = maximumWeightPartnerMatching(selectedSlots, partners, CONFIG.partnerAutoSwap);

        // 关闭自动换人时：现任伙伴不在候选池（缺失等异常）导致匹配空缺的岗位，也强制保留现状，绝不释放
        if (!CONFIG.partnerAutoSwap) {
            for (const slot of allSlots) {
                const current = currentPartnerId(slot.node);
                if (current != null && !slot.disabled) desired.set(slot.key, current);
            }
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
                if (shouldAbortTick(e)) throw e;
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
                const traits = partner ? partnerTraitMatches(partner, slot.industry) : [];
                const traitText = traits.length ? `，特性：${traits.map(t => t.name || t.code).join('、')}` : '';
                log(`${slot.label}：派驻 ${partner?.name || '伙伴#' + target}（${INDUSTRY_NAMES[slot.industry] || slot.industry} ${partner ? partnerAbility(partner, slot.industry) : '?'}${traitText}）`);
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                logSkip(`fail:assign:${slot.key}`, `${slot.label} 派驻伙伴失败：${e.message}`);
            }
        }
    }

    // 产业编制的伙伴容量（state.industry_rules.<industry>.partner_capacity）
    function industryCapacity(state, industry) {
        const raw = state.industry_rules?.[industry]?.partner_capacity;
        if (raw == null) return Infinity;
        const cap = Number(raw);
        return Number.isFinite(cap) ? Math.max(0, cap) : Infinity; // 非法值按不限制处理，避免 NaN 传播导致静默不派驻
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
        if (skipNotices.size >= 300) skipNotices.delete(skipNotices.values().next().value);
        skipNotices.add(key);
        log(msg);
    }
    function clearSkip(key) { skipNotices.delete(key); }

    function jobDurationSeconds(job, ability, durationMultiplier = 1) {
        if (Object.prototype.hasOwnProperty.call(job, 'yield_difficulty')) {
            const fixed = Number(job.duration_seconds || 1);
            return Number.isFinite(fixed) ? Math.max(1, fixed) : null;
        }
        return calcSeconds(job.duration_seconds, job.time_difficulty, ability,
            job.minimum_duration_seconds ?? 1, durationMultiplier);
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

    function jobHourlyValue(state, industry, job, ability, durationMultiplier = 1) {
        const seconds = jobDurationSeconds(job, ability, durationMultiplier);
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
            safeUnspecifiedConsumeQty(state, row.itemId, row.name, { reserveCraftingInputs: false, applyKeep: false }) >= row.quantity);
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
        const nodeId = adapter.id(node);
        if (industry === 'crafting' && craftFlight(nodeId)) return { blocked: '本批队列尚未结算，请查看加工状态' };
        if (industry === 'crafting' && getOverride(`rlt-craft-paused:${nodeId}`) === '1') return { blocked: '本站后续提交已暂停' };

        // 加工的两种限量模式：
        // - 下拉「流程」：面板配置的多步流程（需点「开始」）
        // - 下拉锁定配方 + 批次数 N>0：视为单步流程，做满 N 批即停（无需点开始）
        let pipeline = null;
        let pipelineJob = null;
        if (industry === 'crafting' && nodeId != null) {
            const override = nodeJobOverride(industry, nodeId);
            const isLocked = override != null && override !== NODE_JOB_OFF_RELEASE && override !== NODE_JOB_OFF_KEEP;
            const lockTimes = isLocked ? Math.floor(Number(getOverride(craftLockTimesKey(nodeId))) || 0) : 0;
            const steps = override == null ? craftPipelineSteps(nodeId)
                : (lockTimes > 0 ? [{ recipeId: override, times: lockTimes, taskItemId: '' }] : []);
            if (steps.length) {
                if (override == null && !craftPipelineRunning(nodeId)) return { blocked: '流程未启动（面板点「开始」）' };
                let prog = craftPipelineProgress(nodeId, steps);
                if (prog.legacy) return { blocked: '旧版进度按开工计数，请在空闲时重置后继续' };
                if (prog.finished) {
                    if (CONFIG.crafting.repeatPipeline && override == null) {
                        resetCraftPipeline(nodeId);
                        prog = craftPipelineProgress(nodeId, steps);
                    } else {
                    return { blocked: override == null ? '加工流程已完成（面板可重置）' : `锁定配方已完成 ${lockTimes} 批（改一下批次数即可重跑）` };
                    }
                }
                const step = steps[prog.stepIndex];
                const job = adapter.jobs(node).find(j => sameId(jobId(j), step.recipeId));
                if (!job || job.unlocked === false) {
                    return { blocked: `流程第 ${prog.stepIndex + 1} 步配方不存在或未解锁，等待调整` };
                }
                // 材料不足/不安全：原地等待（上游可能正在生产），不跳步
                if (!jobAvailable(state, industry, job)) {
                    return { blocked: `流程第 ${prog.stepIndex + 1} 步「${job.name || step.recipeId}」等待材料` };
                }
                pipeline = { stationId: nodeId, stepIndex: prog.stepIndex, steps, done: prog.done, taskItemId: step.taskItemId || '' };
                pipelineJob = job;
            }
        }

        const jobs = adapter.jobs(node).filter(job => jobAvailable(state, industry, job));
        if (!jobs.length) return { blocked: industry === 'crafting' ? '没有已解锁且材料安全的配方' : '没有可执行任务' };

        const wanted = configuredJobId(industry, cfg, nodeId);
        if (wanted === NODE_JOB_OFF_RELEASE || wanted === NODE_JOB_OFF_KEEP) {
            return { blocked: wanted === NODE_JOB_OFF_KEEP ? '已手动关闭（保留伙伴）' : '已手动关闭（释放伙伴）' };
        }
        // 面板锁定（点位级）始终严格；配置项锁定由 strictTaskId/strictRecipeId 决定
        const strict = !!cfg[adapter.strictKey] ||
            (nodeId != null && nodeJobOverride(industry, nodeId) != null);
        let candidates = jobs;
        if (pipelineJob) candidates = [pipelineJob]; // 流程步骤命中：该站只做当前步
        else if (wanted != null) {
            const exact = jobs.find(job => sameId(jobId(job), wanted));
            if (exact) candidates = [exact];
            else if (strict) return { blocked: `锁定目标 #${wanted} 当前不在此节点` };
        } else if (industry === 'crafting') {
            // 加工取消自动优选：「流程」模式下未配置流程的站停工，避免自动消耗背包材料
            return { blocked: '未配置加工流程（面板可配置流程或锁定单一配方）' };
        }

        const stamina = Math.max(0, liveStamina(state) - (industry === 'crafting' ? CONFIG.crafting.staminaReserve : 0));
        const affordable = candidates.filter(job => Number(job.stamina_cost || 0) <= stamina);
        if (!affordable.length) {
            const minCost = Math.min(...candidates.map(job => Number(job.stamina_cost || 0)));
            rememberStaminaNeed(state, minCost + (industry === 'crafting' ? CONFIG.crafting.staminaReserve : 0), `${INDUSTRY_NAMES[industry] || industry}任务`);
            return { blocked: `体力不足（当前约 ${stamina}/${state.player?.stamina_cap ?? '?'}）` };
        }

        const partner = assignedPartner(state, node);
        const ability = Number(state.industry_rules?.[industry]?.character_base_ability || 0) +
            (partner ? partnerAbility(partner, industry) : 0);
        // 流程步骤可单独指定道具：'' 跟随站点「道具」行、'__off' 本批不使用、其余为指定道具 id
        const pipeItemId = pipeline ? (pipeline.taskItemId || '') : '';
        const startItem = (pipeline && pipeItemId === '__off') ? null
            : slotTaskItem(state, industry, INDUSTRY_ADAPTERS[industry]?.id(node), 'start',
                pipeItemId && pipeItemId !== '__off' ? { forcedId: pipeItemId } : {});
        if (industry === 'crafting' && CONFIG.taskItems.enabled && CONFIG.crafting.useTaskItems && !CONFIG.crafting.partialTaskItems) {
            const choice = pipeItemId || getOverride(nodeTaskItemKey(industry, nodeId));
            const chosen = (state.task_items || []).find(item => sameId(taskItemRecordId(item), choice));
            if (chosen?.timing === 'start' && !startItem) return { blocked: '指定开工道具不足或已预留，等待补充' };
        }
        const durationMultiplier = taskItemDurationMultiplier(startItem);
        const scored = affordable.map((job, index) => {
            const hourly = jobHourlyValue(state, industry, job, ability, durationMultiplier);
            const seconds = jobDurationSeconds(job, ability, durationMultiplier) || 1;
            const value = hourly == null ? null : hourly * seconds / 3600;
            const cost = Number(job.stamina_cost || 0);
            const efficiency = value == null ? -Infinity : (cost > 0 ? value / cost : hourly);
            return {
                job, index, hourly: hourly ?? -Infinity, efficiency,
                demand: jobDemandScore(state, job, ability),
                taskItemId: taskItemRecordId(startItem), taskItem: startItem,
            };
        }).sort((a, b) => b.demand - a.demand || b.efficiency - a.efficiency || b.hourly - a.hourly || a.index - b.index);
        const best = scored[0];
        if (best && pipeline) best.pipeline = pipeline;
        return best || { blocked: '没有可执行任务' };
    }

    function inFlightIndustryGuaranteedQty(state, need) {
        let qty = 0;
        for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
            const base = Number(state.industry_rules?.[industry]?.character_base_ability || 0);
            for (const node of industryNodes(state, industry)) {
                if (industry === 'crafting') {
                    for (const out of [...(node.completed_results || []), ...(node.task_results || [])]) {
                        if (sameId(out.item_id ?? out.item?.item_id, need.itemId) && Number(out.quality || 0) >= Number(need.minQuality || 0)) qty += Math.max(0, Number(out.quantity || 0));
                    }
                    const recipe = node.recipe || node.task_snapshot?.recipe;
                    const future = Number(node.queued_count || 0) + (node.task_snapshot && !node.ready ? 1 : 0);
                    if (recipe && future > 0 && !Number(need.minQuality || 0)) {
                        for (const out of jobExpectedOutputs(recipe, 0, { conservative: true })) if (outputMatchesNeed(out, need)) qty += out.quantity * future;
                    }
                    continue;
                }
                if (node.empty || node.ready) continue;
                const snapshot = node.task_snapshot;
                const active = node.task || node.recipe || snapshot?.task || snapshot?.recipe || snapshot;
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
            if (!industryEnabled(industry) || !adapter.config().autoCollect) continue;
            const ready = node => industry === 'crafting' ? craftCollectable(node) : node?.ready && !node.empty;
            const ids = industryNodes(runtime.state, industry).filter(ready).map(adapter.id);
            for (const id of ids) {
                const node = nodeById(runtime.state, industry, id);
                if (!ready(node)) continue;
                if (industry === 'crafting' && craftFlight(id)?.phase === 'uncertain') continue;
                try {
                    const result = await collectSite(industry, id);
                    if (industry === 'crafting' && craftFlight(id)) {
                        const count = Number(result?.completed_count ?? node.completed_count ?? (node.ready ? 1 : 0));
                        creditCraftFlight(id, count);
                        const flight = craftFlight(id);
                        const fresh = nodeById(runtime.state, industry, id);
                        flight.observedCollected = Number(fresh?.collected_count || 0);
                        saveCraftFlight(id, flight.credited >= flight.quantity ? null : flight);
                    }
                    clearSkip(`fail:collect:${industry}:${id}`);
                    log(`${INDUSTRY_NAMES[industry] || industry}点 ${id}：已领取`);
                } catch (e) {
                    if (industry === 'crafting' && craftFlight(id) && (uncertainWrite(e) || e.code === 'aborted')) {
                        const flight = craftFlight(id);
                        flight.phase = 'uncertain'; flight.reason = '领取响应中断，请核对本批累计领取份数';
                        saveCraftFlight(id, flight);
                    }
                    if (shouldAbortTick(e)) throw e;
                    logSkip(`fail:collect:${industry}:${id}`, `${INDUSTRY_NAMES[industry] || industry}点 ${id} 领取失败：${e.message}`);
                }
            }
        }
    }

    // 每次只规划全产业中最优的一个开工动作，执行后用新 state 重新排名，避免固定顺序抢体力。
    async function startEmptyIndustries() {
        const failedNodes = new Set();
        while (true) {
            const state = runtime.state;
            const plans = [];
            for (const industry of Object.keys(INDUSTRY_ADAPTERS)) {
                const adapter = INDUSTRY_ADAPTERS[industry];
                if (!industryEnabled(industry) || !adapter.config().autoStart) continue;
                for (const node of industryNodes(state, industry)) {
                    if (!node.empty || node.task_snapshot) continue;
                    const id = adapter.id(node);
                    if (id == null) {
                        logSkip(`schema:start-id:${industry}`, `${industry} 节点缺少 id，已禁止请求 undefined`);
                        continue;
                    }
                    if (failedNodes.has(`${industry}:${id}`)) continue;
                    if (nodeJobClosed(industry, id)) continue; // 两种关闭模式都禁止点位开工
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
                if (plan.industry === 'crafting') {
                    if (!await startCraftPlan(plan)) failedNodes.add(`crafting:${plan.id}`);
                    continue;
                }
                await startSite(plan.industry, plan.id, plan.adapter.payloadKey, jobId(plan.job), plan.taskItemId ?? '');
                clearSkip(`fail:start:${plan.industry}:${plan.id}`);
                const itemText = plan.taskItem
                    ? `，使用 ${plan.taskItem.name || '任务道具#' + plan.taskItemId}` : '';
                log(`${INDUSTRY_NAMES[plan.industry]}点 ${plan.id}：开工「${plan.job.name || '任务#' + jobId(plan.job)}」${itemText}`);
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                logSkip(`fail:start:${plan.industry}:${plan.id}`, `${INDUSTRY_NAMES[plan.industry]}点 ${plan.id} 开工失败：${e.message}`);
                failedNodes.add(`${plan.industry}:${plan.id}`); // 本轮跳过该点，继续尝试其余合法计划
            }
        }
    }

    // ---------- 水产：垂钓 + 鱼塘 ----------

    // 钓点选择：面板锁定/配置指定 > 聚鱼度所在钓点（换钓点会清零聚鱼度）> 第一个已解锁钓点
    function pickFishingSpot(aq) {
        const spots = (aq?.spots || []).filter(s => s && s.unlocked && s.id != null);
        if (!spots.length) return null;
        const wanted = getOverride(AQUATIC_SPOT_KEY) ?? CONFIG.aquatic.spotId;
        if (wanted != null && wanted !== '') {
            const forced = spots.find(s => sameId(s.id, wanted));
            if (forced) {
                clearSkip('aquatic:bad-spot');
                return forced;
            }
            logSkip('aquatic:bad-spot', `指定钓点 #${wanted} 未解锁或不存在，回退到自动选择`);
        }
        const comboSpot = Number(aq.combo?.layers || 0) > 0
            ? spots.find(s => sameId(s.id, aq.combo.spot_id)) : null;
        return comboSpot || spots[0];
    }

    // 大物咬钩：按配置自动搏一把/放线；'manual' 由 tick 入口暂停等人工，不走这里
    // 返回实际动作（'fight'/'release'），失败或无大物返回 null
    async function doBigCatch(state) {
        const pending = state.aquatic?.pending_big_catch;
        if (!pending) return null;
        const cfg = CONFIG.aquatic;
        const chance = Number(pending.chance ?? 0);
        // 大物消耗 = 钓点单竿消耗（已与开发者确认）；服务器字段缺失时按钓点消耗兜底
        const spotCost = Number(pickFishingSpot(state.aquatic)?.stamina_cost || 0);
        const cost = Number(pending.stamina_cost ?? spotCost) || 0;
        const stamina = liveStamina(state);
        const fight = cfg.bigCatch === 'fight' && chance >= Number(cfg.fightMinChance || 0) && stamina >= cost;
        const action = fight ? 'fight' : 'release';
        try {
            const result = await resolveBigCatch(action);
            clearSkip('aquatic:big-catch');
            if (fight) {
                log(`大物「${pending.name || '?'}」搏斗${result?.success ? `成功${result.size ? `，${result.size} 厘米` : ''}` : '失败'}（成功率 ${Math.round(chance * 100)}%）`);
            } else {
                const reason = stamina < cost ? '，体力不足' : '';
                log(`大物「${pending.name || '?'}」已放线（成功率 ${Math.round(chance * 100)}%${reason}），改收寻常渔获`);
            }
            return action;
        } catch (e) {
            if (shouldAbortTick(e)) throw e;
            logSkip('fail:big-catch', `大物处理失败：${e.message}`);
            return null;
        }
    }

    // 垂钓：体力恢复比聚鱼度衰退慢，滴钓保不住连击——攒够「连钓次数」竿的体力后一次性连钓，
    // 让聚鱼度在这一连内叠上去；钓完等体力重新攒满再钓下一连。
    async function doFishing() {
        const cfg = CONFIG.aquatic;
        if (!fishingEnabled() || !runtime.state?.aquatic?.unlocked) return;
        const chain = fishingChainCasts();
        const reserve = fishingStaminaReserve();
        // 先处理挂着的大物（可能来自手动垂钓）
        if (runtime.state.aquatic?.pending_big_catch) {
            if (cfg.bigCatch === 'manual') return;
            await doBigCatch(runtime.state);
            if (runtime.state.aquatic?.pending_big_catch) return; // 处理失败：本轮不再抛竿
        }
        const spot = pickFishingSpot(runtime.state.aquatic);
        if (!spot) {
            logSkip('aquatic:no-spot', '水产：没有已解锁的钓点');
            return;
        }
        clearSkip('aquatic:no-spot');
        const cost = Number(spot.stamina_cost || 0);
        // 大物预留：只有打算搏斗时才预留；大物消耗 = 当前钓点单竿消耗（已与开发者确认）
        const bigReserve = bigCatchReserveEnabled() && cfg.bigCatch === 'fight' ? cost : 0;
        const need = cost * chain + reserve + bigReserve;
        const cap = Math.max(Number(runtime.state.player?.stamina_cap ?? Infinity), liveStamina(runtime.state));
        let plan = chain;
        let waitFull = false;
        if (cost > 0 && need > cap) {
            // 连钓次数＋大物预留超过体力上限：永远攒不够，提醒用户调低；未调整则满体力时按上限内最多次数连钓
            plan = Math.floor((cap - reserve - bigReserve) / cost);
            if (plan < 1) {
                logSkip('aquatic:chain-over-cap', `垂钓：体力上限 ${cap} 连 1 竿＋保底预留（${cost + reserve + bigReserve} 体力）都不够，无法垂钓，请调低体力保底或关闭大物预留`);
                return;
            }
            logSkip('aquatic:chain-over-cap', `垂钓：连钓×${chain}${bigReserve ? '＋大物预留 1 竿' : ''}共需 ${need} 体力，超过上限 ${cap}，永远攒不够；将在满体力时降级连钓×${plan}，请调低连钓次数`);
            waitFull = true;
        } else {
            clearSkip('aquatic:chain-over-cap');
        }
        const planNeed = cost * plan + reserve + bigReserve;
        const stamina = liveStamina(runtime.state);
        if (waitFull ? stamina < cap : stamina < planNeed) {
            // 攒不够一连就不下竿；登记缺口，下一轮在体力刚攒够时醒来（降级模式则等到满体力）
            rememberStaminaNeed(runtime.state, waitFull ? cap : planNeed, `垂钓连钓×${plan}`);
            return;
        }
        log(`体力已攒够（${Math.floor(stamina)}/${waitFull ? cap : planNeed}），在「${spot.name || spot.id}」连钓 ×${plan}${waitFull ? `（原设×${chain} 超体力上限，已降级）` : ''}${bigReserve ? '（含大物预留 1 竿）' : ''}`);
        let bigCatchSpent = !bigReserve; // 本连的大物预留是否已消耗（不预留视为已消耗）
        let cooldownHits = 0; // 本连撞上的抛竿限流次数（自适应拉长间隔，最多重试 3 次）
        let castInterval = Number(cfg.castIntervalMs || 0);
        for (let i = 0; i < plan && running; i++) {
            if (i > 0 && castInterval > 0) await sleep(castInterval); // 服务器限制最小抛竿间隔
            if (!running || !fishingEnabled()) break;
            const hold = reserve + (bigCatchSpent ? 0 : bigReserve);
            if (liveStamina(runtime.state) - cost < hold) break;
            try {
                const result = await castLine(spot.id);
                clearSkip(`fail:cast:${spot.id}`);
                if (result && !result.duplicate) {
                    const drops = (result.drops || []).map(d => `${d.quality_name || ''}${d.name}×${d.quantity}`).join('、');
                    log(`第 ${i + 1}/${plan} 竿：${result.big_catch ? '有大家伙咬钩！' : (drops || '一无所获')}`);
                }
                if (runtime.state.aquatic?.pending_big_catch) {
                    if (cfg.bigCatch === 'manual') break;
                    const acted = await doBigCatch(runtime.state);
                    if (acted === 'fight') bigCatchSpent = true; // 预留已用掉，后续竿不再压体力
                    if (runtime.state.aquatic?.pending_big_catch) break; // 处理失败：中止本连
                }
            } catch (e) {
                // 抛竿限流（「缓一口气」类）：不是致命错误，拉长间隔后重试同一竿，避免整轮被中止
                const cooldown = Number(e.status || 0) === 429 || /缓一口气|歇一歇|太快|稍后再/.test(e.message || '');
                if (cooldown && cooldownHits < 3) {
                    cooldownHits++;
                    castInterval = Math.max(castInterval * 2, Number(e.retryAfter || 0));
                    log(`抛竿太快被服务器拦下，${(castInterval / 1000).toFixed(1)} 秒后重试第 ${i + 1} 竿`);
                    await sleep(castInterval);
                    i--; // 重试同一竿
                    continue;
                }
                if (shouldAbortTick(e)) throw e;
                logSkip(`fail:cast:${spot.id}`, `垂钓「${spot.name || spot.id}」失败：${e.message}`);
                break;
            }
        }
    }

    // 鱼塘：捞走超出保留线的成鱼（保持世代加值），捞后用手头鱼苗把鱼塘补到目标尾数（不从商店购买鱼苗）
    async function doPonds() {
        const cfg = CONFIG.aquatic;
        const aq = runtime.state?.aquatic;
        if (!cfg.enabled || !cfg.ponds || !aq?.unlocked) return;
        if (cfg.autoBuildPonds) {
            for (const site of aq.buildable_ponds || []) {
                if (!site.unlocked || !site.affordable) continue;
                try {
                    await buildPond(site.id);
                    clearSkip(`fail:build-pond:${site.id}`);
                    log(`已挖好新鱼塘「${site.name || site.id}」（${site.build_cost} 红叶币）`);
                } catch (e) {
                    if (shouldAbortTick(e)) throw e;
                    logSkip(`fail:build-pond:${site.id}`, `挖塘「${site.name || site.id}」失败：${e.message}`);
                }
            }
        }
        for (const pond of runtime.state.aquatic?.ponds || []) {
            if (pond.pond_id == null) continue;
            const label = `鱼塘「${pond.definition?.name || pond.pond_id}」`;
            const stock = Math.max(0, Number(pond.stock || 0));
            // 保留线 = 游戏稳态线与配置 pondKeepStock 的较大者（稳态线以下会掉世代加值）
            const keep = Math.max(Math.max(0, Number(pond.steady_stock || 0)), Number(cfg.pondKeepStock || 0));
            // 捞鱼：只捞超出保留线的部分，捞鱼不消耗体力
            const surplus = stock - keep;
            if (cfg.autoHarvestPonds && surplus > 0) {
                try {
                    await harvestPond(pond.pond_id, surplus);
                    clearSkip(`fail:harvest-pond:${pond.pond_id}`);
                    log(`${label}：捞鱼 ×${surplus}（保留 ${keep} 尾）`);
                } catch (e) {
                    if (shouldAbortTick(e)) throw e;
                    logSkip(`fail:harvest-pond:${pond.pond_id}`, `${label} 捞鱼失败：${e.message}`);
                }
            }
            // 投苗补齐：捞鱼后若低于目标尾数，用手头现有鱼苗补到目标（只用手头鱼苗，不从商店购买；
            // 沿用官方选种：塘里已有品种优先，否则第一个已解锁品种）。捞鱼会刷新 state，需重新取该塘数据
            const fresh = (runtime.state.aquatic?.ponds || []).find(p => sameId(p.pond_id, pond.pond_id)) || pond;
            const species = fresh.species_id != null
                ? (runtime.state.aquatic.species || []).find(s => sameId(s.id, fresh.species_id))
                : (runtime.state.aquatic.species || []).find(s => s.unlocked);
            if (cfg.autoStockPonds && species && species.id != null && Number(species.owned_fry || 0) > 0) {
                const freshStock = Math.max(0, Number(fresh.stock || 0));
                const freshFry = (fresh.fry || []).reduce((sum, f) => sum + Number(f.count || 0), 0);
                const capacity = Number(fresh.capacity || 0);
                // 补苗目标 = 配置 pondRestockTarget 与容量的较小者
                const target = Math.min(capacity, Number(cfg.pondRestockTarget || 0) || capacity);
                const room = Math.max(0, target - Number(fresh.population ?? (freshStock + freshFry)));
                const qty = Math.min(room, Number(species.owned_fry || 0));
                if (qty > 0) {
                    try {
                        await stockPond(fresh.pond_id, species.id, qty);
                        clearSkip(`fail:stock:${fresh.pond_id}`);
                        log(`${label}：投苗 ${species.fry_item?.name || species.name || species.id} ×${qty}（补至 ${target} 尾）`);
                    } catch (e) {
                        if (shouldAbortTick(e)) throw e;
                        logSkip(`fail:stock:${fresh.pond_id}`, `${label} 投苗失败：${e.message}`);
                    }
                }
            }
        }
    }

    const BALANCED_FEED_NAME = '均衡饲料';
    const FEED_FILL_KEY = 'rlt-feed-filling';
    function feedThresholds(slot) {
        const capacity = Number(slot?.capacity);
        const factor = CONFIG.feed.thresholdMode === 'percent' ? capacity / 100 : 1;
        const low = Number(CONFIG.feed.low) * factor;
        const target = Math.min(capacity, Number(CONFIG.feed.target) * factor);
        return { low, target, valid: Number.isFinite(capacity) && capacity > 0 && Number.isFinite(low) &&
            Number.isFinite(target) && low >= 0 && low < target && target <= capacity };
    }
    function balancedFeedEntry(state) {
        return (state.shop || []).find(entry => (entry.item?.name ?? entry.name) === BALANCED_FEED_NAME &&
            !entry.locked && entry.unlocked !== false && entry.id != null) || null;
    }
    function balancedFeedInputs(state) {
        const entry = balancedFeedEntry(state);
        return (state.aquatic?.feed_slot?.inputs || []).filter(input =>
            input.item_id != null && Number(input.units) > 0 &&
            (entry ? sameId(input.item_id, shopEntryItemId(entry)) : (input.item?.name ?? input.name) === BALANCED_FEED_NAME));
    }
    function feedFreeQuantity(state, input) {
        const stacks = (state.inventory || []).filter(item => sameId(item.item_id, input.item_id));
        const rows = reservedStacksForItem(state, stacks, craftingInputReserves(state), { dedicatedFeed: true });
        return rows.filter(row => Number(row.item.quality || 0) === Number(input.quality || 0))
            .reduce((sum, row) => sum + row.free, 0);
    }
    function feedStockPlan(state, inputs, target) {
        const slot = state.aquatic.feed_slot;
        let missing = target - Number(slot.units), room = Number(slot.capacity) - Number(slot.units);
        const deposits = [];
        for (const input of inputs) {
            if (missing <= 0) break;
            const units = Number(input.units);
            const count = Math.min(Math.floor(feedFreeQuantity(state, input)), Math.floor(room / units), Math.ceil(missing / units));
            if (count <= 0) continue;
            deposits.push({ input, count });
            missing -= count * units; room -= count * units;
        }
        return { deposits, missing: Math.max(0, missing), room };
    }
    function identifyPurchasedFeed(before, after, itemId) {
        const quantityAt = (state, quality) => (state.inventory || [])
            .filter(item => sameId(item.item_id, itemId) && Number(item.quality || 0) === quality)
            .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        // 从实际购买响应识别品质与换算量，不能拿背包中另一品质的饲料来估算新购商品。
        const candidates = balancedFeedInputs(after).filter(input => sameId(input.item_id, itemId) &&
            quantityAt(after, Number(input.quality || 0)) > quantityAt(before, Number(input.quality || 0)));
        return candidates.length === 1 ? { itemId, quality: Number(candidates[0].quality || 0), units: Number(candidates[0].units) } : null;
    }
    // 低水位触发后持续补到目标；购买和投入都读取最新 state，只消费指定饲料。
    async function doAquaticFeed() {
        const cfg = CONFIG.feed;
        if (!CONFIG.feed.enabled) return;
        let spent = 0;
        let calibrated = false;
        const build = detectedGameBuild();
        let purchasedFeed = runtime.feedPurchase?.build === build ? runtime.feedPurchase : null;
        const maxAttempts = 12;
        for (let attempt = 0; attempt < maxAttempts && running && CONFIG.feed.enabled; attempt++) {
            const state = runtime.state;
            const slot = state.aquatic?.feed_slot;
            if (!slot || !(state.aquatic?.unlocked || state.livestock?.unlocked)) return;
            const bounds = feedThresholds(slot);
            if (!bounds.valid) { logSkip('feed:bounds', '饲料上下限无效：请设置 0 ≤ 底限 < 填充目标 ≤ 容量'); return; }
            clearSkip('feed:bounds');
            if (Number(slot.units) >= bounds.target) { setOverride(FEED_FILL_KEY, ''); return; }
            if (Number(slot.units) > bounds.low && getOverride(FEED_FILL_KEY) !== '1') return;
            setOverride(FEED_FILL_KEY, '1');
            const inputs = balancedFeedInputs(state);
            if (inputs.length && getOverride('rlt-feed-pending-item')) setOverride('rlt-feed-pending-item', '');
            const plan = feedStockPlan(state, inputs, bounds.target);
            try {
                let blocked = null;
                // 留出最后一次操作投入已买到的饲料，超大缺口留待下一轮继续。
                if (plan.missing > 0 && cfg.autoBuy && (attempt < maxAttempts - 1 || !plan.deposits.length)) {
                    const entry = balancedFeedEntry(state), price = Number(entry?.price);
                    if (!entry || !Number.isFinite(price) || price < 0) {
                        blocked = ['feed:shop', '商店暂无可购买的“均衡饲料”，等待商品数据'];
                    } else {
                        const itemId = shopEntryItemId(entry);
                        const sameProduct = purchasedFeed && sameId(purchasedFeed.itemId, itemId) && sameId(purchasedFeed.shopId, entry.id);
                        const knownInput = sameProduct
                            ? inputs.find(input => Number(input.quality || 0) === purchasedFeed.quality) : null;
                        if (knownInput) purchasedFeed.units = Number(knownInput.units);
                        const knownUnits = sameProduct ? purchasedFeed.units : 0;
                        const allowance = Math.max(0, Math.min(playerCoins(state) - cfg.coinReserve, cfg.maxSpendPerTick - spent));
                        const affordable = cfg.maxSpendPerTick > 0 && playerCoins(state) >= cfg.coinReserve
                            ? (price > 0 ? Math.floor(allowance / price) : 99) : 0;
                        if (knownUnits > plan.room) {
                            blocked = ['feed:room', '饲料槽剩余空间不足一份均衡饲料，等待消耗后再补'];
                        } else if (!knownUnits && (calibrated || sameId(getOverride('rlt-feed-pending-item'), itemId))) {
                            blocked = ['feed:metadata', '已购入均衡饲料，但服务器未给出可投喂信息，暂停购买'];
                        } else {
                            const needed = knownUnits > 0 ? Math.min(Math.floor(plan.room / knownUnits), Math.ceil(plan.missing / knownUnits)) : 1;
                            const count = Math.min(cfg.batchBuy ? 99 : 1, affordable, needed);
                            if (count > 0) {
                                await buyItem(entry.id, count);
                                const observed = identifyPurchasedFeed(state, runtime.state, itemId);
                                purchasedFeed = observed ? { ...observed, shopId: entry.id, build } : null;
                                runtime.feedPurchase = purchasedFeed; // 页面内复用；刷新或游戏构建变化后重新识别。
                                setOverride('rlt-feed-pending-item', purchasedFeed ? '' : String(itemId));
                                spent += price * count; calibrated = true;
                                log(`已购买${BALANCED_FEED_NAME} ×${count}（${price * count} 金币）`);
                                if (inventoryQty(runtime.state, itemId) <= inventoryQty(state, itemId)) return;
                                continue; // 先补足可用库存，再合并投料；始终用购买响应重新计算缺口。
                            }
                            blocked = ['feed:budget', '均衡饲料购买达到本轮预算或金币保底，等待下一轮'];
                        }
                    }
                } else if (plan.missing > 0 && !cfg.autoBuy) blocked = ['feed:stock', '均衡饲料库存不足或已预留，自动购买已关闭'];
                // 预算不足或购买不可用时，先投入现有可用库存，不要求整批买齐才投料。
                if (plan.deposits.length) {
                    const { input, count } = plan.deposits[0];
                    await depositFeed(input.item_id, Number(input.quality || 0), count);
                    log(`饲料槽：投入${BALANCED_FEED_NAME} ×${count}，余量 ${Math.floor(runtime.state.aquatic.feed_slot.units)} 份`);
                    if (Number(runtime.state.aquatic?.feed_slot?.units) <= Number(slot.units)) return;
                    continue;
                }
                if (blocked) logSkip(...blocked);
                return;
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                logSkip('feed:failed', `均衡饲料补充失败：${e.message}`); return;
            }
        }
    }

    const SAILING_INTENT_KEY = 'rlt-sailing-intent';
    function sailingConfiguredIds() {
        try {
            const ids = JSON.parse(CONFIG.sailing.partnerIds || '[]');
            return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' || typeof id === 'number').map(String))].slice(0, 3) : [];
        } catch { return []; }
    }
    function outsidePartnerIds(state, includeReserved = true) {
        const ids = new Set();
        addPartnerIds(ids, state?.exploration?.active_run?.partner_ids);
        addPartnerIds(ids, state?.sailing?.active_run?.partner_ids);
        if (includeReserved && CONFIG.sailing.enabled && CONFIG.sailing.autoStart && CONFIG.sailing.reservePartners) addPartnerIds(ids, sailingConfiguredIds());
        return ids;
    }
    function sailingPartners(state, route) {
        const used = new Set([...outsidePartnerIds(state, false), ...aquaticAssignedPartnerIds(state), ...livestockAssignedPartnerIds(state)]);
        const available = partner => partner && !partner.missing && !partner.locked &&
            !used.has(String(partnerRecordId(partner))) &&
            ['assigned_plot_slot', 'assigned_gathering_site_id', 'assigned_mining_site_id', 'assigned_crafting_station_id'].every(key => partner[key] == null);
        const selected = sailingConfiguredIds();
        if (selected.length) return selected.every(id => available((state.partners || []).find(p => sameId(partnerRecordId(p), id)))) ? selected : [];
        if (!CONFIG.sailing.autoAssign) return [];
        const industry = Number(route.required_voyages || 0) >= 3 ? 'exploration' : 'aquatic';
        return (state.partners || []).filter(available).sort((a, b) => partnerAbility(b, industry) - partnerAbility(a, industry))
            .slice(0, Math.min(3, Math.max(1, CONFIG.sailing.partySize))).map(partnerRecordId);
    }
    function sailingMaterialNeeds(state) {
        const cfg = CONFIG.sailing, sail = state.sailing;
        if (!cfg.enabled || !sail?.unlocked) return [];
        const rows = [];
        if (cfg.autoBuild && !sail.ship_built) rows.push(...(sail.construction?.materials || []));
        if (cfg.autoStart) {
            const supply = sail.supplies?.find(item => sameId(item.id, cfg.supplyId));
            if (supply?.quantity > 0) rows.push(supply);
        }
        if (cfg.autoUpgrade && sail.ship_built) {
            const upgrade = sail.upgrades?.find(item => item.level < Math.min(3, cfg.upgradeLimit));
            if (upgrade) rows.push(upgrade);
        }
        return rows.filter(row => row.item_id != null && Number(row.quantity) > 0).map(row => ({
            source: 'sailing', itemId: row.item_id, name: row.item_name || '', minQuality: 0, need: Number(row.quantity),
        }));
    }
    function sailingAvailableQty(state, itemId) {
        if (itemId == null) return 0;
        return safeUnspecifiedConsumeQty(state, itemId, '', { excludeSailing: true, applyDefaultKeep: false });
    }
    function sailingInputsSafe(state, inputs) {
        const totals = new Map();
        for (const row of inputs) {
            if (!(Number(row.quantity) > 0)) continue;
            if (row.item_id == null) return false;
            const key = String(row.item_id);
            totals.set(key, (totals.get(key) || 0) + Number(row.quantity));
        }
        return [...totals].every(([id, quantity]) => sailingAvailableQty(state, id) >= quantity);
    }
    async function doSailing() {
        const cfg = CONFIG.sailing;
        if (!cfg.enabled || !runtime.state.sailing?.unlocked) return;
        let spent = 0;
        const canSpend = cost => Number.isFinite(Number(cost)) && Number(cost) >= 0 &&
            Number(cost) <= cfg.maxSpendPerTick - spent && playerCoins(runtime.state) - Number(cost) >= cfg.coinReserve;
        let sail = runtime.state.sailing;
        try {
            if (sail.active_run) {
                if (cfg.autoCollect && Number(sail.active_run.ready_at) <= serverNowSeconds()) {
                    await mutate('/sailing/collect', { payload: { run_id: sail.active_run.run_id } });
                    setOverride(SAILING_INTENT_KEY, '');
                    log(`航海：已领取「${sail.active_run.route_name || '航程'}」收获`);
                } else return;
            }
            sail = runtime.state.sailing;
            if (sail.active_run) return;
            if (readJson(SAILING_INTENT_KEY)) { logSkip('sailing:uncertain', '上次出航结果待核对，请在航海面板确认后继续'); return; }
            if (!sail.ship_built) {
                if (!cfg.autoBuild) return;
                if (!sail.construction || !canSpend(sail.construction.coins) || !sailingInputsSafe(runtime.state, sail.construction.materials || [])) {
                    logSkip('sailing:build', '建船材料不足、已预留或超出金币预算'); return;
                }
                const cost = Number(sail.construction.coins);
                await mutate('/sailing/build', { payload: {} });
                spent += cost; log('航海：初帆号已建造');
                sail = runtime.state.sailing;
                if (!sail.ship_built) return;
            }
            if (cfg.autoUpgrade) {
                const upgrade = sail.upgrades?.find(item => item.level < Math.min(3, cfg.upgradeLimit) &&
                    canSpend(item.coins) && sailingInputsSafe(runtime.state, [item]));
                if (upgrade) {
                    await mutate('/sailing/upgrade', { payload: { kind: upgrade.kind, expected_level: upgrade.level } });
                    spent += Number(upgrade.coins); log(`航海：${upgrade.name || upgrade.kind}已改装`);
                    sail = runtime.state.sailing;
                }
            }
            if (!cfg.autoStart) return;
            const route = sail.routes?.find(item => sameId(item.id, cfg.routeId) && item.unlocked);
            if (!route) { logSkip('sailing:route', '请选择一条已解锁航线后自动出航'); return; }
            const supply = sail.supplies?.find(item => sameId(item.id, cfg.supplyId));
            if (!supply && cfg.supplyId !== 'none') { logSkip('sailing:supply', '指定航海补给当前不可用'); return; }
            if (supply?.quantity > 0) {
                const available = sailingAvailableQty(runtime.state, supply.item_id);
                if (supply.item_id == null) { logSkip('sailing:supply', '航海补给缺少物品信息，请刷新游戏后重试'); return; }
                if (available < Number(supply.quantity)) {
                    const owned = inventoryQty(runtime.state, supply.item_id);
                    logSkip('sailing:supply', `航海补给「${supply.item_name || supply.name}」不足：库存 ${owned}，安全可用 ${available}，需要 ${supply.quantity}（已保护委托、传送门、加工计划和指定保留量）`);
                    return;
                }
            }
            clearSkip('sailing:supply');
            if (!canSpend(route.coins)) { logSkip('sailing:budget', '出航费用超出本轮预算或金币保底'); return; }
            const stamina = Number(route.stamina);
            if (!Number.isFinite(stamina) || stamina < 0) return;
            if (liveStamina(runtime.state) < stamina + cfg.staminaReserve) {
                rememberStaminaNeed(runtime.state, stamina + cfg.staminaReserve, '航海'); return;
            }
            const partnerIds = sailingPartners(runtime.state, route);
            if (!partnerIds.length) { logSkip('sailing:partners', '等待空闲航海伙伴（不会从其他生产岗位撤人）'); return; }
            const payload = { route_id: route.id, partner_ids: partnerIds, supply_id: cfg.supplyId, request_id: crypto.randomUUID() };
            setOverride(SAILING_INTENT_KEY, JSON.stringify(payload));
            try {
                await mutate('/sailing/start', { payload });
                setOverride(SAILING_INTENT_KEY, '');
                log(`航海：已出发前往「${route.name}」，${partnerIds.length} 名伙伴`);
            } catch (error) {
                if (!uncertainWrite(error) && !['aborted', 'story_active'].includes(error.code)) setOverride(SAILING_INTENT_KEY, '');
                throw error;
            }
        } catch (error) {
            if (shouldAbortTick(error)) throw error;
            logSkip('sailing:failed', `航海操作失败：${error.message}`);
        }
    }

    // 水产伙伴：陪钓 1 名 + 每口塘 1 名，从有水产倾向的空闲伙伴中挑特性最贴合、能力最强的
    async function doAquaticPartners() {
        const cfg = CONFIG.aquatic;
        const aq = runtime.state?.aquatic;
        if (!cfg.enabled || !cfg.autoAssignPartner || !aq?.unlocked) return;
        const capacity = Number(runtime.state.industry_rules?.aquatic?.partner_capacity || 0);
        const aquaticIds = aquaticAssignedPartnerIds(runtime.state);
        if (capacity > 0 && aquaticIds.size >= capacity) return;
        const idle = (runtime.state.partners || [])
            .filter(p => isPartnerIdle(p) && hasTendency(p, 'aquatic') &&
                !aquaticIds.has(String(p.partner_id ?? p.id)))
            .sort((a, b) => partnerIndustryScore(b, 'aquatic') - partnerIndustryScore(a, 'aquatic'));
        if (!idle.length) return;
        const takeNext = () => idle.shift();
        if (fishingEnabled() && aq.companion == null) {
            const partner = takeNext();
            if (partner) {
                const pid = partner.partner_id ?? partner.id;
                try {
                    await assignFishingCompanion(pid);
                    clearSkip('fail:assign-companion');
                    aquaticIds.add(String(pid));
                    log(`已安排 ${partner.name || '伙伴#' + pid} 陪钓（水产 ${partnerAbility(partner, 'aquatic')}）`);
                } catch (e) {
                    if (shouldAbortTick(e)) throw e;
                    logSkip('fail:assign-companion', `安排陪钓伙伴失败：${e.message}`);
                }
            }
        }
        for (const pond of runtime.state.aquatic?.ponds || []) {
            if (pond.pond_id == null || nodeHasAssignedOrPendingPartner(pond)) continue;
            if (capacity > 0 && aquaticIds.size >= capacity) break;
            const partner = takeNext();
            if (!partner) break;
            const pid = partner.partner_id ?? partner.id;
            try {
                await assignPondPartner(pond.pond_id, pid);
                clearSkip(`fail:assign-pond:${pond.pond_id}`);
                aquaticIds.add(String(pid));
                log(`已安排 ${partner.name || '伙伴#' + pid} 看塘「${pond.definition?.name || pond.pond_id}」（水产 ${partnerAbility(partner, 'aquatic')}）`);
            } catch (e) {
                if (shouldAbortTick(e)) throw e;
                logSkip(`fail:assign-pond:${pond.pond_id}`, `安排看塘伙伴失败：${e.message}`);
            }
        }
    }

    async function doAquatic() {
        if (!CONFIG.aquatic.enabled) return;
        const aq = runtime.state?.aquatic;
        if (!aq || typeof aq !== 'object') {
            logSkip('aquatic:no-state', 'state 中没有 aquatic 字段，水产自动化跳过');
            return;
        }
        clearSkip('aquatic:no-state');
        if (!aq.unlocked) return;
        await doAquaticPartners();
        await doPonds();
        await doFishing(); // 垂钓放最后：只花各产业开工后剩下的体力
    }

    // 成就：有可领取的奖励时一键领取（枫火）
    async function doAchievements() {
        if (!CONFIG.achievements.enabled) return;
        const ach = runtime.state?.achievements;
        if (!ach || Number(ach.claimable || 0) <= 0) return;
        try {
            const result = await claimAllAchievements();
            clearSkip('fail:achievements');
            const count = Array.isArray(result?.claimed) ? result.claimed.length : Number(ach.claimable);
            log(`已领取 ${count} 项成就奖励（+${result?.maple_flame ?? '?'} 枫火）`);
        } catch (e) {
            if (shouldAbortTick(e)) throw e;
            logSkip('fail:achievements', `领取成就奖励失败：${e.message}`);
        }
    }

    // 畜牧：派驻看场伙伴 → 收取产出（免费）→ 照料动物（1 体力/次，只花体力保底之上的余量）
    // 购买/配种/孵蛋涉及金币与基因决策，保持人工操作
    async function doLivestock() {
        const cfg = CONFIG.livestock;
        const lv = runtime.state?.livestock;
        if (!cfg.enabled || !lv?.unlocked) return;
        if (CONFIG.livestock.autoAssignPartner) {
            const capacity = Number(runtime.state.industry_rules?.livestock?.partner_capacity || 0);
            const livestockIds = livestockAssignedPartnerIds(runtime.state);
            const idle = (runtime.state.partners || [])
                .filter(p => isPartnerIdle(p) && hasTendency(p, 'livestock') &&
                    !livestockIds.has(String(p.partner_id ?? p.id)))
                .sort((a, b) => partnerIndustryScore(b, 'livestock') - partnerIndustryScore(a, 'livestock'));
            for (const facility of lv.facilities || []) {
                if (facility.facility_id == null || nodeHasAssignedOrPendingPartner(facility)) continue;
                if (capacity > 0 && livestockIds.size >= capacity) break;
                const partner = idle.shift();
                if (!partner) break;
                const pid = partner.partner_id ?? partner.id;
                try {
                    await assignLivestockPartner(facility.facility_id, pid);
                    clearSkip(`fail:assign-livestock:${facility.facility_id}`);
                    livestockIds.add(String(pid));
                    log(`已安排 ${partner.name || '伙伴#' + pid} 看场「${facility.name || facility.facility_id}」（畜牧 ${partnerAbility(partner, 'livestock')}）`);
                } catch (e) {
                    if (shouldAbortTick(e)) throw e;
                    logSkip(`fail:assign-livestock:${facility.facility_id}`, `安排看场伙伴失败：${e.message}`);
                }
            }
        }
        if (CONFIG.livestock.autoCollect) {
            for (const facility of runtime.state.livestock?.facilities || []) {
                if (facility.facility_id == null) continue;
                const pending = Number(facility.pending_total || 0) + Number(facility.pending_special || 0);
                if (pending <= 0) continue;
                try {
                    const result = await collectLivestock(facility.facility_id);
                    clearSkip(`fail:collect-livestock:${facility.facility_id}`);
                    const drops = (result?.drops || []).map(d => `${d.quality_name || ''}${d.name}×${d.quantity}`).join('、');
                    log(`畜牧「${facility.name || facility.facility_id}」：收取 ${drops || `${pending} 份产出`}`);
                } catch (e) {
                    if (shouldAbortTick(e)) throw e;
                    logSkip(`fail:collect-livestock:${facility.facility_id}`, `畜牧收取失败：${e.message}`);
                }
            }
        }
        if (CONFIG.livestock.autoCare) {
            const floor = fishingStaminaReserve(); // 与垂钓共用体力保底：只花保底之上的余量
            outer:
            for (const facility of runtime.state.livestock?.facilities || []) {
                for (const animal of facility.animals || []) {
                    if (animal.animal_id == null || animal.stage === 'incubating') continue;
                    if (Number(animal.cared_today || 0) >= Number(animal.care_daily_limit || 0)) continue;
                    if (Number(animal.affection || 0) >= Number(animal.affection_cap || 0)) continue;
                    if (liveStamina(runtime.state) - 1 < floor) break outer;
                    try {
                        const result = await careAnimal(animal.animal_id);
                        clearSkip(`fail:care:${animal.animal_id}`);
                        const name = animal.nickname || animal.name || animal.species_name || animal.animal_id;
                        log(`照料了「${name}」（亲密度 ${result?.affection_before ?? '?'} → ${result?.affection ?? '?'}）`);
                    } catch (e) {
                        if (shouldAbortTick(e)) throw e;
                        logSkip(`fail:care:${animal.animal_id}`, `照料失败：${e.message}`);
                        break outer; // 照料失败多为全局原因（体力不足等），本连不再逐只尝试
                    }
                }
            }
        }
        // 饲料槽水产/畜牧共用：水产未解锁但畜牧已解锁时也要补料（水产启用时 doAquatic 会再检查一次，余量够则不重复投）
    }

    // ---------- 角色库扫描 ----------
    const INDUSTRY_NAMES = {
        farming: '农作', gathering: '采集', mining: '矿产',
        aquatic: '水产', livestock: '畜牧', crafting: '加工',
    };

    function partnerPost(p, state = null) {
        if (p.locked) return '任务中·已锁定';
        for (const [industry, field] of Object.entries(ASSIGN_FIELD)) {
            if (p[field] != null) return `派驻于${INDUSTRY_NAMES[industry] || industry}`;
        }
        if (state && aquaticAssignedPartnerIds(state).has(String(p.partner_id ?? p.id))) return '派驻于水产';
        if (state && livestockAssignedPartnerIds(state).has(String(p.partner_id ?? p.id))) return '派驻于畜牧';
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
            const traits = (p.traits || []).map(t => t.name || t.code).filter(Boolean).join('、');
            log(`· ${p.name || p.partner_id}｜${tend || '无产业倾向'}${traits ? `｜特性：${traits}` : ''}｜${partnerPost(p, state)}`);
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
        // 畜牧：有动物的设施数/设施总数（编制占用为驻场伙伴数）
        const facilities = state.livestock?.unlocked ? state.livestock.facilities : null;
        if (facilities?.length) {
            const used = facilities.filter(f => (f.animals || []).length > 0).length;
            const cap = Number(state.industry_rules?.livestock?.partner_capacity || 0);
            parts.push(`牧${used}/${facilities.length}${cap ? `(编${livestockAssignedPartnerIds(state).size}/${cap})` : ''}`);
        }
        return parts.join(' ');
    }

    // ---------- 串行调度与单标签页生命周期 ----------
    function scheduleTick(delay) {
        clearTimeout(timer);
        if (running) timer = setTimeout(tick, Math.max(delay, retryNotBefore - Date.now()));
    }

    async function tick() {
        if (!running || busy) return;
        if (Date.now() < retryNotBefore) { scheduleTick(0); return; }
        busy = true;
        let finishTick;
        tickSettled = new Promise(resolve => { finishTick = resolve; });
        let delay = CONFIG.pollInterval;
        try {
            if (runtime.state) refreshConfigRows(runtime.state);
            pendingStaminaCost = null; // 每轮重新统计体力缺口
            runtime.actionCount = 0;   // 单轮写操作计数归零
            runtime.soldUnits = 0;     // 单轮售卖计数归零
            validateClientEnvironment();
            ensureStoryIdle(); // 剧情与奖励回写完成前，连本轮 state 基线都不提前接受
            const state = await getState();
            if (!running) return;
            reconcileCraftFlights(state);
            await processCraftCancel();
            clearSkip('story:active');
            clearSkip('environment:paused');
            if (state.aquatic?.pending_big_catch) {
                const manualBigCatch = !CONFIG.aquatic.enabled || CONFIG.aquatic.bigCatch === 'manual';
                if (manualBigCatch && CONFIG.pauseOnPendingBigCatch) {
                    statusLine.textContent = '已暂停 · 请处理垂钓大物';
                    logSkip('aquatic:big-catch', '垂钓出现大物：已保留体力并暂停自动操作，请先挑战或放生');
                    refreshConfigRows(state);
                    delay = CONFIG.pollInterval;
                    return;
                }
                if (!manualBigCatch) await doBigCatch(state); // 自动搏一把/放线后继续本轮
            }
            if (!runtime.state?.aquatic?.pending_big_catch) clearSkip('aquatic:big-catch');
            if (CONFIG.rosterScanOnStart && !rosterScanned) {
                rosterScanned = true;
                scanRoster(state);
            }
            await useConfiguredActiveTaskItems();
            await collectReadyPlots();
            await collectReadyIndustries();
            await doAquaticFeed();
            await doSailing();
            // 先把本轮新产物收入背包，再提交/承接委托，避免平白多等一轮。
            await doCommissions();
            // 成就奖励是免费的枫火，收了产物后顺手领取
            await doAchievements();
            // 伙伴只能在生产前派驻/调整（开工后即锁定），所以先收取腾点位，再派伙伴，最后种植/开工
            await optimizePartnerAssignments();
            await plantEmptyPlots();
            await startEmptyIndustries();
            // 本轮刚开工的短任务可能已落入 active 道具窗口，立即补查，避免被最短轮询间隔跨过。
            const postStartActiveUses = await useConfiguredActiveTaskItems();
            if (postStartActiveUses > 0) {
                await collectReadyPlots();
                await collectReadyIndustries();
            }
            // 畜牧排在各产业之后、水产之前：照料只花剩余的体力，但仍优先于垂钓
            await doLivestock();
            // 水产排在各产业之后：伙伴先满足生产岗位，垂钓只花剩余的体力
            await doAquatic();
            if (!running) return;
            const st = runtime.state;
            const staminaText = st?.player ? `体力${Math.floor(liveStamina(st))}/${st.player.stamina_cap ?? '?'}` : '';
            statusLine.textContent = `运行中 ${new Date().toLocaleTimeString()} · ${staminaText} · 金币${playerCoins(st)} · 库存≈${inventoryTotalValue(st)} · ${summarize(st)}`;
            // 有实际操作时，触发游戏自带的 state 刷新，让页面 UI 立即同步（不刷新网页）
            if (dirty && await refreshGameUI()) dirty = false;
            // 自适应：对齐最近任务的完成时刻，无事可做时拉长间隔
            delay = postStartActiveUses > 0 ? CONFIG.pollInterval : nextDelay(runtime.state);
        } catch (e) {
            if (e.code === 'aborted') return; // 用户停止，不记为失败
            if (e.code === 'story_active') { // 剧情播放/奖励同步中：按提示时间等待，不算失败
                delay = Math.max(1000, Number(e.retryAfter || 1000));
                logSkip('story:active', '剧情播放或奖励同步中，写操作暂停');
                return;
            }
            if ([401, 403].includes(Number(e.status || 0)) || /401|403|登录/.test(e.message)) {
                log('未登录或会话失效，请先登录水鱼账号');
                stop();
                return;
            }
            if (e.code === 'unknown_build' || e.code === 'invalid_story_bridge') {
                statusLine.textContent = '安全暂停 · 游戏已更新，请刷新页面';
                delay = CONFIG.maxPollInterval;
                logSkip('environment:paused', e.message);
                return;
            }
            if (e.status === 429 || e.retryAfter != null) {
                delay = Math.max(CONFIG.pollInterval, Number(e.retryAfter || 60000));
            } else if (e.status === 408 || e.status >= 500 ||
                       ['network_error', 'request_timeout'].includes(e.code)) {
                delay = Math.max(CONFIG.pollInterval, 60000);
            }
            if (e.status === 429 || e.retryAfter != null || e.status === 408 || e.status >= 500 || ['network_error', 'request_timeout'].includes(e.code)) retryNotBefore = Date.now() + delay;
            log(`本轮已中止：${e.message}`);
        } finally {
            busy = false;
            // 先释放已停止一轮的控制器/锁，再允许等待中的新启动继续。
            if (!running) releaseStoppedRun();
            finishTick();
            updateRunControls();
            if (runtime.state) refreshConfigRows(runtime.state);
            if (wakeRequested) { // 面板操作请求了即时唤醒：本轮结束后立刻再跑一轮
                wakeRequested = false;
                delay = Math.min(delay, 300);
            }
            scheduleTick(delay);
        }
    }

    async function start() {
        if (running || starting) return;
        starting = true;
        const attempt = ++lifecycleRevision;
        updateRunControls();
        try {
            await tickSettled;
            if (attempt !== lifecycleRevision) return;
            if (CONFIG.singleTab) {
                if (!navigator.locks) {
                    statusLine.textContent = '未启动 · 缺少单标签锁';
                    log('当前环境不支持 Web Locks；singleTab 已启用，本页拒绝启动');
                    return;
                }
                const acquired = await new Promise(resolve => {
                    try {
                        navigator.locks.request(TAB_LOCK_NAME, { ifAvailable: true }, lock => {
                            if (attempt !== lifecycleRevision) { resolve(false); return undefined; }
                            resolve(!!lock);
                            if (!lock) return undefined;
                            return new Promise(r => { releaseTabLock = r; }); // 持锁直到 stop()
                        }).catch(() => resolve(null));
                    } catch (_) {
                        resolve(null);
                    }
                });
                if (attempt !== lifecycleRevision) return;
                if (acquired === false) {
                    statusLine.textContent = '已在其他标签页运行';
                    log('另一个标签页已在运行自动助手，本页不启动');
                    return;
                }
                if (acquired === null) {
                    statusLine.textContent = '未启动 · 单标签锁失败';
                    log('Web Locks 请求失败；singleTab 已启用，本页拒绝启动');
                    return;
                }
            }
            running = true;
            runtime.controller = new AbortController();
            runtime.actionCount = 0;
            runtime.soldUnits = 0;
            log('自动助手已启动');
            scheduleTick(0);
        } finally {
            if (attempt === lifecycleRevision) starting = false;
            updateRunControls();
            if (runtime.state) refreshConfigRows(runtime.state);
        }
    }

    function releaseStoppedRun() {
        runtime.controller = null;
        if (releaseTabLock) { releaseTabLock(); releaseTabLock = null; }
    }

    function updateRunControls() {
        toggleBtn.textContent = starting ? '取消启动' : running ? '停止' : '启动';
        toggleBtn.setAttribute('aria-pressed', String(running || starting));
    }

    function stop() {
        lifecycleRevision++;
        running = false;
        starting = false;
        wakeRequested = false;
        clearTimeout(timer);
        runtime.controller?.abort(new DOMException('已停止', 'AbortError'));
        if (!busy) releaseStoppedRun();
        updateRunControls();
        statusLine.textContent = '已停止';
        log('自动助手已停止');
        if (runtime.state) refreshConfigRows(runtime.state);
    }

    toggleBtn.textContent = '启动';
    statusLine.textContent = '待启动';
    toggleBtn.onclick = () => (running || starting ? stop() : start());

    let resumeAfterPageShow = false;
    window.addEventListener('pagehide', () => {
        resumeAfterPageShow = running || starting;
        clearInterval(dashboardTimer); dashboardTimer = null;
        finishPanelDrag?.();
        if (resumeAfterPageShow) stop();
    });
    window.addEventListener('pageshow', () => {
        startDashboardTimer();
        if (resumeAfterPageShow) { resumeAfterPageShow = false; start(); }
    });
    window.addEventListener('resize', () => {
        if (!panel.style.top) return;
        const rect = panel.getBoundingClientRect(); clampPanelPosition(rect.left, rect.top);
    });
    window.addEventListener('storage', event => {
        if (event.storageArea !== localStorage || (event.key && (!event.key.startsWith('rlt-') || /^rlt-(ui-|helper-|group-)/.test(event.key)))) return;
        settingsRevision++;
        refreshConfigRows(currentViewState());
        wakeSoon();
    });

    // 默认自动启动
    initializeDashboard();
    refreshConfigRows(getPageStore('game')?.state || { inventory: [] });
    if (CONFIG.ui.autoStart) start();
})();
