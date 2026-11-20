'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const data = require('../books.json');
const {validateDataset, compareBooks} = require('../app.js');
validateDataset(data);
assert(compareBooks({classification:'813.7',bookMark:'한001',volume:'2'}, {classification:'813.7',bookMark:'한001',volume:'10'}) < 0);
assert(compareBooks({classification:'813.7',bookMark:'한001',volume:null}, {classification:'813.7',bookMark:'A001',volume:null}) < 0);
assert(compareBooks({classification:'813.62',bookMark:'한001',volume:null}, {classification:'813.7',bookMark:'한001',volume:null}) < 0);
const invalid = structuredClone(data); invalid.books[0].home.position = 2;
assert.throws(() => validateDataset(invalid));
const reversed = structuredClone(data); reversed.books[1].classification = '100'; reversed.books[1].callNumber = `100 ${reversed.books[1].bookMark}`;
assert.throws(() => validateDataset(reversed));

// Minimal DOM adapter exercises event handlers; this is not a browser layout test.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {setProperty(){}}; this.classList = {add(){}}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute() {} addEventListener() {} scrollIntoView() {} focus() {}
  showModal() { this.open = true; } close() { this.open = false; }
}
const nodes = {}, context = {
  document: {getElementById: id => nodes[id] ??= new Element(), createElement: tag => new Element(tag)},
  location: {protocol: 'file:'}, console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
const run = code => vm.runInContext(code, context);
(async () => {
  await nodes['catalog-file'].onchange({target: {files: [{text: async () => JSON.stringify(data)}]}});
  assert.equal(nodes.game.hidden, false);
  assert.equal(nodes.shelves.children.length, 2);
  assert(nodes.shelves.children.every(column => column.children.length === 5));
  assert.equal(nodes.inspector.hidden, true);
  for (let shelf = 0; shelf < 10; shelf++) {
    run(`openShelf(${shelf})`);
    assert.equal(nodes.books.children.length, 20);
    assert.equal(nodes.books.children[0].children[1].textContent.startsWith(data.books[shelf * 20].title), true);
  }
  assert.equal(nodes['next-shelf'].disabled, true);
  run('openShelf(0)'); assert.equal(nodes['prev-shelf'].disabled, true);
  nodes.books.children[0].onclick(); run('openShelf(9)'); nodes.books.children[19].onclick();
  assert.equal(run('order[0]'), 199); assert.equal(run('order[199]'), 0);
  assert.equal(run('misplaced().length'), 2);
  nodes.controls.children[3].onclick(); assert.equal(nodes.handoff.open, true);
  assert.equal(nodes.inspector.hidden, true); assert.equal(run('phase'), 'find');
  nodes['start-find'].onclick(); assert.equal(nodes.handoff.open, false);
  run('openShelf(0)'); nodes.books.children[0].onclick(); nodes.books.children[1].onclick();
  nodes.controls.children[1].onclick();
  assert.deepEqual(nodes.results.children[1].textContent.match(/\d+/g), ['1','2','1','1']);
  run('reset()'); assert.equal(run('misplaced().length'), 0); assert.equal(run('flags.size'), 0);
  nodes.controls.children[0].children[0].value = '100'; nodes.controls.children[1].onclick();
  assert.equal(run('misplaced().length'), 200);
  run('reset()'); nodes.controls.children[0].children[0].value = '101'; nodes.controls.children[1].onclick();
  assert.equal(run('misplaced().length'), 0);
  run('openShelf(4)'); nodes['close-inspector'].onclick(); assert.equal(nodes.inspector.hidden, true);
  console.log('PASS: JSON import; all 10 enlarged compartments; cross-shelf swaps; handoff; scoring; 100-pair shuffle; invalid input; reset');
})().catch(error => { console.error(error); process.exitCode = 1; });
