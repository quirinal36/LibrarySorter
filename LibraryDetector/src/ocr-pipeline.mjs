import {cropCanvas} from './vision.mjs';
import {detectLabels} from './labels.mjs';
import {parseCallNumber} from './recognition.mjs';

export function tileRegions(width,height) {
  const nx=width>height?3:2,ny=width>height?2:3;
  const w=width/nx,h=height/ny,overlap=.15;
  return Array.from({length:nx*ny},(_,i)=>{
    const x=Math.max(0,(i%nx)*w-w*overlap),y=Math.max(0,Math.floor(i/nx)*h-h*overlap);
    return {x,y,width:Math.min(width,((i%nx)+1)*w+w*overlap)-x,height:Math.min(height,(Math.floor(i/nx)+1)*h+h*overlap)-y};
  });
}
export function mappedWords(data,region,scale) {
  return (data.blocks??[]).flatMap(b=>(b.paragraphs??[]).flatMap(p=>(p.lines??[]).flatMap(l=>l.words??[])))
    .filter(w=>w.text?.trim()&&w.bbox).map(w=>({...w,bbox:{
      x0:region.x+w.bbox.x0/scale,y0:region.y+w.bbox.y0/scale,
      x1:region.x+w.bbox.x1/scale,y1:region.y+w.bbox.y1/scale}}));
}
function overlap(a,b) {
  const area=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
  return area/Math.max(1,Math.min((a.x1-a.x0)*(a.y1-a.y0),(b.x1-b.x0)*(b.y1-b.y0)));
}
export function deduplicateWords(words) {
  const out=[];
  for(const word of [...words].sort((a,b)=>(b.confidence??0)-(a.confidence??0))) {
    if(!out.some(w=>overlap(w.bbox,word.bbox)>.7 && Math.abs((w.bbox.x1-w.bbox.x0)-(word.bbox.x1-word.bbox.x0))<Math.max(12,(word.bbox.x1-word.bbox.x0)*.6)))out.push(word);
  }
  return out;
}
export function improveContrast(pixels) {
  const hist=new Uint32Array(256),gray=new Uint8Array(pixels.length/4);
  for(let i=0;i<gray.length;i++){gray[i]=Math.round(.299*pixels[i*4]+.587*pixels[i*4+1]+.114*pixels[i*4+2]);hist[gray[i]]++;}
  let low=0,high=255,count=0;
  for(let i=0;i<256;i++){count+=hist[i];if(count>=gray.length*.015){low=i;break;}}
  count=0;for(let i=255;i>=0;i--){count+=hist[i];if(count>=gray.length*.015){high=i;break;}}
  for(let i=0;i<gray.length;i++){
    const v=high-low>30?Math.max(0,Math.min(255,(gray[i]-low)*255/(high-low))):gray[i];
    pixels[i*4]=pixels[i*4+1]=pixels[i*4+2]=v;
  }
  return pixels;
}
function prepare(source,region,scale,contrast) {
  const canvas=cropCanvas(source,region,scale);
  if(contrast){const ctx=canvas.getContext('2d',{willReadFrequently:true});const image=ctx.getImageData(0,0,canvas.width,canvas.height);improveContrast(image.data);ctx.putImageData(image,0,0);}
  return canvas;
}
export async function readLabels(source,worker,books=[],{report=()=>{},progress=()=>{},cancelled=()=>false}={}) {
  const check=()=>{if(cancelled())throw Error('검사가 취소되었습니다.');};
  const regions=tileRegions(source.width,source.height),words=[];
  await worker.setParameters({tessedit_pageseg_mode:'11'});
  for(let i=0;i<regions.length;i++) {
    check();report(`확대 OCR ${i+1}/${regions.length} · 작은 청구기호를 읽고 있습니다.`);
    const r=regions[i],scale=Math.min(3,2200/Math.max(r.width,r.height));
    const canvas=prepare(source,r,scale,true);
    const {data}=await worker.recognize(canvas,{}, {text:true,blocks:true});
    canvas.width=canvas.height=1;check();words.push(...mappedWords(data,r,scale));progress((i+1)/regions.length*.7);
  }
  const unique=deduplicateWords(words);
  const data={blocks:[{paragraphs:[{lines:[{words:unique}]}]}]};
  let labels=detectLabels(data,books,{includeIncomplete:true}).slice(0,100);
  // Re-read the actual label crop with a single-block layout; never use the catalogue.
  try {
    await worker.setParameters({tessedit_pageseg_mode:'6'});
    for(let i=0;i<Math.min(labels.length,100);i++) {
      check();report(`라벨 정밀 재인식 ${i+1}/${labels.length}`);
      const label=labels[i],b=label.bbox,pad=Math.max(4,b.height*.12);
      const r={x:Math.max(0,b.x-pad),y:Math.max(0,b.y-pad),width:0,height:0};
      r.width=Math.min(source.width,b.x+b.width+pad)-r.x;r.height=Math.min(source.height,b.y+b.height+pad)-r.y;
      const canvas=prepare(source,r,Math.min(4,650/r.width,800/r.height),false);
      const {data:second}=await worker.recognize(canvas,{}, {text:true});canvas.width=canvas.height=1;check();
      const parsed=parseCallNumber(second.text??''),first=parseCallNumber(label.text);
      if(parsed && first && JSON.stringify(parsed)!==JSON.stringify(first) && second.confidence>=55 && label.confidence>=55) {
        label.confidence=40;label.ocrWarning='두 번의 OCR 결과가 달라 재촬영이 필요합니다.';
      } else if(parsed && Number(second.confidence)>label.confidence) {
        label.text=second.text;label.confidence=Number(second.confidence);
        label.incomplete=false;
      }
      progress(.7+.3*(i+1)/labels.length);
    }
  } finally { await worker.setParameters({tessedit_pageseg_mode:'11'}); }
  return {labels,wordCount:unique.length};
}
