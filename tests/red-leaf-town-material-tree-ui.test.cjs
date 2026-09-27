const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', '红叶镇物语自动助手.user.js'), 'utf8');
const start = source.indexOf('    const craftMaterialExpansion = new Map();');
const end = source.indexOf('    function makeCraftQueueCard(', start);
assert.ok(start > 0 && end > start, 'material renderer boundary exists');

function element(tag, className = '', text = '') {
    return { tagName: tag.toUpperCase(), className, textContent: String(text), children: [], style: {}, dataset: {},
        appendChild(child) { this.children.push(child); return child; },
        append(...children) { this.children.push(...children); },
    };
}
function view(tree) {
    let calls = 0;
    const context = { uiElement: element, craftMaterialTree(state) { calls++; return typeof tree === 'function' ? tree(state) : tree; } };
    vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.make = makeCraftMaterialTree;`, context);
    return { make: context.make, get calls() { return calls; } };
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function text(node) { return [node.textContent, ...node.children.map(text)].join(' '); }
function toggle(node, open) { node.open = open; node.ontoggle(); }
function branch(root, name) {
    return descendants(root).find(node => node.tagName === 'DETAILS' && node.className !== 'rlt-material-tree' &&
        descendants(node.children[0]).some(child => child.className === 'rlt-material-name' && child.textContent === name));
}
function fixture() {
    return { title: '营养饲料', quantity: 2, phase: 'planning', status: 'crafting', statusLabel: '先加工谷物饲料', preview: false,
        note: '整条路线重复说明不应再次显示',
        root: { key: 'nutrition', kind: 'recipe', name: '营养饲料', required: 2, outputPerCraft: 3, outputQuantity: 6, stamina: 8, status: 'crafting', statusLabel: '等待材料', children: [
            { key: 'nutrition/grain', kind: 'material', name: '谷物饲料', required: 8, available: 2, pending: 1, planned: 2, missing: 3,
                stock: 9, protected: 4, otherAllocated: 3, protections: [{ name: '每日委托', quantity: 4, minQuality: 2 }],
                status: 'crafting', statusLabel: '需要加工', children: [
                    { key: 'nutrition/grain/recipe', kind: 'recipe', name: '谷物饲料配方', required: 3, status: 'ready', statusLabel: '可以开工', note: '谷仓加工台', children: [
                        { key: 'nutrition/grain/recipe/wheat', kind: 'material', name: '小麦', required: 6, available: 6, pending: 0, planned: 0, missing: 0,
                            stock: 10, protected: 0, otherAllocated: 0, status: 'ready', statusLabel: '已经备齐', children: [] },
                    ] },
                ] },
        ] },
    };
}

test('the entire tree starts closed and does not calculate a plan before opening', () => {
    const x = view(fixture()), section = x.make({}, { station_id: 'mill' });
    assert.equal(section.open, false); assert.equal(x.calls, 0);
    assert.equal(section.children[1].children.length, 0);
    toggle(section, true); assert.equal(x.calls, 1);
    toggle(section, false); toggle(section, true); assert.equal(x.calls, 1);
});

test('tree rows display provided quantities without recalculating supplies or shortages', () => {
    const x = view(fixture()), section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    const content = text(section);
    for (const expected of ['加工 2 次', '产出至少 6 件', '体力 8', '需要 8 件', '待补 3 件', '背包总量 9', '为其他用途保留 4', '其他加工用料 3', '每日委托：4（品质 ≥ 2）']) {
        assert.ok(content.includes(expected), expected);
    }
    assert.ok(content.includes('可用 6 件'));
    for (const omitted of ['先加工谷物饲料', '整条路线重复说明', '谷仓加工台', '每次至少产出 3', '待补 0', '已经备齐', '可以开工']) {
        assert.ok(!content.includes(omitted), omitted + ' is redundant in the expanded tree');
    }
    assert.equal(descendants(section).find(node => node.textContent === '产出至少 6 件').title, '每次至少产出 3 件');
});

test('first two branch levels start expanded and deeper branches start closed', () => {
    const x = view(fixture()), section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    assert.equal(branch(section, '营养饲料').open, true);
    assert.equal(branch(section, '谷物饲料').open, true);
    assert.equal(branch(section, '谷物饲料配方').open, false);
    assert.equal(branch(section, '小麦').open, false);
});

test('section and individual branch choices survive state refreshes independently for each station', () => {
    const x = view(fixture()), station = { station_id: 'mill' }, first = x.make({ revision: 1 }, station);
    toggle(first, true); toggle(branch(first, '谷物饲料'), false); toggle(branch(first, '谷物饲料配方'), true);
    const fresh = x.make({ revision: 2 }, station);
    assert.equal(fresh.open, true); assert.equal(x.calls, 2);
    assert.equal(branch(fresh, '谷物饲料').open, false); assert.equal(branch(fresh, '谷物饲料配方').open, true);
    const other = x.make({}, { station_id: 'kitchen' }); assert.equal(other.open, false); assert.equal(x.calls, 2);
    toggle(fresh, false); const closed = x.make({ revision: 3 }, station); assert.equal(closed.open, false); assert.equal(x.calls, 2);
});

test('missing root displays explanatory state instead of an empty tree', () => {
    const x = view({ phase: 'planning', statusLabel: '加工已暂停', note: '选择配方后可以查看材料。', root: null, preview: true });
    const section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    assert.ok(text(section).includes('加工已暂停'));
    assert.ok(!text(section).includes('选择配方后可以查看材料。'));
    assert.ok(!text(section).includes('当前用料预览'));
});

test('inventory details stay closed independently of an expanded material branch and remember their choice', () => {
    const x = view(fixture()), station = { station_id: 'mill' }, section = x.make({}, station); toggle(section, true);
    const grain = branch(section, '谷物饲料');
    const stock = grain.children.find(node => node.className === 'rlt-material-stock');
    assert.equal(grain.open, true); assert.equal(stock.open, false);
    assert.equal(stock.children[0].textContent, '库存明细');
    stock.children[0].onclick();
    const refreshed = x.make({ revision: 2 }, station);
    const freshGrain = branch(refreshed, '谷物饲料');
    assert.equal(freshGrain.children.find(node => node.className === 'rlt-material-stock').open, true);
    assert.equal(branch(refreshed, '小麦').children.find(node => node.className === 'rlt-material-stock').open, false);
});

test('zero inventory allocations are omitted and a supplied material shows only its nonzero sources', () => {
    const tree = fixture(), material = tree.root.children[0];
    Object.assign(material, { required: 5, available: 2, pending: 1, planned: 2, missing: 0, protected: 0, otherAllocated: 0, protections: [] });
    const x = view(tree), section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    const content = text(branch(section, '谷物饲料'));
    for (const expected of ['需要 5 件', '可用 2 件', '待领取 1 件', '待加工 2 件']) assert.ok(content.includes(expected), expected);
    for (const omitted of ['待补 0', '为其他用途保留 0', '其他加工用料 0']) assert.ok(!content.includes(omitted), omitted);
});

test('a blocked route keeps its actionable reason while ordinary station descriptions are hidden', () => {
    const tree = fixture(), blocked = tree.root.children[0].children[0];
    Object.assign(blocked, { status: 'blocked', statusLabel: '材料受阻', note: '缺少小麦，请先补充基础材料' });
    const x = view(tree), section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    assert.ok(text(section).includes('缺少小麦，请先补充基础材料'));
    assert.ok(text(section).includes('材料受阻'));
});

test('a submitted queue displays pending executions without a zero-work recipe or zero stamina', () => {
    const x = view({ phase: 'committed', statusLabel: '重复的已提交说明', note: '重复的体力说明',
        root: { key: 'queue', kind: 'queue', name: '营养饲料', required: 3, status: 'waiting', statusLabel: '已提交，等待领取', children: [] } });
    const section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    assert.ok(text(section).includes('待领取 3 次'));
    for (const omitted of ['加工 0 次', '体力 0', '重复的已提交说明', '重复的体力说明']) assert.ok(!text(section).includes(omitted), omitted);
});

test('a refresh between clicking a summary and its deferred toggle event preserves the choice', () => {
    const x = view(fixture()), station = { station_id: 'mill' }, first = x.make({}, station);
    first.children[0].onclick();
    const opened = x.make({}, station); assert.equal(opened.open, true);
    branch(opened, '谷物饲料').children[0].onclick();
    const refreshed = x.make({}, station); assert.equal(branch(refreshed, '谷物饲料').open, false);
});

test('deep recipe chains cap indentation and keep names as plain text', () => {
    const tree = fixture(); let next = tree.root;
    for (let level = 0; level < 12; level++) {
        next.children = [{ kind: 'recipe', key: `deep-${level}`, name: level ? `长名称配方-${level}` : '<img src=x onerror=alert(1)>', required: 1,
            status: 'waiting', statusLabel: '等待加工', children: [] }]; next = next.children[0];
    }
    const x = view(tree), section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    const rows = descendants(section).filter(node => node.className === 'rlt-material-row');
    assert.ok(rows.length > 10); assert.ok(rows.every(row => parseFloat(row.style.marginInlineStart) <= 32));
    assert.ok(text(section).includes('<img src=x onerror=alert(1)>'));
    assert.equal(descendants(section).some(node => node.tagName === 'IMG'), false);
});
