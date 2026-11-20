import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPhoto,serverURL} from '../src/server-client.mjs';

const canvas={width:640,height:480,toBlob:callback=>callback(new Blob(['photo'],{type:'image/jpeg'}))};
const result=()=>({image:{width:640,height:480},summary:'ok',observations:[{index:0,text:'813.7 A1',confidence:90,callNumber:{classification:'813.7'},bbox:{x:10,y:20,width:30,height:40}}],items:[{index:0,status:'wrong',confidence:.99,reason:'evidence'}]});
test('photo upload uses JPEG body, ephemeral access code and correct coordinates',async()=>{
  let sent;
  const answer=await inspectPhoto(canvas,{base:'https://jetson.example',accessCode:'code',fetcher:async(url,options)=>{sent={url,...options};return {ok:true,json:async()=>result()};}});
  assert.equal(sent.url,'https://jetson.example/api/inspect'); assert(sent.body instanceof Blob);
  assert.equal(sent.headers.Authorization,'Bearer code');assert.equal(answer.items[0].status,'wrong');
});
test('invalid coordinates rejected and weak AI evidence never red',async()=>{
  for(const bad of [r=>r.image.width=320,r=>r.observations[0].bbox.x=1000,r=>r.items.push(r.items[0])]){
    const data=result();bad(data);
    await assert.rejects(inspectPhoto(canvas,{fetcher:async()=>({ok:true,json:async()=>data})}));
  }
  const data=result();data.items[0].confidence=.6;
  const answer=await inspectPhoto(canvas,{fetcher:async()=>({ok:true,json:async()=>data})});
  assert.equal(answer.items[0].status,'uncertain');
});
test('reject insecure endpoints and propagate authorization failures',async()=>{
  for(const base of ['http://192.168.0.2','https://user:secret@host','https://host/path','javascript:alert(1)']) assert.throws(()=>serverURL(base,'/api/inspect'));
  assert.equal(serverURL('','/api/inspect'),'/api/inspect');
  await assert.rejects(inspectPhoto(canvas,{fetcher:async()=>({ok:false,status:401,json:async()=>({error:'access denied'})})}),/access denied/);
});
