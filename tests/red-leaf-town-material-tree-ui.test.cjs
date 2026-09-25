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
    return { title: '营养饲料', quantity: 2, status: 'crafting', statusLabel: '先加工谷物饲料', preview: false,
        root: { key: 'nutrition', kind: 'recipe', name: '营养饲料', required: 2, status: 'crafting', statusLabel: '等待材料', children: [
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
    for (const expected of ['先加工谷物饲料', '加工份数 2', '需 8', '库存供给 2', '在途 1', '计划供给 2', '待补 3', '背包总量 9', '受保护 4', '其他分支已分配 3', '每日委托：4（品质 ≥ 2）', '谷仓加工台']) {
        assert.ok(content.includes(expected), expected);
    }
    assert.ok(content.includes('库存供给 6')); assert.ok(content.includes('待补 0'));
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
    const x = view({ statusLabel: '加工已暂停', note: '选择配方后可以查看材料。', root: null, preview: true });
    const section = x.make({}, { station_id: 'mill' }); toggle(section, true);
    assert.ok(text(section).includes('加工已暂停')); assert.ok(text(section).includes('选择配方后可以查看材料。'));
    assert.ok(text(section).includes('当前用料预览'));
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
