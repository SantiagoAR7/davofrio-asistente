require('dotenv').config();

const { searchSupabaseVector } = require('./supabaseVectorStore');

async function hybridSearch(query, options = {}) {
  const topK = options.topK || 12;

  const results = await searchSupabaseVector(query, {
    topK,
    brand: options.brand || null
  });

  return results
    .filter(r => r.score > (options.minScore || 0))
    .slice(0, topK);
}

module.exports = {
  hybridSearch
};