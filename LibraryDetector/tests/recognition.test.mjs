import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCallNumber,compareCallNumbers,buildObservations,findOrderConflicts,makeGrid} from '../src/recognition.mjs';

const call = text => parseCallNumber(text);
const slot = (text,index,confidence=90) => ({index,text,confidence,bbox:{x:index*40,y:0,width:40,height:180}});

test('parses explicit Korean and English call numbers without a catalogue',()=>{
  assert.deepEqual(call('813.62 한001'),{classification:'813.62',bookMark:'한001',volume:null});
  assert.deepEqual(call('335.7 Y12a'),{classification:'335.7',bookMark:'Y12a',volume:null});
  assert.deepEqual(call('811.6 조54ㅍ'),{classification:'811.6',bookMark:'조54ㅍ',volume:null});
});
test('tolerates whitespace and Unicode presentation without character guessing',()=>{
  assert.deepEqual(call('８１３ . ７\n한 0 0 1\nv . 2'),{classification:'813.7',bookMark:'한001',volume:'2'});
  assert.equal(call('813.7 한OO1'),null);
  assert.equal(call('책 제목만 읽힘'),null);
});
test('volume zero is retained; visibly truncated volumes and multiple labels are unreadable',()=>{
  assert.deepEqual(call('400 흔001 v.0'),{classification:'400',bookMark:'흔001',volume:'0'});
  assert.equal(call('400 흔001 v.'),null);
  assert.equal(call('400 흔001 v.1 0'),null);
  assert.equal(call('400 흔001\n813.7 한001'),null);
});
test('a full card with multiline title, author and publisher still extracts the v.0 label',()=>{
  const text='03번째\n어린이 과학 탐험대\n신기한 세계의 시작\n홍길동\n꿈꾸는출판사\n400\n흔001\nv.0';
  assert.deepEqual(call(text),{classification:'400',bookMark:'흔001',volume:'0'});
});
test('a completely omitted v.N line cannot be recovered without a catalogue',()=>{
  const complete=call('어린이 과학 탐험대\n400\n흔001\nv.0');
  const missing=call('어린이 과학 탐험대\n400\n흔001');
  assert.equal(complete.volume,'0');
  assert.equal(missing.volume,null); // not observed, not evidence of no volume
  const observation=buildObservations([slot('400\n흔001',0)])[0];
  assert.equal(observation.callNumber.volume,null);
  assert.match(observation.reason,/권차.*관측되지/);
  assert(!('status' in observation));
});
test('classification is decimal, Korean precedes Latin, author digits use declared fractional convention',()=>{
  assert(compareCallNumbers(call('813.62 한001'),call('813.7 한001'))<0);
  assert(compareCallNumbers(call('335.7 한17'),call('335.7 Y12a'))<0);
  assert(compareCallNumbers(call('335.7 Y12a'),call('335.7 Y2a'))<0);
  assert(compareCallNumbers(call('335.7 가12'),call('335.7 나12'))<0);
  assert.equal(compareCallNumbers(call('400 흔12'),call('400 흔120')),0);
});
test('volumes compare numerically and absent volume sorts before explicit zero',()=>{
  assert(compareCallNumbers(call('400 흔001 v.2'),call('400 흔001 v.10'))<0);
  assert(compareCallNumbers(call('400 흔001'),call('400 흔001 v.0'))<0);
});
test('low confidence and missing OCR remain unknown in their original slots',()=>{
  const observations=buildObservations([slot('400 흔001',0),slot('?',1),slot('500 김001',2,54)]);
  assert.deepEqual(observations.map(o=>o.index),[0,1,2]);
  assert(observations[0].callNumber);
  assert.equal(observations[1].callNumber,null);
  assert.equal(observations[2].callNumber,null);
  assert(observations.every(o=>!('status' in o)&&!('book' in o)));
});
test('inversions report a pair, not which individual book is misplaced',()=>{
  const observations=buildObservations([slot('500 김001',0),slot('400 흔001',1),slot('600 이001',2)]);
  const conflicts=findOrderConflicts(observations);
  assert.equal(conflicts.length,1);
  assert.equal(conflicts[0].leftIndex,0);assert.equal(conflicts[0].rightIndex,1);
  assert(!('wrongIndex' in conflicts[0]));
});
test('a conflict can span unreadable positions while preserving physical indices',()=>{
  const observations=buildObservations([slot('500 김001',0),slot('?',1),slot('400 흔001',2)]);
  const conflicts=findOrderConflicts(observations);
  assert.equal(conflicts.length,1);assert.equal(conflicts[0].leftIndex,0);assert.equal(conflicts[0].rightIndex,2);
  assert.equal(findOrderConflicts(buildObservations([slot('400 흔001',0),slot('500 김001',1)])).length,0);
});
test('duplicate or invalid grid positions are not used as evidence',()=>{
  assert(buildObservations([slot('400 흔001',0),slot('500 김001',0)]).every(o=>o.callNumber===null));
  assert.equal(buildObservations([slot('400 흔001',100)])[0].callNumber,null);
});
test('grid contains twenty row-major rectangles',()=>{
  const grid=makeGrid({x:10,y:20,width:1000,height:400},10,2);
  assert.equal(grid.length,20);
  assert.deepEqual(grid[19],{index:19,bbox:{x:910,y:220,width:100,height:200}});
  assert.throws(()=>makeGrid({x:0,y:0,width:100,height:100},5,5));
});
