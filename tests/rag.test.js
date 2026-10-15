const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {createRequire}=require('module');
function load(file,mocks={},extras={}) {
  const filename=path.resolve(__dirname,'../server',file);
  const realRequire=createRequire(filename);
  const context={require:n=>Object.hasOwn(mocks,n)?mocks[n]:realRequire(n),module:{exports:{}},exports:{},__dirname:path.dirname(filename),console,process:{env:{OPENAI_API_KEY:'test',SESSION_SECRET:'test-secret-at-least-24-characters',SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test'}},Buffer,URLSearchParams,AbortSignal,setTimeout,clearTimeout,...extras};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});return context.module.exports;
}
const {chunkText,tokenCount}=require('../server/chunker');
test('long paragraphs never exceed the token budget and preserve all text',()=>{
  const input='Medir temperatura y comprobar el equipo. '.repeat(2000).trim();
  const chunks=chunkText(input,{fileId:'test'},{maxTokens:350,overlapTokens:0});
  assert(chunks.length>10);assert(chunks.every(c=>c.tokens<=350));assert.equal(chunks.map(c=>c.content).join(''),input);
});
test('unicode survives token boundaries',()=>{
  const input='🧊 refrigeración 日本語 presión 12°C '.repeat(100).trim();
  const chunks=chunkText(input,{}, {maxTokens:17,overlapTokens:0});assert.equal(chunks.map(c=>c.content).join(''),input);assert(chunks.every(c=>tokenCount(c.content)<=17));
});
test('overlap bounded and deterministic IDs',()=>{
  const chunks=chunkText('palabra '.repeat(500),{fileId:'a'},{maxTokens:30,overlapTokens:10});
  assert.equal(chunks[0].id,'a_0');assert.equal(chunks[1].metadata.tokenStart,20);assert(chunks.every(c=>c.tokens<=30));
});
test('invalid overlap is rejected; empty input has no chunks',()=>{
  assert.throws(()=>chunkText('a',{}, {maxTokens:10,overlapTokens:10}),RangeError);assert.deepEqual(chunkText(''),[]);
});
const analyzer=require('../server/queryAnalyzer');
test('brand boundaries prevent LG in unrelated words',()=>{assert.equal(analyzer.detectBrand('algo falla'),null);assert.equal(analyzer.detectBrand('LG CH05'),'LG');});
test('models and refrigerants are not error codes',()=>{
  assert.equal(analyzer.analyzeQuery('HTW HTWCL12 E1').errorCode,'E1');assert.equal(analyzer.analyzeQuery('Daikin R32').errorCode,null);
  assert.equal(analyzer.analyzeQuery('Daikin U4').model,null);
});
test('spaced and hyphenated error codes normalize',()=>{assert.equal(analyzer.analyzeQuery('LG CH-05').errorCode,'CH05');assert.equal(analyzer.analyzeQuery('HTW E 1').errorCode,'E1');});
test('gas alone does not classify equipment as a water heater',()=>assert.equal(analyzer.detectEquipmentType('Daikin fuga de gas'),null));
const clientMock={'dotenv':{config(){}},'openai':{OpenAI:class{}},'@supabase/supabase-js':{createClient(){return {}}}};
const {normalizeResults}=load('supabaseVectorStore.js',clientMock);
const row=(id,content='E1 fallo')=>({id,file_id:'f',file_name:'Manual',brand:'HTW',chunk_index:id,content,score:0.8});
test('literal/vector duplicate does not displace distinct evidence',()=>{
  const r=normalizeResults([row(1),row(1),row(2,'E1 segunda evidencia')],'HTW',{errorCode:'E1'});assert.equal(r.length,2);assert.equal(r[0].chunk.id,1);
});
test('brand filter rejects wrong manufacturer',()=>assert.equal(normalizeResults([row(1)],'DAIKIN').length,0));
const baseMocks={'dotenv':{config(){}},'openai':{OpenAI:class{}},'./supabaseHybridRetriever':{hybridSearch:async()=>[]}};
const {selectEvidence}=load('rag.js',baseMocks);
const result=content=>({score:0.9,rawScore:0.8,chunk:{content,metadata:{brand:'HTW',fileName:'Manual'}}});
test('E1 is not E10, E11 or an unrelated code',()=>{assert.equal(selectEvidence([result('E10 fallo')],'HTW E1').length,0);assert.equal(selectEvidence([result('E1 fallo')],'HTW E1').length,1);});
test('model mismatch and wrong brand fail closed',()=>{
  assert.equal(selectEvidence([result('E1')],'HTW E1',{modelName:'HTWCL12'}).length,0);
  assert.equal(selectEvidence([result('E1')],'Daikin E1').length,0);
});
test('no evidence skips generation entirely',async()=>{
  const {answerWithRAG}=load('rag.js',baseMocks);const r=await answerWithRAG('HTW E999');assert.equal(r.evidenceStatus,'insufficient');assert.equal(r.sources.length,0);
});
test('OT, previous solutions and conversation reach the single generation',async()=>{
  let calls=0,prompt;
  const {answerWithRAG}=load('rag.js',{...baseMocks,
    './supabaseHybridRetriever':{hybridSearch:async()=>[result('E1 fallo documentado')]},
    'openai':{OpenAI:class{constructor(){this.chat={completions:{create:async args=>{calls++;prompt=JSON.stringify(args);return {choices:[{message:{content:'<p>Respuesta [1]</p>'}}]}}}}}}}});
  const answer=await answerWithRAG('HTW E1',{otContext:'OT_SENTINEL',pastSolutions:[{solution:'SOLUTION_SENTINEL'}],history:[{role:'user',content:'HISTORY_SENTINEL'}]});
  assert.equal(calls,1);for(const s of ['OT_SENTINEL','SOLUTION_SENTINEL','HISTORY_SENTINEL'])assert(prompt.includes(s));assert.equal(answer.sources.length,1);
});
test('corrupt JSON is never overwritten',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davo-db-'));const file=path.join(dir,'db.json');fs.writeFileSync(file,'broken');
  const db=load('db.js',{}, {process:{env:{DATA_DIR:dir}}});assert.throws(()=>db.load());assert.equal(fs.readFileSync(file,'utf8'),'broken');fs.rmSync(dir,{recursive:true});
});
test('atomic JSON save leaves valid data and no temporary file',()=>{
  const {writeJson}=require('../server/jsonStore');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davo-json-'));const file=path.join(dir,'data.json');writeJson(file,{a:1});writeJson(file,{a:2});assert.deepEqual(JSON.parse(fs.readFileSync(file)),{a:2});assert.equal(fs.readdirSync(dir).length,1);fs.rmSync(dir,{recursive:true});
});
test('OneDrive follows pagination and propagates listing errors',async()=>{
  const responses=[{access_token:'test',expires_in:3600},{value:[{id:'a',name:'a.pdf',file:{}}],'@odata.nextLink':'https://graph.microsoft.com/next'},{value:[{id:'b',name:'b.pdf',file:{}}]}];let calls=0;
  const drive=load('onedrive.js',{}, {process:{env:{AZURE_TENANT_ID:'t',AZURE_CLIENT_ID:'c',AZURE_CLIENT_SECRET:'s',ONEDRIVE_USER:'u'}},fetch:async()=>({ok:true,json:async()=>responses[calls++]})});
  assert.equal((await drive.listPDFsRecursive('docs')).length,2);assert.equal(calls,3);
});
test('PDF extraction OCRs page 21 and cleans temporary files',async()=>{
  let ocr=0;let created;
  const realFs=require('fs/promises');
  const run=async(cmd,args)=>{
    if(cmd==='pdftotext')return {stdout:Array.from({length:21},(_,i)=>i===20?'':'Texto técnico extenso de un manual. '.repeat(15)).join('\f')+'\f'};
    if(cmd==='pdftoppm'){assert(args.includes('21'));return {stdout:''};}
    if(cmd==='tesseract'){ocr++;return {stdout:'E1 Diagnóstico página final '.repeat(20)};}
    throw new Error(cmd);
  };
  const extractor=load('pdfExtractor.js',{'util':{promisify:()=>run},'fs/promises':{...realFs,mkdtemp:async p=>{created=await realFs.mkdtemp(p);return created;}}});
  const r=await extractor.extractPDFText(Buffer.from('mock'));assert.equal(ocr,1);assert.equal(r.pages,21);assert(r.text.includes('página final'));assert.equal(fs.existsSync(created),false);
});
test('indexing failure before upload preserves existing remote file',async()=>{
  let calls=0;
  const indexer=load('build-rag-supabase.js',{'dotenv':{config(){}},'./onedrive':{downloadPDF:async()=>{throw new Error('network');}},'./vectorStore':{embedTexts:async()=>[]},'./supabaseVectorStore':{supabase:{rpc:async()=>{calls++;return {};}}}});
  await assert.rejects(indexer.indexOnePDF({id:'f',name:'test.pdf',size:1},1,1));assert.equal(calls,0);
});
test('complete embeddings are prepared before one atomic replacement',async()=>{
  const calls=[];
  const indexer=load('build-rag-supabase.js',{'dotenv':{config(){}},'./onedrive':{downloadPDF:async()=>Buffer.from('pdf')},'./pdfExtractor':{extractPDFText:async()=>({text:'E1 fallo '.repeat(100),chars:900,complete:true})},'./vectorStore':{embedTexts:async texts=>{calls.push('embed');return texts.map(()=>[0.1,0.2]);}},'./supabaseVectorStore':{supabase:{rpc:async(name,args)=>{calls.push(name);assert(args.p_rows.length);return {data:args.p_rows.length};}}}});
  await indexer.indexOnePDF({id:'f',name:'HTW.pdf',size:1},1,1);assert.equal(calls.at(-1),'replace_rag_file');assert.equal(calls.filter(x=>x==='replace_rag_file').length,1);
});

test('generic brand folders do not mislabel unrelated manuals',()=>{
 assert.equal(analyzer.detectDocumentBrand({name:'Manual.pdf',folderPath:'Documentos/_HTW Y OTRAS MARCAS/Equipo'}),'DESCONOCIDA');
 assert.equal(analyzer.detectDocumentBrand({name:'Panasonic.pdf',folderPath:'Documentos/_HTW Y OTRAS MARCAS'}),'PANASONIC');
});
test('model preceding the fault does not become the error code',()=>{const a=analyzer.analyzeQuery('Daikin RXM35 U4');assert.equal(a.errorCode,'U4');assert.equal(a.model,'RXM35');});
test('selected equipment family rejects other families',()=>{const r=result('E1');r.chunk.metadata.fileName='Chiller servicio';assert.equal(selectEvidence([r],'HTW calentador E1').length,0);});
test('different equipment families trigger clarification without generation',async()=>{
 const a=result('E1'),b=result('E1');a.chunk.metadata.fileName='Calentador servicio';b.chunk.metadata.fileName='Split servicio';
 const {answerWithRAG}=load('rag.js',{...baseMocks,'./supabaseHybridRetriever':{hybridSearch:async()=>[a,b]}});
 assert.equal((await answerWithRAG('HTW E1')).evidenceStatus,'ambiguous');
});
