const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');const {JSDOM}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
function page(){return new JSDOM(html,{runScripts:'dangerously',url:'http://localhost',beforeParse(w){w.fetch=async()=>({ok:false,status:401,json:async()=>({error:'No autenticado'})});}});}
test('AI HTML sanitizer removes active content and all attributes',()=>{
 const dom=page(),w=dom.window;const cleaned=w.sanitizeAnswer('<p onclick="alert(1)">Texto<img src=x onerror="alert(1)"></p><svg onload="alert(1)"></svg><script>alert(1)</script><a href="javascript:alert(1)">enlace</a>');
 assert(!/onclick|onerror|javascript:|<script|<svg|<img/i.test(cleaned));assert(cleaned.includes('Texto'));dom.window.close();
});
test('user chat and stored OT fields escape malicious markup',()=>{
 const dom=page(),w=dom.window,payload='<img src=x onerror="alert(1)">';w.addU(payload);assert.equal(w.document.querySelectorAll('#msgs img').length,0);
 const output=w.renderOTList([{code:payload,brand:payload,model:payload,visits:[{type:'diagnostico',ts:'2026-09-24',techName:payload,errorCode:payload,resolution:payload}]}]);
 const container=w.document.createElement('div');container.innerHTML=output;assert.equal(container.querySelectorAll('img').length,0);dom.window.close();
});
test('stored history and solutions do not inject markup into admin',async()=>{
 const dom=page(),w=dom.window,payload='<img src=x onerror="alert(1)">';
 w.api=async()=>[{query:payload,name:payload,otCode:payload,brand:payload,modelName:payload,errorCode:payload,ts:'2026-09-24',techName:payload,code:payload,solution:payload,helpful:0}];
 const el=w.document.createElement('div');w.document.body.append(el);await w.renderHistory(el);assert.equal(el.querySelectorAll('img').length,0);await w.renderSolutions(el);assert.equal(el.querySelectorAll('img').length,0);dom.window.close();
});
test('resource URLs cannot run javascript',()=>{const dom=page(),w=dom.window;assert.equal(w.safeUrl('javascript:alert(1)'),'#');const output=w.renderResource({url:'javascript:alert(1)',title:'<img src=x>',brand:'HTW'});assert(!output.includes('javascript:'));assert(!output.includes('<img'));dom.window.close();});
