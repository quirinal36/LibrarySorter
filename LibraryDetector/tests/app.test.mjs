import {serverURL} from '../src/server-client.mjs';
import {detectLabels} from '../src/labels.mjs';
import {ocrFixture} from './labels.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {makeGrid,buildObservations,findOrderConflicts} from '../src/recognition.mjs';
import {refineBox} from '../src/vision.mjs';
import {fitImage,cameraConstraints} from '../src/capture.mjs';

const source = fs.readFileSync(new URL('../src/app.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const html = fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function setup({configured=true, secure=true, recognize, inspect}={}) {
  const canvasContext = {clearRect(){},fillRect(){},strokeRect(){},fillText(){},drawImage(){},measureText(s){return {width:s.length*10};}};
  class Element {
    constructor() { this.children=[]; this.value=''; this.style={}; this.checked=false; this.hidden=false; this.width=1800;this.height=700;this.videoWidth=1800;this.videoHeight=700;this.readyState=2;this.events={};this.classList={add(){},remove(){},toggle(){}}; }
    append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
    getContext(){return canvasContext;} toDataURL(){return 'data:image/jpeg;base64,/9j/2Q==';}
    getBoundingClientRect(){return {left:0,top:0,width:900,height:350};}
    addEventListener(name,fn){this.events[name]=fn;} setPointerCapture(){} play(){return Promise.resolve();}
  }
  const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
  nodes['analysis-mode'].value='ai';
  let requests=[],ocrCalls=0,stops=0;
  const track={stop(){stops++;},getSettings:()=>({deviceId:'rear'})};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const context={console,AbortController,Error,serverURL,Image:class{},URL,setTimeout:()=>1,clearTimeout(){},
    document:{getElementById:id=>{assert(nodes[id],`Missing DOM ${id}`);return nodes[id];},createElement:()=>new Element(),addEventListener(){}},
    window:{isSecureContext:secure,addEventListener(){}},navigator:{mediaDevices:{getUserMedia:async()=>stream,enumerateDevices:async()=>[{kind:'videoinput',deviceId:'rear',label:'Rear'}]}},
    inspectPhoto:inspect??(async()=>{throw Error('Unexpected photo upload');}),
    fitImage,cameraConstraints,tuneCamera:async()=>({}),captureSource:async video=>({image:video,width:video.videoWidth,height:video.videoHeight,kind:'test',close(){}}),
    readLabels:async(source,worker)=>({labels:detectLabels((await worker.recognize(source)).data),wordCount:60}),
    makeGrid,buildObservations,findOrderConflicts,refineBox,detectLabels,
    cropCanvas:()=>new Element(),releaseModels(){},detectBooks:async()=>[],
    getOCR:async()=>({recognize:async()=>{const i=ocrCalls++;return recognize?recognize(i):{data:ocrFixture(20)};}}),
    fetch:async(url,options)=>{requests.push({url,options});if(url==='/api/health')return {ok:true,json:async()=>({configured,model:'test-model'})};return {ok:true,json:async()=>({summary:'Inspection',items:Array.from({length:20},(_,index)=>({index,status:index===3?'wrong':'ordered',reason:'Comparison',confidence:.95}))})};},
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {nodes,run:code=>vm.runInContext(code,context),context,requests,get ocrCalls(){return ocrCalls;},get stops(){return stops;}};
}
test('demo is explicitly non-AI and produces uncertainty, not invented wrong positions',()=>{
  const s=setup();s.nodes.demo.onclick();
  assert.equal(s.nodes.results.children.length,6);assert.equal(s.nodes['wrong-count'].textContent,'0');
  assert(Number(s.nodes['unknown-count'].textContent)>0);
  assert.equal(s.ocrCalls,0);assert.equal(s.requests.filter(r=>r.url==='/api/analyze').length,0);
});
test('insecure smartphone origin refuses camera with actionable guidance',async()=>{
  const s=setup({secure:false});await s.nodes['start-camera'].onclick();
  assert.match(s.nodes.status.textContent,/HTTPS/);assert.equal(s.run('stream'),null);
});
test('camera capture, automatic OCR, local-only comparison, and stop lifecycle',async()=>{
  const s=setup();await s.nodes['start-camera'].onclick();
  s.nodes['analysis-mode'].value='rules';s.nodes['analysis-mode'].onchange();
  await s.nodes.scan.onclick();
  assert.equal(s.ocrCalls,1);assert.equal(s.nodes.results.children.length,20);assert.equal(s.nodes['recognized-count'].textContent,'20');
  assert.equal(s.nodes.frame.hidden,false);assert.equal(s.nodes.camera.hidden,true);
  assert.equal(s.requests.filter(r=>r.url==='/api/analyze').length,0);
  s.nodes['resume-camera'].onclick();assert.equal(s.nodes.camera.hidden,false);assert.equal(s.nodes.results.children.length,0);
  s.nodes['stop-camera'].onclick();assert.equal(s.stops,1);assert.equal(s.run('hasImage'),false);
});
test('AI mode sends OCR observations only, never the photographed image',async()=>{
  const s=setup();await s.nodes['start-camera'].onclick();await s.nodes.scan.onclick();
  const request=s.requests.find(r=>r.url==='/api/analyze');assert(request);
  const payload=JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload).sort(),['observations']);
  assert.equal(payload.observations.length,20);assert.equal(payload.image,undefined);
  assert.equal(s.nodes['wrong-count'].textContent,'1');
  assert(!s.requests.some(r=>/books\.json/.test(r.url)));
});
test('missing AI key fails before model download/OCR rather than falling back silently',async()=>{
  const s=setup({configured:false});s.nodes.demo.onclick();await s.nodes.scan.onclick();
  assert.equal(s.ocrCalls,0);assert.match(s.nodes.status.textContent,/GADIA_API_KEY/);
});
test('stopping during OCR discards stale output and never calls AI',async()=>{
  let resolve;const s=setup({recognize:()=>new Promise(r=>{resolve=r;})});
  await s.nodes['start-camera'].onclick();const pending=s.nodes.scan.onclick();
  for(let i=0;i<50&&!resolve;i++)await Promise.resolve();assert(resolve);
  s.nodes['stop-camera'].onclick();resolve({data:{text:'800.1 Y001',confidence:99}});await pending;
  assert.equal(s.nodes.results.children.length,0);assert.equal(s.requests.filter(r=>r.url==='/api/analyze').length,0);
  assert.equal(s.run('busy'),false);
});
test('an older photo decode cannot overwrite a newer demo/source',async()=>{
  const s=setup();let finishDecode;
  s.context.URL={createObjectURL:()=> 'blob:test',revokeObjectURL(){}};
  s.context.Image=class {constructor(){this.width=900;this.height=1600;}decode(){return new Promise(resolve=>{finishDecode=resolve;});}};
  const pending=s.nodes['image-input'].onchange({target:{files:[{type:'image/png',size:100}]}});
  assert(finishDecode);s.nodes.demo.onclick();finishDecode();await pending;
  assert.equal(s.nodes.frame.width,1800);assert.equal(s.nodes.frame.height,700);
  assert.equal(s.nodes.results.children.length,6);
});


