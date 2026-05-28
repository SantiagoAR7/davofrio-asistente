/**
 * Script de autenticación OAuth2 con Google Drive
 * Ejecuta: node scripts/auth-drive.js
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');

// Credenciales OAuth2 de Google Cloud Console
// Crea un proyecto en https://console.cloud.google.com
// Habilita Drive API → Credenciales → OAuth 2.0 → Aplicación de escritorio
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '363962271835-8tgevb8mlab5st0qm4hdu3kmcgljopkq.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';
const REDIRECT_URI = 'http://localhost';

const TOKEN_PATH = path.join(__dirname, '../data/drive_token.json');
fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive.readonly'],
});

console.log('\n🔐 AUTENTICACIÓN GOOGLE DRIVE - DAVOFRIO\n');
console.log('1. Abre esta URL en el navegador:');
console.log('\n' + authUrl + '\n');
console.log('2. Autoriza el acceso con la cuenta de Google que tiene los manuales');
console.log('3. Copia el código que aparece y pégalo aquí:\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Código de autorización: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('\n✅ Token guardado en data/drive_token.json');
    console.log('   Ya puedes arrancar el servidor: npm start\n');
  } catch (e) {
    console.error('\n❌ Error:', e.message);
    console.log('   Asegúrate de pegar el código completo y sin espacios\n');
  }
});
