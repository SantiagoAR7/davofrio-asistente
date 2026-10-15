require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { tokenCount } = require('../server/chunker');
function audit(chunks) {
  const stats = {count:chunks.length,over350:0,over8191:0,empty:0,unknownBrand:0,duplicateIds:0,tokenMetadataMismatch:0,maxTokens:0,byBrand:{}};
  const ids = new Set();
  for (const c of chunks) {
    const n = tokenCount(c.content || '');
    stats.maxTokens=Math.max(stats.maxTokens,n); if(n>350)stats.over350++;if(n>8191)stats.over8191++;if(!n)stats.empty++;
    if (n!==c.tokens)stats.tokenMetadataMismatch++;
    if (ids.has(c.id))stats.duplicateIds++;ids.add(c.id);
    const brand=c.brand||c.metadata?.brand||'DESCONOCIDA';if(brand==='DESCONOCIDA')stats.unknownBrand++;
    stats.byBrand[brand]=(stats.byBrand[brand]||0)+1;
  }
  return stats;
}
async function main() {
  const report = {at:new Date().toISOString(),local:audit(JSON.parse(fs.readFileSync(path.join(__dirname,'../data/rag_chunks.json'))))};
  if(process.argv.includes('--live')){
    const {supabase}=require('../server/supabaseVectorStore');
    const count=await supabase.from('rag_chunks').select('id',{count:'estimated',head:true});if(count.error)report.countError=count.error.message;
    report.remoteCount=count.count;const sample=[];
    let cursor=null;
    for(let page=0;page<3;page++) {
      let request=supabase.from('rag_chunks').select('id,file_id,content,tokens,brand').order('id').limit(300);
      if(cursor)request=request.gt('id',cursor);
      const {data,error}=await request;
      if(error){report.sampleError=error.message;break;}sample.push(...data);
      if(data.length<300)break;cursor=data.at(-1).id;
    }
    report.remoteSample=audit(sample);report.remoteSample.note='Primeros 900 registros ordenados por ID; no representa estadísticamente toda la base';
    const {searchSupabaseVector}=require('../server/supabaseVectorStore');
    const {selectEvidence,answerWithRAG}=require('../server/rag');
    report.retrieval=[];
    for(const query of ['HTW E1 no arranca','Daikin U4 comunicación','Panasonic F35','HTW E999 avería']) {
      try {const results=await searchSupabaseVector(query,{topK:12});const evidence=selectEvidence(results,query);
        report.retrieval.push({query,candidates:results.length,evidence:evidence.length,files:evidence.map(r=>({file:r.chunk.metadata.fileName,brand:r.chunk.metadata.brand,score:r.score,rawScore:r.rawScore}))});
      }catch(e){report.retrieval.push({query,error:e.message})}
    }
    try{const result=await answerWithRAG('Daikin U4 comunicación');report.answerCheck={evidenceStatus:result.evidenceStatus,sources:result.sources,answer:result.answer};}catch(e){report.answerCheck={error:e.message}}
  }
  fs.mkdirSync(path.join(__dirname,'../validation'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../validation/rag-audit.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={audit};
