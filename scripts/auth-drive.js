const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET');

const TOKEN_PATH = path.join(__dirname, '../data/drive_token.json');
fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive.readonly'],
  prompt: 'consent'
});

console.log('\nAUTENTICACION GOOGLE DRIVE\n');
console.log('1. Abre esta URL en el navegador:\n');
console.log(authUrl);
console.log('\n2. Inicia sesion con juanantoniodavo079@gmail.com');
console.log('3. Acepta los permisos');
console.log('4. Google te mostrara un codigo en pantalla — copialo y pegalo aqui:\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Codigo: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('\nToken guardado correctamente.');
    console.log('Ahora reinicia el servidor y da Reconstruir indice.\n');
  } catch (e) {
    console.error('\nError: ' + e.message);
  }
});
