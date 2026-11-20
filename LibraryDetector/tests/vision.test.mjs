import test from 'node:test';
import assert from 'node:assert/strict';
import {refineBox} from '../src/vision.mjs';

const cell={x:100,y:50,width:100,height:200};

test('uses a sufficiently large in-cell book detection',()=>{
  const result=refineBox(cell,[{x:105,y:60,width:90,height:180,score:.9}]);
  assert.deepEqual(result,{x:105,y:60,width:90,height:180});
});
test('rejects a detection spanning multiple grid cells',()=>{
  const spanning={x:100,y:50,width:200,height:200,score:.99};
  assert.strictEqual(refineBox(cell,[spanning]),cell);
});
test('rejects disjoint detections and preserves the calibrated slot',()=>{
  assert.strictEqual(refineBox(cell,[{x:400,y:50,width:100,height:200,score:.99}]),cell);
  assert.strictEqual(refineBox(cell,[]),cell);
});
test('a spanning high-confidence detection cannot override a valid in-cell box',()=>{
  const spanning={x:100,y:50,width:200,height:200,score:.99};
  const valid={x:105,y:60,width:90,height:180,score:.7};
  assert.deepEqual(refineBox(cell,[valid,spanning]),{x:105,y:60,width:90,height:180});
});