test('Jetson photo flow skips browser OCR and discards cancelled results',async()=>{
  let finish, sent;
  const s=setup({inspect:async(canvas,options)=>{sent=options;return new Promise(resolve=>{finish=resolve;});}});
  s.nodes['analysis-mode'].value='jetson';
  await s.nodes['start-camera'].onclick();
  const pending=s.nodes.scan.onclick();
  for(let i=0;i<50&&!finish;i++)await Promise.resolve();
  assert(finish);assert.equal(s.ocrCalls,0);
  s.nodes['stop-camera'].onclick();assert(sent.signal.aborted);
  finish({items:[],observations:[],summary:'stale'});await pending;
  assert.equal(s.nodes.results.children.length,0);assert.equal(s.run('busy'),false);
});

test('Jetson photo flow renders server boxes on frozen photo',async()=>{
  const observations=buildObservations(detectLabels(ocrFixture(20)));
  const s=setup({inspect:async()=>({observations,items:observations.map(o=>({...o,status:'ordered',reason:'ok'})),summary:'server result'})});
  s.nodes['analysis-mode'].value='jetson';
  await s.nodes['start-camera'].onclick();await s.nodes.scan.onclick();
  assert.equal(s.ocrCalls,0);assert.equal(s.nodes.results.children.length,20);
  assert.equal(s.nodes.frame.hidden,false);assert.equal(s.nodes.camera.hidden,true);
});
