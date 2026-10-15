require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const { analyzeQuery } = require('./queryAnalyzer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error('Falta SUPABASE_URL en .env');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY en .env');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function normalizeBrand(value) {
  return (value || '').toString().trim().toUpperCase().replace('MUDOCLIMA', 'MUNDOCLIMA');
}

async function embedQuery(query) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query
  });

  return res.data[0].embedding;
}

async function upsertChunks(rows) {
  if (!rows.length) return { count: 0 };

  const { error } = await supabase
    .from('rag_chunks')
    .upsert(rows, { onConflict: 'id' });

  if (error) throw error;

  return { count: rows.length };
}

async function deleteFileChunks(fileId) {
  const { error } = await supabase
    .from('rag_chunks')
    .delete()
    .eq('file_id', fileId);

  if (error) throw error;
}

function documentTypeBonus(documentType) {
  const bonuses = {
    boletin_sat: 0.10,
    lista_errores: 0.09,
    manual_servicio: 0.08,
    manual_tecnico: 0.07,
    manual_instalacion: 0.05,
    diagnostico: 0.05,
    procedimiento: 0.04,
    manual_usuario: 0.01,
    otro_tecnico: 0
  };

  return bonuses[documentType] || 0;
}

function equipmentBonusFor(text, equipmentType) {
  if (!equipmentType) return 0;

  const keywords = {
    calentador: ['CALENTADOR', 'LOW NOX', 'LOWNOX', 'HTWCL', 'HTW-CLE', 'ACS', 'GAS', 'ESTANCO'],
    fancoil: ['FANCOIL', 'FAN COIL'],
    chiller: ['CHILLER', 'ENFRIADORA', 'ENFRIADORAS'],
    aerotermia: ['AEROTERMIA', 'ALTHERMA', 'AQUAREA', 'THERMAL'],
    vrf: ['VRF', 'VRV']
  };

  const words = keywords[equipmentType] || [];
  return words.some(w => text.includes(w)) ? 0.30 : 0;
}

function oppositeEquipmentPenaltyFor(text, equipmentType) {
  if (!equipmentType) return 0;

  const oppositeKeywords = {
    calentador: ['CHILLER', 'ENFRIADORA', 'ENFRIADORAS', 'FANCOIL', 'FAN COIL', 'VRF', 'VRV'],
    fancoil: ['CALENTADOR', 'LOW NOX', 'LOWNOX', 'HTWCL', 'HTW-CLE'],
    chiller: ['CALENTADOR', 'LOW NOX', 'LOWNOX', 'HTWCL', 'HTW-CLE'],
    aerotermia: ['CALENTADOR', 'CHILLER', 'FANCOIL', 'FAN COIL'],
    vrf: ['CALENTADOR', 'LOW NOX', 'LOWNOX', 'HTWCL', 'HTW-CLE']
  };

  const words = oppositeKeywords[equipmentType] || [];
  return words.some(w => text.includes(w)) ? -0.50 : 0;
}

function wrongErrorPenaltyFor(fileName, analysis) {
  if (!analysis.errorCode) return 0;

  const file = `${fileName || ''}`.toUpperCase();
  const errorsInFile = file.match(/\bE\d{1,3}\b/g);

  if (!errorsInFile || !errorsInFile.length) return 0;
  if (errorsInFile.includes(analysis.errorCode)) return 0;

  return -0.45;
}

function documentNoisePenaltyFor(fileName, content, query) {
  const file = `${fileName || ''}`.toUpperCase();
  const text = `${content || ''}`.toUpperCase();
  const q = `${query || ''}`.toUpperCase();

  const asksForParts =
    q.includes('RECAMBIO') ||
    q.includes('RECAMBIOS') ||
    q.includes('PIEZA') ||
    q.includes('PIEZAS') ||
    q.includes('DESPIECE') ||
    q.includes('TARIFA') ||
    q.includes('PRECIO') ||
    q.includes('REFERENCIA');

  if (asksForParts) return 0;

  const noisy =
    file.includes('TARIFA') ||
    file.includes('DESPIECE') ||
    file.includes('PRECIO') ||
    file.includes('RECAMBIO') ||
    text.includes('PRECIO') ||
    text.includes('€');

  return noisy ? -0.35 : 0;
}

