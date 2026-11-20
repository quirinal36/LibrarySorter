// Extract call-number labels from OCR word boxes, without slots or a catalogue.
export function detectLabels(data, bookBoxes = [], {includeIncomplete=false} = {}) {
  const words = (data.blocks ?? []).flatMap(b => (b.paragraphs ?? []).flatMap(p => (p.lines ?? []).flatMap(l => l.words ?? [])))
    .filter(w => w.bbox && w.text?.trim()).map((w,id) => ({id,text:w.text.trim(),confidence:Number(w.confidence)||0,
      x:w.bbox.x0,y:w.bbox.y0,width:w.bbox.x1-w.bbox.x0,height:w.bbox.y1-w.bbox.y0}));
  const tokens = [...words];
  // OCR may split a Korean author mark or v.N into adjacent words.
  for (const a of words) for (const b of words) {
    if (b.x < a.x+a.width || b.x-a.x-a.width > Math.max(a.height,b.height)*1.2 || Math.abs(a.y-b.y)>Math.min(a.height,b.height)*.5) continue;
    const text=(a.text+b.text).replace(/\s/g,'');
    if (/^(?:[가-힣A-Za-z]+\d+[가-힣ㄱ-ㅎA-Za-z]?|[vV]\.?\d+|\d{3}\.\d+)$/.test(text))
      tokens.push({...a,text,width:b.x+b.width-a.x,height:Math.max(a.height,b.height),confidence:Math.min(a.confidence,b.confidence),ids:[a.id,b.id]});
  }
  const used=new Set(), labels=[];
  const anchors=tokens.filter(w=>/^\d{3}(?:\.\d+)?$/.test(w.text)).sort((a,b)=>a.y-b.y||a.x-b.x);
  for (const anchor of anchors) {
    if(used.has(anchor.id))continue;
    const near = (w, maxY) => w.y>=anchor.y-anchor.height*.5 && w.y-anchor.y<maxY*anchor.height &&
      Math.abs(w.x-anchor.x)<Math.max(anchor.width*.65,anchor.height*1.8);
    const marks=tokens.filter(w=>!used.has(w.id)&&/^(?:[가-힣]+|[A-Za-z]+)\d+[가-힣ㄱ-ㅎA-Za-z]?$/.test(w.text)&&!/^v\d/i.test(w.text)&&near(w,5))
      .sort((a,b)=>Math.abs(a.y-anchor.y)+Math.abs(a.x-anchor.x)-Math.abs(b.y-anchor.y)-Math.abs(b.x-anchor.x));
    const mark=marks[0];
    if(!mark){
      if(includeIncomplete && anchor.confidence>=65 && !labels.some(l=>Math.abs(l.bbox.x-anchor.x)<anchor.width&&Math.abs(l.bbox.y-anchor.y)<anchor.height*5)) {
        labels.push({text:anchor.text,confidence:0,incomplete:true,bbox:{x:Math.max(0,anchor.x-5),y:Math.max(0,anchor.y-5),width:Math.max(anchor.width*1.6,anchor.height*5),height:anchor.height*4.5}});
      }
      continue;
    }
    const volume=tokens.filter(w=>/^[vV]\.?\d+$/.test(w.text)&&near(w,8)&&w.y>=mark.y+mark.height*.5).sort((a,b)=>a.y-b.y)[0];
    const parts=[anchor,mark,...(volume?[volume]:[])];
    const x=Math.min(...parts.map(w=>w.x)),y=Math.min(...parts.map(w=>w.y));
    const right=Math.max(...parts.map(w=>w.x+w.width)),bottom=Math.max(...parts.map(w=>w.y+w.height));
    for(const w of parts)for(const id of w.ids??[w.id])used.add(id);
    // MediaPipe supplies supporting book-region association, not label text or truth.
    const book=bookBoxes.find(b=>x>=b.x&&right<=b.x+b.width&&y>=b.y&&bottom<=b.y+b.height);
    labels.push({text:parts.map(w=>w.text).join('\n'),confidence:Math.min(...parts.map(w=>w.confidence)),
      bbox:{x:Math.max(0,x-4),y:Math.max(0,y-4),width:right-x+8,height:bottom-y+8},bookRegion:book??null});
  }
  // Group approximately aligned label baselines into rows, then left-to-right.
  const rows=[];
  for(const label of labels.sort((a,b)=>a.bbox.y-b.bbox.y)) {
    let row=rows.find(r=>Math.abs(r.y-label.bbox.y)<Math.max(r.height,label.bbox.height)*.65);
    if(!row){row={y:label.bbox.y,height:label.bbox.height,items:[]};rows.push(row);}
    row.items.push(label);
  }
  return rows.flatMap((r,row)=>r.items.sort((a,b)=>a.bbox.x-b.bbox.x).map(l=>({...l,row}))).map((l,index)=>({...l,index}));
}
