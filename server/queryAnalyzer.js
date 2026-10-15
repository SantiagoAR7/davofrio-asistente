const BRANDS = [
  'DAIKIN',
  'LG',
  'HITACHI',
  'MITSUBISHI ELECTRIC',
  'MITSUBISHI DAYA',
  'SAMSUNG',
  'PANASONIC',
  'BOSCH',
  'HISENSE',
  'HAIER',
  'ATLANTIC',
  'MUNDOCLIMA',
  'MUDOCLIMA',
  'ECOFOREST',
  'BLUEBOX',
  'HTW',
  'KAYSUN',
  'DAITSU',
  'MIDEA',
  'HITECSA',
  'SIEMENS',
  'VIESSMANN',
  'SYSTEMAIR',
  'SIBER',
  'SWEGON',
  'FORCALI',
  'SAIVOD',
  'AIRWELL',
  'FRIGICOLL',
  'CLIVET',
  'TECNA',
  'AIRZONE'
];

function cleanText(value) {
  return (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function normalizeUpper(value) {
  return cleanText(value).toUpperCase();
}

function detectBrand(query) {
  const q = normalizeUpper(query);

  for (const brand of BRANDS) {
    if (new RegExp('(?:^|[^A-Z0-9])' + brand + '(?=$|[^A-Z0-9])').test(q)) return brand === 'MUDOCLIMA' ? 'MUNDOCLIMA' : brand;
  }

  return null;
}

function detectErrorCodes(query) {
  const q = normalizeUpper(query);

  const matches = q.match(/\b[A-Z]{1,2}[-_ ]?\d{1,3}\b/g) || [];
  return [...new Set(matches.map(c => c.replace(/[-_ ]/g, '')))]
    .filter(c => !/^(R22|R32|R134|R407|R410|IP\d+)$/.test(c));
}

function detectModels(query, brand = null) {
  const q = normalizeUpper(query);

  const candidates = q.match(/\b[A-Z]{2,8}[-_]?[A-Z0-9]{2,12}[-_]?[A-Z0-9]{0,12}\b/g) || [];

  const blacklist = new Set([
    'ERROR',
    'AVERIA',
    'AVERIAS',
    'FALLO',
    'FALLA',
    'CODIGO',
    'CODIGOS',
    'MANUAL',
    'TECNICO',
    'TECNICA',
    'SERVICIO',
    'INSTALACION',
    'CONFIGURACION',
    'TIPO',
    'GAS',
    'MODELO',
    'ESTANCO',
    'CALENTADOR',
    'NO',
    'ARRANCA',
    'ENCIENDE',
    'VENTILADOR'
  ]);

  const models = candidates
    .filter(x => !blacklist.has(x))
    .filter(x => !brand || x !== brand)
    .filter(x => /\d/.test(x))
    .filter(x => !/^[A-Z]{1,2}[-_]?\d{1,3}$/.test(x));

  return [...new Set(models)];
}

function tokenize(query) {
  return cleanText(query)
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function detectEquipmentType(query) {
  const q = normalizeUpper(query);

  if (
    q.includes('CALENTADOR') ||
    q.includes('LOW NOX') ||
    q.includes('LOWNOX') ||
    q.includes('HTWCL') ||
    q.includes('HTW-CLE')
  ) {
    return 'calentador';
  }

  if (
    q.includes('FANCOIL') ||
    q.includes('FAN COIL') ||
    q.includes('FAN-COIL')
  ) {
    return 'fancoil';
  }

  if (
    q.includes('CHILLER') ||
    q.includes('ENFRIADORA') ||
    q.includes('ENFRIADORAS')
  ) {
    return 'chiller';
  }

  if (
    q.includes('AEROTERMIA') ||
    q.includes('AQUAREA') ||
    q.includes('ALTHERMA') ||
    q.includes('THERMAL')
  ) {
    return 'aerotermia';
  }

  if (/CALDERA|BOILER/.test(q)) return 'caldera';
  if (/SPLIT|SKY AIR|SKYAIR|CASSETTE|CONDUCTOS|MURAL/.test(q)) return 'split';

  if (
    q.includes('VRF') ||
    q.includes('VRV') ||
    q.includes('MULTI')
  ) {
    return 'vrf';
  }

  return null;
}

function analyzeQuery(query) {
  const brand = detectBrand(query);
  const errorCodes = detectErrorCodes(query);
  const models = detectModels(query, brand);
  const equipmentType = detectEquipmentType(query);

  return {
    originalQuery: query,
    normalizedQuery: normalizeUpper(query),
    brand,
    model: models[0] || null,
    models,
    errorCode: errorCodes[0] || null,
    errorCodes,
    equipmentType,
    tokens: tokenize(query)
  };
}

function detectDocumentBrand(pdf) {
  const nameBrand = detectBrand(pdf.name || '');
  if (nameBrand) return nameBrand;
  const folders = (pdf.folderPath || '').split('/').reverse();
  for (const folder of folders) {
    if (/OTRAS MARCAS|VARIAS MARCAS/i.test(folder)) continue;
    const brand = detectBrand(folder);
    if (brand) return brand;
  }
  return 'DESCONOCIDA';
}

module.exports = {
  BRANDS, detectDocumentBrand,
  analyzeQuery,
  detectBrand,
  detectErrorCodes,
  detectModels,
  normalizeUpper,
  detectEquipmentType
};