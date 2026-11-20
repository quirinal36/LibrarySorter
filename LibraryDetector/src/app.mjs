import {inspectPhoto,serverURL} from './server-client.mjs';
import {readLabels} from './ocr-pipeline.mjs';
import {cameraConstraints,tuneCamera,captureSource,fitImage} from './capture.mjs';
import {buildObservations, findOrderConflicts} from './recognition.mjs';
import {getOCR, detectBooks, releaseModels} from './vision.mjs';

const $ = id => document.getElementById(id);
const video = $('camera'), frame = $('frame'), overlay = $('overlay'), stage = $('stage');
let stream = null, busy = false, opening = false, frozen = false, hasImage = false;
let generation = 0, autoTimer, aiController, verdicts = [];
const status = text => { $('status').textContent = text; };
const modelStatus = text => { $('model-status').textContent = text; };
function controls() {
  $('start-camera').disabled = busy || opening || !!stream;
  $('stop-camera').disabled = !stream && !opening && !busy;
  $('scan').disabled = busy || opening || !hasImage;
  $('resume-camera').disabled = busy || !stream || !frozen;
  for (const id of ['analysis-mode','image-input','demo','server-url','server-code']) $(id).disabled = busy || opening;
  $('camera-select').disabled = busy || opening;
  $('camera-zoom').disabled = busy || opening || !stream;
  $('scan').textContent = $('analysis-mode').value !== 'rules' ? '촬영하고 AI 검사' : '촬영하고 규칙 비교';
}
function setDimensions(width, height) {
  frame.width = overlay.width = width; frame.height = overlay.height = height;
  stage.style.aspectRatio = `${width} / ${height}`;
}
function clearResults() {
  verdicts = []; $('results').replaceChildren();
  $('recognized-count').textContent = '0'; $('wrong-count').textContent = '0'; $('unknown-count').textContent = '0';
  $('progress').value = 0;
  drawOverlay();
}
function drawOverlay() {
  const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!hasImage) return;
  const font = Math.max(15, overlay.width / 65);
  ctx.font = `bold ${font}px sans-serif`; ctx.textBaseline = 'top';
  const boxes = verdicts;
  for (const item of boxes) {
    const b = item.bbox;
    const color = {wrong:'#ff364f',uncertain:'#f6bb45',ordered:'#55cda0',grid:'#c6e4e5'}[item.status] ?? '#f6bb45';
    const pad = Math.max(2, overlay.width / 600);
    ctx.strokeStyle = color; ctx.lineWidth = item.status === 'wrong' ? pad * 2.2 : pad;
    ctx.strokeRect(b.x + pad, b.y + pad, b.width - pad * 2, b.height - pad * 2);
    const label = `${item.index + 1}${item.status === 'wrong' ? ' !' : item.status === 'uncertain' ? ' ?' : ''}`;
    const width = ctx.measureText(label).width + 8;
    ctx.fillStyle = color; ctx.fillRect(b.x + pad, b.y + pad, width, font + 5);
    ctx.fillStyle = '#101c28'; ctx.fillText(label, b.x + pad + 4, b.y + pad + 2);
  }
}
async function startCamera(deviceId) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status('스마트폰 카메라는 HTTPS 주소에서 실행해주세요. PC localhost에서는 테스트할 수 있습니다. 사진 파일로도 검사할 수 있습니다.'); return;
  }
  const token = ++generation; opening = true; controls(); status('후면 카메라 사용 권한을 허용해주세요.');
  try {
    let incoming;
    try { incoming = await navigator.mediaDevices.getUserMedia(cameraConstraints(typeof deviceId==='string'?deviceId:undefined)); }
    catch(error) {
      if(error.name!=='OverconstrainedError')throw error;
      incoming=await navigator.mediaDevices.getUserMedia({audio:false,video:typeof deviceId==='string'?{deviceId:{exact:deviceId}}:{facingMode:{ideal:'environment'}}});
    }
    if (token !== generation) { incoming.getTracks().forEach(t => t.stop()); return; }
    stream = incoming; video.srcObject = incoming; video.hidden = false;
    await video.play();
    if (token !== generation) return;
    const track=stream.getVideoTracks()[0],caps=await tuneCamera(track);
    if (token !== generation) return;
    const dimensions=fitImage(video.videoWidth,video.videoHeight);
    setDimensions(dimensions.width,dimensions.height);
    $('capture-quality').textContent=`카메라 실제 해상도 ${video.videoWidth} × ${video.videoHeight} · 지원 기기는 원본 사진으로 검사합니다.`;
    $('zoom-field').hidden=!caps.zoom;
    if(caps.zoom){const zoom=$('camera-zoom');zoom.min=caps.zoom.min;zoom.max=caps.zoom.max;zoom.step=caps.zoom.step||.1;zoom.value=track.getSettings?.().zoom??caps.zoom.min;$('zoom-value').textContent=zoom.value;}
    const cameras=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
    if (token !== generation) return;
    $('camera-select').replaceChildren();
    cameras.forEach((d,i)=>{const option=document.createElement('option');option.value=d.deviceId;option.textContent=d.label||`카메라 ${i+1}`;$('camera-select').append(option);});
    $('camera-select').value=track.getSettings?.().deviceId??'';
    hasImage = true; frozen = false; frame.hidden = true; $('camera-placeholder').hidden = true;
    clearResults();
    status('책 아래쪽 청구기호가 선명하게 보이도록 비춘 뒤 검사하세요. 라벨을 자동으로 찾습니다.');
  } catch (error) {
    if (token !== generation) return;
    stopCamera(false);
    status(({NotAllowedError:'카메라 권한이 거부되었습니다. 브라우저 권한 설정을 확인하세요.',NotFoundError:'사용할 카메라가 없습니다. 사진 파일을 선택할 수 있습니다.',NotReadableError:'카메라를 다른 앱에서 사용 중이거나 시작할 수 없습니다.'})[error.name] ?? `카메라를 시작하지 못했습니다: ${error.message}`);
  } finally { opening = false; controls(); }
}
function stopCamera(showMessage = true) {
  ++generation; clearTimeout(autoTimer); $('auto-scan').checked = false;
  aiController?.abort();
  stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; video.hidden = true;
  if (!frozen) { hasImage = false; $('camera-placeholder').hidden = false; clearResults(); }
  controls();
  if (showMessage) status(busy ? '카메라를 종료했습니다. 진행 중인 OCR 결과는 폐기합니다.' : '카메라가 종료되었습니다.');
}
function resume() {
  if (!stream || busy) return;
  clearTimeout(autoTimer); $('auto-scan').checked = false;
  frozen = false; frame.hidden = true; video.hidden = false; clearResults(); controls();
  const dimensions=fitImage(video.videoWidth,video.videoHeight);setDimensions(dimensions.width,dimensions.height);
  status('카메라 미리보기입니다. 촬영 영역을 확인한 뒤 다시 검사하세요.');
}
async function snapshot(token) {
  if (stream) {
    const source=await captureSource(video,stream.getVideoTracks()[0],modelStatus);
    try {
      if(token!==generation)return false;
      const dims=fitImage(source.width,source.height);setDimensions(dims.width,dims.height);
      frame.getContext('2d').drawImage(source.image,0,0,frame.width,frame.height);
      $('capture-quality').textContent=`${source.kind} ${source.width} × ${source.height} → 분석 ${frame.width} × ${frame.height}`;
    } finally {source.close();}
  }
  frozen = true; frame.hidden = false; video.hidden = true; drawOverlay(); controls();
  return true;
}
function showResults(items, summary, observations) {
  verdicts = items; drawOverlay();
  $('recognized-count').textContent = String(observations.filter(o => o.callNumber && o.confidence >= 55).length);
  $('wrong-count').textContent = String(items.filter(i => i.status === 'wrong').length);
  $('unknown-count').textContent = String(items.filter(i => i.status === 'uncertain').length);
  $('results').replaceChildren();
  for (const item of items) {
    const li = document.createElement('li'); li.className = `result-item ${item.status}`;
    const heading = document.createElement('strong');
    heading.textContent = `${item.index + 1}번째 · ${{wrong:'배열 이상',uncertain:'확인 필요',ordered:'관찰한 순서에 부합'}[item.status]}`;
    const reason = document.createElement('p'); reason.textContent = item.reason;
    const detail = document.createElement('details'), label = document.createElement('summary'), raw = document.createElement('pre');
    label.textContent = 'OCR 원문'; raw.textContent = observations.find(o => o.index === item.index)?.text || '(읽은 글자 없음)';
    detail.append(label, raw); li.append(heading, reason, detail); $('results').append(li);
  }
  status(summary);
}
function rulesVerdicts(observations) {
  const conflicts = findOrderConflicts(observations), affected = new Map();
  const readableCount = observations.filter(o => o.callNumber && o.confidence >= 55).length;
  for (const c of conflicts) for (const index of [c.leftIndex, c.rightIndex]) affected.set(index, `${c.leftIndex + 1}번째와 ${c.rightIndex + 1}번째의 순서가 뒤집혀 있습니다. 어느 책을 옮겨야 하는지는 단정하지 않습니다.`);
  return observations.map(o => ({...o,
    status: readableCount < 2 || !o.callNumber || o.confidence < 55 || affected.has(o.index) ? 'uncertain' : 'ordered',
    reason: affected.get(o.index) ?? (readableCount < 2 ? '비교할 청구기호가 부족합니다.' : !o.callNumber || o.confidence < 55 ? '청구기호를 확실히 읽지 못했습니다.' : '읽힌 이웃 청구기호와 역순 관계가 발견되지 않았습니다. 전체 정답을 보증하지는 않습니다.'),
  }));
}
async function askAI(observations, token) {
  const controller = new AbortController(); aiController = controller;
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch('/api/analyze', {method:'POST', signal:controller.signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      
      observations:observations.map(({index,text,confidence,callNumber,row,bbox}) => ({index,text,confidence,callNumber,row,bbox})),
    })});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `AI 요청 실패 (${response.status})`);
    if (token !== generation) return null;
    if (!Array.isArray(data.items)) throw Error('AI 응답 형식이 올바르지 않습니다.');
    return {summary:data.summary, items:observations.map(o => {
      const item = data.items.find(i => i.index === o.index);
      if (!o.callNumber || o.confidence < 55 || !item || !['wrong','uncertain','ordered'].includes(item.status)) return {...o,status:'uncertain',reason:'청구기호가 불명확하여 AI 판정을 보류했습니다.'};
      // A low-confidence model answer is never shown as a red box.
      return {...o,status:item.status === 'wrong' && (!Number.isFinite(item.confidence) || item.confidence < .8) ? 'uncertain' : item.status,reason:String(item.reason ?? '판단 근거를 확인할 수 없습니다.')};
    })};
  } catch (error) { if (error.name === 'AbortError') throw Error('AI 응답 시간이 초과되었습니다. 다시 시도해주세요.'); throw error; }
  finally { clearTimeout(timer); if (aiController === controller) aiController = null; }
}
async function scan() {
  if (busy || !hasImage) return;
  clearTimeout(autoTimer);
  const token = ++generation; busy = true; clearResults(); controls();
  let succeeded = false;
  try {
    if(!await snapshot(token))return;
    if ($('analysis-mode').value === 'jetson') {
      const controller = new AbortController(); aiController = controller;
      const timer = setTimeout(() => controller.abort(), 300000);
      try {
        status('사진을 서버로 보내 라벨을 읽고 배열을 검사하고 있습니다…');
        modelStatus('Jetson OCR → Gadia AI · 잠시 기다려주세요.');
        const answer = await inspectPhoto(frame, {base:$('server-url').value, accessCode:$('server-code').value, signal:controller.signal});
        if (token !== generation) return;
        $('progress').value = 1;
        $('ocr-quality').textContent = `서버 OCR · 라벨 ${answer.observations.length}개`;
        showResults(answer.items, answer.summary, answer.observations);
        succeeded = true;
      } finally { clearTimeout(timer); if (aiController === controller) aiController = null; }
      return;
    }
    if ($('analysis-mode').value === 'ai') {
      const check = await fetch('/api/health');
      if (!check.ok || !(await check.json()).configured) throw Error('AI 서버 또는 GADIA_API_KEY가 준비되지 않았습니다.');
    }
    const worker = await getOCR(modelStatus);
    if (token !== generation) return;
    let detections = [];
    try { detections = await detectBooks(frame, modelStatus); modelStatus(`MediaPipe 책 영역 ${detections.length}개 · OCR 준비 완료`); }
    catch { modelStatus('MediaPipe 연결 없이 OCR 글자 좌표로 청구기호 라벨을 찾습니다.'); }
    if (token !== generation) return;
    status('청구기호 라벨을 자동으로 찾고 있습니다…');
    const result = await readLabels(frame,worker,detections,{report:status,progress:value=>{$('progress').value=value;},cancelled:()=>token!==generation});
    if (token !== generation) return;
    const readings = result.labels;
    $('ocr-quality').textContent=`OCR 단어 ${result.wordCount}개 · 라벨 후보 ${readings.length}개 · 작은 글씨 확대·명암 보정·라벨 재인식 적용`;
    const observations = buildObservations(readings);
    $('progress').value = 1;
    if (observations.length < 2) {
      showResults(observations.map(o=>({...o,status:'uncertain',reason:'비교할 라벨이 부족합니다.'})), '청구기호를 두 개 이상 찾지 못했습니다. 라벨을 더 크게 비춰주세요.', observations);
      return;
    }
    if ($('analysis-mode').value === 'ai') {
      status('AI가 촬영한 청구기호와 배열 규칙을 비교하고 있습니다…');
      const answer = await askAI(observations, token);
      if (!answer) return;
      showResults(answer.items, `AI 판단 · ${answer.summary}`, observations);
    } else showResults(rulesVerdicts(observations), '규칙 비교 완료 (AI 판단 아님). 역순으로 충돌한 책은 확인 필요로 표시합니다.', observations);
    succeeded = true;
  } catch (error) {
    if (token === generation) status(`검사를 완료하지 못했습니다: ${error.message} AI 연결 없이 검사하려면 ‘규칙 비교만’을 선택하세요.`);
  } finally {
    busy = false; controls();
    if (succeeded && token === generation && $('auto-scan').checked && stream) autoTimer = setTimeout(scan, 3500);
  }
}
$('analysis-mode').onchange = () => { clearTimeout(autoTimer); $('auto-scan').checked = false; clearResults(); controls(); };
$('auto-scan').onchange = () => { if (!$('auto-scan').checked) clearTimeout(autoTimer); };
$('start-camera').onclick = () => startCamera($('camera-select').value); $('stop-camera').onclick = () => stopCamera();
$('camera-select').onchange=()=>{const device=$('camera-select').value;stopCamera(false);startCamera(device);};
$('camera-zoom').onchange=async()=>{
  const track=stream?.getVideoTracks()[0];if(!track)return;
  try{await track.applyConstraints({advanced:[{zoom:Number($('camera-zoom').value)}]});$('zoom-value').textContent=$('camera-zoom').value;}
  catch{status('이 카메라에서는 확대 배율을 변경할 수 없습니다.');}
};
$('scan').onclick = scan; $('resume-camera').onclick = resume;
$('image-input').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  stopCamera(false);
  const token = generation;
  if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) { status('20MB 이하의 사진 파일을 선택해주세요.'); return; }
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.src = url; await image.decode();
    if (token !== generation) return;
    const dimensions=fitImage(image.width,image.height);
    setDimensions(dimensions.width,dimensions.height);
    $('capture-quality').textContent=`사진 ${image.width} × ${image.height} → 분석 ${frame.width} × ${frame.height}`;
    frame.getContext('2d').drawImage(image,0,0,frame.width,frame.height);
    hasImage = frozen = true; frame.hidden = false; video.hidden = true; $('camera-placeholder').hidden = true;
    clearResults(); controls(); status('사진을 불러왔습니다. 검사하면 청구기호 라벨을 자동으로 찾습니다.');
  } catch { if (token === generation) status('사진을 읽을 수 없습니다. JPEG 또는 PNG 파일로 다시 시도해주세요.'); }
  finally { URL.revokeObjectURL(url); event.target.value = ''; }
};
$('demo').onclick = () => {
  stopCamera(false); setDimensions(1800,700);
  hasImage = frozen = true; frame.hidden = false; $('camera-placeholder').hidden = true;
  const ctx = frame.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1800,700);
  const sequence=[800,801,805,803,804,802];
  const observations=buildObservations(sequence.map((n,index)=>{
    const bbox={x:50+index*280,y:480,width:180,height:100};
    const text=`${n}.1\nY001`;
    ctx.fillStyle='#183d38';ctx.font='28px sans-serif';
    text.split('\n').forEach((line,i)=>ctx.fillText(line,bbox.x+8,bbox.y+30+i*35));
    return {index,bbox,text,confidence:100};
  }));
  showResults(rulesVerdicts(observations),'합성 규칙 비교 데모입니다. OCR과 AI를 실행하지 않았습니다.',observations);controls();
};
async function health() {
  try { const response = await fetch(serverURL($('server-url').value,'/api/health')); if (!response.ok) throw Error(); const h = await response.json(); $('ai-status').textContent = !h.photoInspection ? '기존 서버입니다. 사진 검사는 python -m server.app으로 실행하세요.' : !h.ocrReady ? 'CUDA OCR 준비 필요 · 서버 GPU 진단과 OCR 모델 설치를 확인하세요.' : h.configured ? `CUDA OCR 준비 · ${h.model}${h.authenticationRequired ? ' · 접속 코드 필요' : ''}` : '서버 AI 설정이 필요합니다.'; }
  catch { $('ai-status').textContent = '서버 연결 실패 · 서버 주소와 HTTPS 연결을 확인하세요.'; }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', () => { stopCamera(false); releaseModels(); });
$('server-url').onchange = health;
controls(); health();
