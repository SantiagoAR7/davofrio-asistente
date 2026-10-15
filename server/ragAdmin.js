const { supabase } = require('./supabaseVectorStore');
const { BRANDS } = require('./queryAnalyzer');
let job = { status: 'idle', processed: 0, indexed: 0, errors: 0 };
let statsCache;
async function getStatus() {
  if (!statsCache || Date.now() - statsCache.at > 60000) {
    const {data,error} = await supabase.rpc('rag_index_stats');
    if (error) {
      const result = await supabase.from('rag_chunks').select('id',{count:'estimated',head:true});
      if (result.error) throw result.error;
      statsCache = {at:Date.now(),data:{total:null,chunks:result.count,indexedAt:null,
        migrationRequired:true, brands:BRANDS.filter(b=>b!=='MUDOCLIMA').map(b=>({id:b,n:b,c:'#378ADD',count:null}))}};
    } else statsCache = {at:Date.now(),data};
  }
  return {...statsCache.data,backend:'supabase',job};
}
function startBuild() {
  if (job.status === 'running') return false;
  job = { status: 'running', startedAt: new Date().toISOString(), processed: 0, indexed: 0, errors: 0 };
  const { main } = require('./build-rag-supabase');
  main(progress => Object.assign(job, progress)).then(result => {
    Object.assign(job, result, {status: result.errors ? 'failed' : 'completed', finishedAt: new Date().toISOString()});
  }).catch(error => { Object.assign(job, {status:'failed', error:error.message, finishedAt:new Date().toISOString()}); });
  return true;
}
module.exports = { getStatus, startBuild };
