'use strict';

const $ = id => document.getElementById(id);
let dataset, catalog = [], order = [], phase = 'mix', activeShelf = null;
let selected = null, flags = new Set(), swaps = 0;
const misplaced = () => order.filter((id, position) => id !== position);
const size = () => dataset.layout.booksPerShelf;
const locationText = index => `${Math.floor(index / size()) + 1}번 칸 ${index % size() + 1}번째`;

function validateDataset(data) {
  if (data.schemaVersion !== 1 || data.layout?.shelfCount !== 10 || data.layout?.booksPerShelf !== 20 ||
      data.layout?.columns !== 2 || data.layout?.rows !== 5 || data.layout?.bookCount !== 200 ||
      !Array.isArray(data.books) || data.books.length !== 200) throw Error('10칸 × 20권의 books.json 파일이 필요합니다.');
  const ids = new Set(), calls = new Set();
  data.books.forEach((b, i) => {
    if (['bookId','title','authors','primaryAuthor','publisher','classification','bookMark','callNumber','isbn'].some(k => typeof b[k] !== 'string' || !b[k]) ||
        !/^\d{3}(\.\d+)?$/.test(b.classification) ||
        (b.volume !== null && (typeof b.volume !== 'string' || !/^\d+$/.test(b.volume))) ||
        b.callNumber !== `${b.classification} ${b.bookMark}${b.volume === null ? '' : ` v.${b.volume}`}` ||
        b.sortOrder !== i + 1 || b.home?.shelf !== Math.floor(i / 20) + 1 || b.home?.position !== i % 20 + 1 ||
        ids.has(b.bookId) || calls.has(b.callNumber)) throw Error('도서 정보 또는 정렬 위치가 올바르지 않습니다.');
    if (i && compareBooks(data.books[i - 1], b) >= 0) throw Error('청구기호 정렬 순서가 올바르지 않습니다.');
    ids.add(b.bookId); calls.add(b.callNumber);
  });
  return data;
}
function compareBooks(a, b) {
  const language = mark => /^[가-힣]/.test(mark) ? 0 : 1;
  return Number(a.classification) - Number(b.classification) ||
    language(a.bookMark) - language(b.bookMark) ||
    a.bookMark.localeCompare(b.bookMark, 'ko') ||
    (a.volume === null ? -1 : Number(a.volume)) - (b.volume === null ? -1 : Number(b.volume));
}
function notice(text) { $('notice').textContent = text; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, primary = false) {
  const b = element('button', primary ? 'primary' : '', text); b.onclick = action; return b;
}
function exchange(a, b) { [order[a], order[b]] = [order[b], order[a]]; swaps++; }
function openShelf(shelf, focus = true) {
  activeShelf = shelf; renderShelves(); renderBooks();
  if (focus) {
    $('inspector').scrollIntoView({behavior: 'smooth', block: 'start'});
    $('shelf-title').focus({preventScroll: true});
  }
}
function render() {
  $('phase-label').textContent = phase === 'mix' ? '01 / MIX THE BOOKS' : phase === 'find' ? '02 / FIND THE MISPLACED BOOKS' : '03 / CASE CLOSED';
  $('phase-title').textContent = phase === 'mix' ? '순서를 바꾸는 사람' : phase === 'find' ? '잘못 꽂힌 책을 찾는 사람' : '조사 결과를 확인하세요';
  $('phase-help').textContent = phase === 'mix' ? `칸을 열고 두 권을 선택하면 자리가 바뀝니다. 현재 ${swaps}회 교환했습니다.` : phase === 'find' ? `의심되는 책 ${flags.size}권을 표시했습니다. 다시 누르면 표시가 해제됩니다.` : '각 칸을 열어 정답과 놓친 책을 확인할 수 있습니다.';
  const controls = $('controls'); controls.replaceChildren();
  if (phase === 'mix') {
    const label = element('label', '', '교환 쌍 '), input = element('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.value = '5';
    input.setAttribute('aria-label', '무작위 교환 쌍 수'); label.append(input); controls.append(label);
    controls.append(button('무작위 섞기', () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 1 || n > catalog.length / 2) { notice('교환 쌍 수는 1~100 사이의 정수로 입력하세요.'); return; }
      const positions = catalog.map((_, i) => i);
      for (let i = positions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [positions[i], positions[j]] = [positions[j], positions[i]];
      }
      for (let i = 0; i < n * 2; i += 2) exchange(positions[i], positions[i + 1]);
      selected = null; render(); notice(`${n}쌍을 교환했습니다. 현재 제자리를 벗어난 책은 ${misplaced().length}권입니다.`);
    }));
    controls.append(button('초기화', reset));
    const done = button('섞기 완료 →', () => {
      selected = null; activeShelf = null; phase = 'find'; render();
      notice('칸을 선택하고 청구기호를 비교하며 잘못 꽂힌 책을 찾아보세요.'); $('handoff').showModal();
    }, true);
    done.disabled = misplaced().length === 0; controls.append(done);
  } else if (phase === 'find') {
    controls.append(button('표시 지우기', () => { flags.clear(); render(); notice('모든 의심 표시를 지웠습니다.'); }));
    controls.append(button('채점하기 →', finish, true));
  } else controls.append(button('새 게임 시작', reset, true));
  renderShelves(); renderBooks();
}
function renderShelves() {
  const root = $('shelves'); root.replaceChildren();
  for (let col = 0; col < dataset.layout.columns; col++) {
    const column = element('div', 'column');
    for (let row = 0; row < dataset.layout.rows; row++) {
      const shelf = col * dataset.layout.rows + row;
      const b = element('button', 'shelf' + (activeShelf === shelf ? ' active' : ''));
      b.setAttribute('aria-label', `${shelf + 1}번 칸, 20권 확대 보기`); b.setAttribute('aria-pressed', String(activeShelf === shelf));
      const label = element('span', 'shelf-label');
      label.append(element('b', '', `${String(shelf + 1).padStart(2, '0')} →`), element('span', '', '20권 · 눌러서 확대'));
      const spines = element('div', 'spines');
      for (let i = shelf * size(); i < (shelf + 1) * size(); i++) {
        const book = catalog[order[i]], spine = element('span', 'spine');
        spine.style.height = (32 + order[i] % 14) + 'px'; spine.style.setProperty('--book-color', bookColor(book));
        if (phase === 'result' && order[i] !== i) spine.classList.add(flags.has(order[i]) ? 'correct' : 'wrong');
        else if (flags.has(order[i]) || selected === i) spine.classList.add('flag');
        spines.append(spine);
      }
      b.append(label, spines); b.onclick = () => openShelf(shelf); column.append(b);
    }
    root.append(column);
  }
}
function bookColor(book) {
  return ['#70888f','#908072','#8c86a2','#658477','#a28b64','#8c9874','#997f83','#7c92a1','#718697','#a48a6e'][Math.floor(Number(book.classification) / 100)];
}
function renderBooks() {
  $('inspector').hidden = activeShelf === null; $('shelf-empty').hidden = activeShelf !== null;
  const root = $('books'); root.replaceChildren(); if (activeShelf === null) return;
  $('shelf-title').textContent = `${String(activeShelf + 1).padStart(2, '0')}번 칸 · 20권`;
  $('prev-shelf').disabled = activeShelf === 0; $('next-shelf').disabled = activeShelf === dataset.layout.shelfCount - 1;
  for (let pos = activeShelf * size(); pos < (activeShelf + 1) * size(); pos++) {
    const id = order[pos], book = catalog[id], wrong = id !== pos, b = element('button', 'book');
    b.style.setProperty('--book-color', bookColor(book));
    if (selected === pos || flags.has(id)) b.classList.add('selected');
    if (phase === 'result' && wrong) b.classList.add(flags.has(id) ? 'found' : 'missed');
    const label = book.title + (book.volume !== null ? ` · ${book.volume}권` : '');
    b.append(element('span', 'position', `${String(pos % size() + 1).padStart(2, '0')}번째`), element('span', 'title', label),
      element('span', 'author', book.primaryAuthor), element('span', 'publisher', book.publisher));
    const call = element('span', 'call');
    call.append(element('span', '', book.classification), element('span', '', book.bookMark));
    if (book.volume !== null) call.append(element('span', '', `v.${book.volume}`)); b.append(call);
    b.title = `${label}\n${book.authors}\n${book.publisher} · ${book.publicationYear}\nISBN ${book.isbn}\n청구기호 ${book.callNumber}`;
    b.setAttribute('aria-label', `${pos % size() + 1}번째 책, ${label}, 청구기호 ${book.callNumber}`);
    b.setAttribute('aria-pressed', String(selected === pos || flags.has(id)));
    if (phase === 'result') {
      b.append(element('em', '', wrong ? (flags.has(id) ? '✓ 발견' : '! 놓친 책') : flags.has(id) ? '× 정상 도서' : '정상 위치'));
      b.onclick = () => notice(`「${label}」의 원래 위치: ${locationText(id)}`);
    } else b.onclick = () => {
      if (phase === 'mix') {
        if (selected === null) { selected = pos; notice(`「${label}」 선택. 교환할 다른 책을 선택하세요. 다른 칸으로 이동해도 선택은 유지됩니다.`); }
        else if (selected === pos) { selected = null; notice('선택을 취소했습니다.'); }
        else { exchange(selected, pos); selected = null; notice('두 책의 위치를 교환했습니다.'); }
      } else {
        if (flags.has(id)) flags.delete(id); else flags.add(id); notice(`${flags.size}권을 의심 도서로 표시했습니다.`);
      }
      render();
    };
    root.append(b);
  }
}
function finish() {
  phase = 'result'; render();
  const wrong = misplaced(), hits = wrong.filter(id => flags.has(id)).length;
  const root = $('results'); root.hidden = false; root.replaceChildren();
  root.append(element('h2', '', hits === wrong.length && flags.size === hits ? '완벽한 조사입니다!' : '조사가 끝났습니다.'));
  root.append(element('p', '', `정확히 찾은 책 ${hits}권 / 잘못 꽂힌 책 ${wrong.length}권 · 놓친 책 ${wrong.length - hits}권 · 잘못 표시한 정상 도서 ${flags.size - hits}권`));
  const list = element('ul');
  for (const id of wrong) list.append(element('li', '', `${flags.has(id) ? '✓ 발견' : '! 놓침'} · ${catalog[id].title} [${catalog[id].callNumber}] · 현재 ${locationText(order.indexOf(id))} → 원래 ${locationText(id)}`));
  root.append(list); notice('초록색은 찾은 책, 붉은색은 놓친 책입니다. 책을 누르면 원래 위치를 확인합니다.');
  root.scrollIntoView({behavior: 'smooth', block: 'nearest'});
}
function reset() {
  order = catalog.map((_, i) => i); phase = 'mix'; activeShelf = null;
  selected = null; flags.clear(); swaps = 0; $('results').hidden = true;
  render(); notice('200권을 청구기호순으로 정리했습니다. 칸을 선택해 시작하세요.');
}
function loadDataset(data) {
  dataset = validateDataset(data); catalog = dataset.books;
  $('data-loader').hidden = true; $('game').hidden = false; reset();
}
async function initialize() {
  $('start-find').onclick = () => { $('handoff').close(); $('shelves').scrollIntoView({block: 'start'}); };
  $('handoff').addEventListener('cancel', event => event.preventDefault());
  $('prev-shelf').onclick = () => openShelf(activeShelf - 1, false);
  $('next-shelf').onclick = () => openShelf(activeShelf + 1, false);
  $('close-inspector').onclick = () => { activeShelf = null; renderShelves(); renderBooks(); $('shelves').scrollIntoView({behavior: 'smooth'}); };
  $('catalog-file').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try { loadDataset(JSON.parse(await file.text())); }
    catch (error) { $('load-message').textContent = `불러오지 못했습니다: ${error.message}`; }
    event.target.value = '';
  };
  if (location.protocol === 'file:') {
    $('load-message').textContent = '게임 폴더의 books.json을 선택하세요. 선택한 200권으로 바로 시작합니다.'; return;
  }
  try {
    const response = await fetch('./books.json');
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    loadDataset(await response.json());
  } catch (error) {
    $('load-message').textContent = `도서 목록을 자동으로 불러오지 못했습니다 (${error.message}). books.json을 직접 선택해주세요.`;
  }
}
if (typeof document !== 'undefined') initialize();
if (typeof module !== 'undefined') module.exports = {validateDataset, compareBooks};
