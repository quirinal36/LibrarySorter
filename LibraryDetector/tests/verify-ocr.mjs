// Optional real-engine regression. Install tesseract.js and @napi-rs/canvas in
// an external temp folder and pass that folder as OCR_VERIFY_ROOT.
import {createRequire} from 'node:module';
import path from 'node:path';
import {readLabels} from '../src/ocr-pipeline.mjs';
import {detectLabels} from '../src/labels.mjs';
import {parseCallNumber} from '../src/recognition.mjs';
const require=createRequire(import.meta.url),root=process.env.OCR_VERIFY_ROOT;
if(!root)throw Error('Set OCR_VERIFY_ROOT to the isolated dependency folder.');
const {createCanvas,GlobalFonts}=require(path.join(root,'node_modules/@napi-rs/canvas'));
const {createWorker}=require(path.join(root,'node_modules/tesseract.js'));
GlobalFonts.registerFromPath('C:/Windows/Fonts/malgun.ttf','LabelTest');
globalThis.document={createElement:()=>createCanvas(1,1)};
const source=createCanvas(1600,680),ctx=source.getContext('2d');
ctx.fillStyle='#d8dedb';ctx.fillRect(0,0,1600,680);
const expected=[];
for(let i=0;i<20;i++) {
  const x=(i%10)*160+20,y=Math.floor(i/10)*340+210;
  ctx.fillStyle='#e9eeeb';ctx.fillRect(x-5,y-22,130,110);
  ctx.fillStyle='#67706f';ctx.font='16px LabelTest';
  const text=`${300+i}.1\n김${String(i+1).padStart(3,'0')}\nv.${i%5}`;
  text.split('\n').forEach((line,j)=>ctx.fillText(line,x,y+j*22));
  expected.push(JSON.stringify(parseCallNumber(text)));
}
const worker=await createWorker(['kor','eng'],1,{cachePath:root});
try {
  await worker.setParameters({tessedit_pageseg_mode:'11'});
  const start=Date.now(),before=await worker.recognize(source.toBuffer('image/png'),{}, {text:true,blocks:true});
  const baseline=detectLabels(before.data);
  const adapter={setParameters:settings=>worker.setParameters(settings),recognize:(canvas,options,outputs)=>worker.recognize(canvas.toBuffer('image/png'),options,outputs)};
  const after=await readLabels(source,adapter,[],{report:message=>console.log(message)});
  const correct=labels=>labels.filter(l=>l.confidence>=55&&expected.includes(JSON.stringify(parseCallNumber(l.text)))).length;
  console.log(JSON.stringify({fixture:'synthetic low-contrast 16px Korean labels',baselineCorrect:correct(baseline),enhancedCorrect:correct(after.labels),total:20,seconds:Math.round((Date.now()-start)/1000)}));
} finally {await worker.terminate();}