function normalizeResults(data, expectedBrand = null, analysis = {}) {
  let rows = [...new Map((data || []).map(row => [`${row.brand}|${row.content}`, row])).values()];

  if (expectedBrand) {
    const expected = normalizeBrand(expectedBrand);
    rows = rows.filter(row => normalizeBrand(row.brand) === expected);
  }

  return rows
    .map(row => {
      const baseScore = Number(row.score || 0);
      const typeBonus = documentTypeBonus(row.document_type);
      const priorityBonus = Math.min(Number(row.rag_priority || 0) / 1000, 0.10);

      const fileName = row.file_name || '';
      const content = row.content || '';
      const haystack = `${fileName} ${content}`.toUpperCase();

      const equipmentBonus = equipmentBonusFor(haystack, analysis.equipmentType);

      const oppositeEquipmentPenalty = oppositeEquipmentPenaltyFor(
  haystack,
  analysis.equipmentType
);

      let modelBonus = 0;
      if (analysis.models?.some(m => haystack.includes(m))) {
        modelBonus = 0.20;
      }

      let errorBonus = 0;
      if (analysis.errorCodes?.some(c => haystack.includes(c))) {
        errorBonus = 0.15;
      }

      if (analysis.errorCodes?.some(c => fileName.toUpperCase().includes(c))) {
        errorBonus += 0.35;
      }

      const wrongErrorPenalty = wrongErrorPenaltyFor(fileName, analysis);

      const documentNoisePenalty = documentNoisePenaltyFor(
        fileName,
        content,
        analysis.originalQuery
      );

      const finalScore =
        baseScore +
        typeBonus +
        priorityBonus +
        modelBonus +
        errorBonus +
        equipmentBonus +
        wrongErrorPenalty +
        documentNoisePenalty +
  oppositeEquipmentPenalty;

      return {
        score: finalScore,
        rawScore: baseScore,
        exactCode: !!analysis.errorCode && new RegExp('(?:^|[^A-Z0-9])' + analysis.errorCode.replace(/([A-Z]+)([0-9]+)/, '$1[-_ ]?$2') + '(?=$|[^A-Z0-9])').test(haystack),

        chunk: {
          id: row.id,
          content,

          metadata: {
            fileId: row.file_id,
            chunkIndex: row.chunk_index,
            webUrl: row.web_url,
            fileName: row.file_name,
            brand: row.brand,
            documentType: row.document_type || 'otro_tecnico',
            ragPriority: row.rag_priority || 0,
            folderPath: row.folder_path,
            method: row.method,
            readable: row.readable
          }
        }
      };
    })
    .sort((a, b) => b.score - a.score)
    .filter((result, index, arr) => {
      const fileName = result.chunk.metadata.fileId || result.chunk.metadata.fileName;
      const sameFileBefore = arr
        .slice(0, index)
        .filter(r => (r.chunk.metadata.fileId || r.chunk.metadata.fileName) === fileName)
        .length;

      return sameFileBefore < 2;
    });
}

async function runVectorSearch({ embedding, topK, brand }) {
  const { data, error } = await supabase.rpc('match_rag_chunks_brand', {
    p_query_embedding: embedding,
    p_match_count: topK,
    p_filter_brand: brand
  });

  if (error) throw error;

  return data || [];
}

async function runCodeSearch({ errorCode, topK, brand }) {
  if (!errorCode || !brand) return [];
  // The old RPC misses codes present in content. Search content as well as filenames.
  const variants = [errorCode,errorCode.replace(/([A-Z]+)([0-9]+)/,'$1-$2'),errorCode.replace(/([A-Z]+)([0-9]+)/,'$1 $2')];
  const columns = 'id,file_id,file_name,folder_path,brand,web_url,chunk_index,content,document_type,rag_priority,method,readable';
  const responses = await Promise.all([
    supabase.from('rag_chunks').select(columns).eq('brand',brand).or(variants.map(code=>'content.ilike.%'+code+'%').join(',')).limit(200),
    supabase.from('rag_chunks').select(columns).eq('brand',brand).ilike('file_name','%'+errorCode+'%').limit(60),
    supabase.rpc('match_rag_chunks_code_brand',{p_error_code:errorCode,p_filter_brand:brand,p_match_count:Math.max(topK,12)})
  ]);
  const matcher = new RegExp('(?:^|[^A-Z0-9])' + errorCode.replace(/([A-Z]+)([0-9]+)/, '$1[-_ ]?$2') + '(?=$|[^A-Z0-9])');
  const rows=[];
  if (responses.every(r=>r.error)) throw new Error('Búsqueda literal no disponible: ' + responses[0].error.message);
  for (const response of responses) {
    if(response.error) { console.warn('Rama de búsqueda literal no disponible:', response.error.message); continue; }
    for(const row of response.data || []) {
      if(matcher.test(`${row.file_name} ${row.content}`.toUpperCase())) rows.push({...row,score:0.75});
    }
  }
  return rows; // Deduplicate and diversify only after ranking, not before.
}

async function searchSupabaseVector(query, options = {}) {
  const topK = options.topK || 10;
  const analysis = analyzeQuery(query);
  const brand = options.brand || analysis.brand || null;

  const embedding = await embedQuery(query);

  const codeData = await runCodeSearch({
  errorCode: analysis.errorCode,
  topK: Math.max(topK, 5),
  brand
});

const vectorData = await runVectorSearch({
  embedding,
  topK: Math.max(topK * 2, 8),
  brand
});

const merged = [...codeData, ...vectorData];

return normalizeResults(merged, brand, analysis).slice(0, topK);
}

module.exports = {
  supabase,
  upsertChunks,
  deleteFileChunks,
  searchSupabaseVector, normalizeResults
};