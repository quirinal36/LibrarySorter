export function serverURL(base, path) {
  if (!base.trim()) return path;
  const url = new URL(base.trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('서버 주소는 https://서버주소 형식으로 입력해주세요.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw Error('서버는 HTTPS 주소를 사용해주세요.');
  return url.origin + path;
}

export async function inspectPhoto(canvas, {base='', accessCode='', signal, fetcher=fetch}={}) {
  const photo = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .95));
  if (!photo || photo.size > 12*1024*1024) throw Error('전송 사진은 12MB 이하여야 합니다. 촬영 범위를 줄여주세요.');
  const headers={'Content-Type':'image/jpeg'};
  if (accessCode.trim()) headers.Authorization=`Bearer ${accessCode.trim()}`;
  const response=await fetcher(serverURL(base,'/api/inspect'),{method:'POST',headers,body:photo,signal});
  const data=await response.json();
  if (!response.ok) throw Error(data.error || `서버 검사 실패 (${response.status})`);
  if (!Array.isArray(data.observations) || !Array.isArray(data.items) || data.image?.width!==canvas.width || data.image?.height!==canvas.height) throw Error('서버의 사진 좌표가 일치하지 않습니다.');
  const seen=new Set();
  const observations=data.observations.map((o,index)=>{
    const b=o.bbox;
    if(o.index!==index || !b || ![b.x,b.y,b.width,b.height,o.confidence].every(Number.isFinite) || b.x<0 || b.y<0 || b.width<=0 || b.height<=0 || b.x+b.width>canvas.width+1 || b.y+b.height>canvas.height+1 || typeof o.text!=='string') throw Error('서버 라벨 좌표가 올바르지 않습니다.');
    return o;
  });
  if(observations.length>100) throw Error('서버 라벨 수가 올바르지 않습니다.');
  for(const item of data.items){
    if(!Number.isInteger(item.index)||item.index<0||item.index>=observations.length||seen.has(item.index)) throw Error('서버 판정 번호가 올바르지 않습니다.');
    seen.add(item.index);
  }
  const items=observations.map(o=>{
    const verdict=data.items.find(i=>i.index===o.index);
    const valid=o.callNumber && o.confidence>=55 && ['ordered','wrong','uncertain'].includes(verdict?.status) && Number.isFinite(verdict?.confidence) && verdict.confidence>=0 && verdict.confidence<=1;
    const status=valid && !(verdict.status==='wrong' && verdict.confidence<.85) ? verdict.status : 'uncertain';
    return {...o,status,reason:valid?String(verdict.reason??'판정 근거 없음'):'청구기호 또는 판정이 불확실합니다.'};
  });
  return {observations,items,summary:String(data.summary??'검사를 마쳤습니다.')};
}
