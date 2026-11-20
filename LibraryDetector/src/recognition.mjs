/** Catalogue-free OCR parsing and pairwise order evidence. */
export const MIN_CONFIDENCE = 55;

// NFC keeps Korean title-initial consonants (e.g. ㅍ) intact; NFKC would turn
// them into isolated jamo. Fold full-width ASCII separately for camera text.
const normalizePresentation = value => String(value).normalize('NFC').replace(/[！-～]/gu, char => String.fromCharCode(char.charCodeAt(0)-0xfee0));
const compact = value => normalizePresentation(value).replace(/\s+/gu, '');

/**
 * Extract one unambiguous call number. This parser handles the project's
 * visible label format: three-digit classification (optional decimal), a
 * Korean or Latin author prefix, numeric author code, optional title letters,
 * and optional v.N. It does not guess misread characters or missing digits.
 * A label without a volume suffix has volume:null; this means "not observed",
 * not proof that the physical book has no volume. Without a catalogue or a
 * visible marker we cannot distinguish a volume-less work from OCR omitting
 * the entire v.N line. A visibly truncated v. suffix is unreadable.
 */
export function parseCallNumber(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = normalizePresentation(text);
  const pattern = /(?<![\d.])(?<classification>\d\s*\d\s*\d(?:\s*\.\s*\d(?:\s*\d)*)?)\s*(?<mark>(?:[가-힣]+|[A-Za-z]+)\s*\d(?:[ \t]*\d)*(?:[가-힣ㄱ-ㅎA-Za-z])?)(?![\d가-힣ㄱ-ㅎA-Za-z])(?:\s+[vV]\s*\.?\s*(?<volume>\d+))?/gu;
  const matches = [...normalized.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const match = matches[0], suffix = normalized.slice(match.index + match[0].length);
  if (match.groups.volume === undefined && /^\s*[vV](?:\s*\.|\s|$)/u.test(suffix)) return null;
  // A v. digit followed by more digits separated by whitespace may be an OCR
  // split volume (v.1 0). Reject it rather than reading volume 1 as volume 10.
  if (match.groups.volume !== undefined && /^[ \t]*\d/u.test(suffix)) return null;
  return {
    classification: compact(match.groups.classification),
    bookMark: compact(match.groups.mark),
    volume: match.groups.volume ?? null,
  };
}

function compareDigitStrings(a, b) {
  const left = String(a).replace(/^0+(?=\d)/u, '');
  const right = String(b).replace(/^0+(?=\d)/u, '');
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

function compareDecimalStrings(a, b) {
  const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.');
  const integer = compareDigitStrings(ai, bi);
  if (integer) return integer;
  const length = Math.max(af.length, bf.length);
  const left = af.padEnd(length, '0'), right = bf.padEnd(length, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}

const collator = new Intl.Collator('ko', {usage:'sort', sensitivity:'variant'});

/**
 * Explicit prototype convention, not an assertion about every library:
 * classification numerically; Korean author prefixes before Latin; author
 * digits as a fractional sequence (12 before 2); title letters alphabetically;
 * explicit volumes numerically, with absent volume before present volume.
 * An institution with another author-number table must replace this policy.
 */
export function compareCallNumbers(a, b) {
  if (!a || !b) throw new TypeError('비교할 두 청구기호가 필요합니다.');
  const classification = compareDecimalStrings(a.classification, b.classification);
  if (classification) return classification;
  const splitMark = mark => /^([가-힣A-Za-z]+)(\d+)([가-힣ㄱ-ㅎA-Za-z]?)$/u.exec(mark);
  const left = splitMark(a.bookMark), right = splitMark(b.bookMark);
  if (!left || !right) throw new TypeError('지원하지 않는 도서기호 형식입니다.');
  const language = prefix => /^[가-힣]/u.test(prefix) ? 0 : 1;
  const prefix = language(left[1]) - language(right[1]) || collator.compare(left[1], right[1]);
  if (prefix) return prefix;
  const digits = compareDecimalStrings(`0.${left[2]}`, `0.${right[2]}`);
  if (digits) return digits;
  const suffix = collator.compare(left[3], right[3]);
  if (suffix) return suffix;
  if (a.volume === null || b.volume === null) return a.volume === b.volume ? 0 : a.volume === null ? -1 : 1;
  return compareDigitStrings(a.volume, b.volume);
}

/** Keep all explicit camera-grid positions, including unreadable positions. */
export function buildObservations(slots) {
  if (!Array.isArray(slots)) throw new TypeError('인식 영역 목록이 필요합니다.');
  const duplicateIndexes = new Set(slots.filter((slot, i) => slots.findIndex(other => other.index === slot.index) !== i).map(slot => slot.index));
  return slots.map(slot => {
    if (!Number.isInteger(slot.index) || slot.index < 0 || slot.index >= 100 || duplicateIndexes.has(slot.index)) {
      return {...slot, callNumber:null, reason:'책 위치 번호가 올바르지 않습니다.'};
    }
    if (!Number.isFinite(slot.confidence) || slot.confidence < MIN_CONFIDENCE) {
      return {...slot, callNumber:null, reason:'문자 인식 신뢰도가 낮아 판정을 보류합니다.'};
    }
    const callNumber = parseCallNumber(slot.text);
    return {...slot, callNumber, reason:callNumber ? (callNumber.volume === null ? '청구기호를 읽었습니다. 권차는 관측되지 않아 누락 여부를 알 수 없습니다.' : '청구기호를 읽었습니다.') : '청구기호를 명확히 읽지 못했습니다.'};
  });
}

/**
 * Return order conflicts, never an individual-book wrong/correct verdict.
 * An inversion proves that a pair is out of order but cannot identify which
 * book was moved. Consecutive readable positions may span unreadable slots.
 */
export function findOrderConflicts(observations) {
  if (!Array.isArray(observations)) throw new TypeError('관측 목록이 필요합니다.');
  const readable = observations.filter(item => item.callNumber && Number.isFinite(item.confidence) && item.confidence >= MIN_CONFIDENCE).slice().sort((a,b) => a.index-b.index);
  const conflicts = [];
  for (let i=1; i<readable.length; i++) {
    const left = readable[i-1], right = readable[i];
    if (compareCallNumbers(left.callNumber,right.callNumber) > 0) {
      conflicts.push({leftIndex:left.index,rightIndex:right.index,reason:`${left.index+1}번째 청구기호가 ${right.index+1}번째보다 뒤에 와야 합니다. 어느 책을 옮겼는지는 이 비교만으로 확정할 수 없습니다.`});
    }
  }
  return conflicts;
}

/** Twenty screen-card rectangles, row-major to match the responsive inspector. */
export function makeGrid(roi, columns, rows) {
  if (!roi || !['x','y','width','height'].every(key => Number.isFinite(roi[key])) || roi.width<=0 || roi.height<=0 || roi.x<0 || roi.y<0) throw new RangeError('촬영 영역은 양수 크기의 사각형이어야 합니다.');
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns<=0 || rows<=0 || columns*rows!==20) throw new RangeError('격자는 20개의 책 영역으로 구성해야 합니다.');
  return Array.from({length:20},(_,index)=>({index,bbox:{x:roi.x+(index%columns)*roi.width/columns,y:roi.y+Math.floor(index/columns)*roi.height/rows,width:roi.width/columns,height:roi.height/rows}}));
}
