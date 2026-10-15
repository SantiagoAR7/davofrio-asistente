const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const ONEDRIVE_USER = process.env.ONEDRIVE_USER;

const ONEDRIVE_FOLDERS = [
  'DAVOFRIO/Documentacion tecnica',
  'DAVOFRIO/DocumtecnPremium'
];

let accessToken = null;
let tokenExpiresAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertConfig() {
  const missing = [];
  if (!TENANT_ID) missing.push('AZURE_TENANT_ID');
  if (!CLIENT_ID) missing.push('AZURE_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('AZURE_CLIENT_SECRET');
  if (!ONEDRIVE_USER) missing.push('ONEDRIVE_USER');
  if (missing.length) throw new Error('Faltan variables .env: ' + missing.join(', '));
}

async function getAccessToken() {
  assertConfig();

  if (accessToken && Date.now() < tokenExpiresAt - 300000) return accessToken;

  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default'
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) throw new Error('Error token Microsoft Graph: ' + await res.text());

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return accessToken;
}

async function graphGet(url, retries = 4) {
  const token = await getAccessToken();

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(60000)
  });

  if ([429, 500, 502, 503, 504].includes(res.status) && retries > 0) {
    const retryAfter = Number(res.headers.get('Retry-After') || 30);
    await sleep((retryAfter + 2) * 1000);
    return graphGet(url, retries - 1);
  }

  if (!res.ok) throw new Error(`Graph GET ${res.status}: ${await res.text()}`);

  return res.json();
}

async function graphDownload(url, retries = 4) {
  const token = await getAccessToken();

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000)
  });

  if ([429, 500, 502, 503, 504].includes(res.status) && retries > 0) {
    const retryAfter = Number(res.headers.get('Retry-After') || 30);
    await sleep((retryAfter + 2) * 1000);
    return graphDownload(url, retries - 1);
  }

  if (!res.ok) throw new Error(`Graph DOWNLOAD ${res.status}: ${await res.text()}`);

  return Buffer.from(await res.arrayBuffer());
}

function encodeDrivePath(folderPath) {
  return folderPath.split('/').map(encodeURIComponent).join('/');
}

async function listChildren(folderPath) {
  const encodedPath = encodeDrivePath(folderPath);

  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ONEDRIVE_USER)}` +
    `/drive/root:/${encodedPath}:/children` +
    `?$select=id,name,size,lastModifiedDateTime,file,folder,parentReference,webUrl` +
    `&$top=200`;

  return graphGet(url);
}

async function listPDFsRecursive(folderPath, onProgress, options = {}) {
  const limit = options.limit || Infinity;
  const pdfs = [];

  async function walk(currentPath) {
    if (pdfs.length >= limit) return;

    let data = await listChildren(currentPath);
    do {
    for (const item of data.value || []) {
      if (pdfs.length >= limit) return;

      if (item.file && item.name.toLowerCase().endsWith('.pdf')) {
        pdfs.push({
          id: item.id,
          name: item.name,
          size: item.size || 0,
          lastModifiedDateTime: item.lastModifiedDateTime,
          webUrl: item.webUrl,
          folderPath: currentPath
        });

        if (onProgress) onProgress(`[${pdfs.length}/${limit}] ${item.name}`);
      }

      if (item.folder) {
        await walk(`${currentPath}/${item.name}`);
      }

    }
    data = data['@odata.nextLink'] ? await graphGet(data['@odata.nextLink']) : null;
    } while (data && pdfs.length < limit);
  }

  await walk(folderPath);
  return pdfs;
}

async function listLimitedPDFs(folderPath, limit = 20, onProgress) {
  return listPDFsRecursive(folderPath, onProgress, { limit });
}

async function listAllPDFs(onProgress) {
  assertConfig();

  const all = [];

  for (const folder of ONEDRIVE_FOLDERS) {
    if (onProgress) onProgress(`Explorando OneDrive: ${folder}`);
    const found = await listPDFsRecursive(folder, onProgress);
    if (onProgress) onProgress(`Encontrados ${found.length} PDFs en ${folder}`);
    all.push(...found);
  }

  return all;
}

async function downloadPDF(itemId) {
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ONEDRIVE_USER)}` +
    `/drive/items/${encodeURIComponent(itemId)}/content`;

  return graphDownload(url);
}

module.exports = {
  listAllPDFs,
  listLimitedPDFs,
  downloadPDF, listPDFsRecursive
};