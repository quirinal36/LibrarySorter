import test from 'node:test';
import assert from 'node:assert/strict';
import {detectLabels} from '../src/labels.mjs';
export function ocrFixture(count=6) {
  const words=[];
  for(let i=0;i<count;i++) {
    const x=(i%10)*150,y=Math.floor(i/10)*250;
    for(const [j,text] of [`${800+i}.1`,'Y001','v.2'].entries())words.push({text,confidence:95,bbox:{x0:x,y0:y+j*25,x1:x+65,y1:y+j*25+20}});
  }
  return {blocks:[{paragraphs:[{lines:[{words}]}]}]};
}
test('finds arbitrary label count and includes volume in label rectangle',()=>{
  const result=detectLabels(ocrFixture());assert.equal(result.length,6);
  assert.equal(result[0].text,'800.1\nY001\nv.2');assert(result[0].bbox.height>=70);
});
test('sorts by visual row then x, without sorting away an inversion',()=>{
  const data=ocrFixture(12);data.blocks[0].paragraphs[0].lines[0].words[0].text='999.1';
  const result=detectLabels(data);assert.equal(result.length,12);assert.equal(result[0].text.split('\n')[0],'999.1');assert.equal(result[10].row,1);
});
test('no readable labels means no guessed rectangles',()=>assert.deepEqual(detectLabels({text:'unreadable'}),[]));
test('one missing mark does not shift physical boxes or invent a book',()=>{
  const data=ocrFixture();data.blocks[0].paragraphs[0].lines[0].words.splice(4,1);
  const result=detectLabels(data);assert.equal(result.length,5);assert(result[1].bbox.x>=296);
});
