import test from 'node:test';
import assert from 'node:assert/strict';
import {fitImage,cameraConstraints,captureSource,tuneCamera} from '../src/capture.mjs';
import {tileRegions,mappedWords,deduplicateWords,improveContrast} from '../src/ocr-pipeline.mjs';

test('4K requests rear camera, preserving 4K while bounding very large photos',()=>{
  assert.equal(cameraConstraints().video.width.ideal,3840);
  assert.equal(cameraConstraints('rear').video.deviceId.exact,'rear');
  assert.deepEqual(fitImage(3840,2160),{width:3840,height:2160});
  const size=fitImage(12000,9000);assert(size.width*size.height<=18010000);assert(Math.abs(size.width/size.height-4/3)<.001);
});
test('six overlapping tiles cover landscape and portrait image edges',()=>{
  for(const [w,h] of [[4000,3000],[3000,4000]]){
    const regions=tileRegions(w,h);assert.equal(regions.length,6);
    for(let x=0;x<w;x+=100)for(let y=0;y<h;y+=100)assert(regions.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height));
  }
});
test('OCR boxes are mapped back to original photo coordinates and overlap duplicates removed',()=>{
  const data={blocks:[{paragraphs:[{lines:[{words:[{text:'813.7',confidence:90,bbox:{x0:20,y0:40,x1:100,y1:80}}]}]}]}]};
  const words=mappedWords(data,{x:200,y:300},2);
  assert.deepEqual(words[0].bbox,{x0:210,y0:320,x1:250,y1:340});
  assert.equal(deduplicateWords([...words,{...words[0],confidence:30}]).length,1);
});
test('contrast stretch improves faded text without adding colors',()=>{
  const pixels=new Uint8ClampedArray([100,100,100,255,200,200,200,255]);
  improveContrast(pixels);assert.equal(pixels[0],0);assert.equal(pixels[4],255);assert.equal(pixels[3],255);
});
test('unsupported still-photo API falls back to native video resolution',async()=>{
  const source=await captureSource({readyState:2,videoWidth:3840,videoHeight:2160},{});
  assert.equal(source.width,3840);assert.equal(source.height,2160);
});
test('supported still capture uses photo dimensions and releases its bitmap',async()=>{
  const oldCapture=globalThis.ImageCapture,oldBitmap=globalThis.createImageBitmap;
  let closed=false,options;
  globalThis.ImageCapture=class{async getPhotoCapabilities(){return {imageWidth:{max:4000},imageHeight:{max:3000}};}async takePhoto(o){options=o;return {};}};
  globalThis.createImageBitmap=async()=>({width:4000,height:3000,close(){closed=true;}});
  try{
    const source=await captureSource({videoWidth:1280,videoHeight:720},{});
    assert.equal(source.width,4000);assert.equal(source.height,3000);assert.equal(options.imageWidth,4000);
    source.close();assert(closed);
  } finally {
    if(oldCapture===undefined)delete globalThis.ImageCapture;else globalThis.ImageCapture=oldCapture;
    if(oldBitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=oldBitmap;
  }
});
test('focus/exposure are applied only when advertised, optional failure is safe',async()=>{
  let applied;
  await tuneCamera({getCapabilities:()=>({focusMode:['continuous']}),applyConstraints:async c=>{applied=c;}});
  assert.deepEqual(applied,{advanced:[{focusMode:'continuous'}]});
  await tuneCamera({getCapabilities:()=>({focusMode:['continuous']}),applyConstraints:async()=>{throw Error();}});
});
