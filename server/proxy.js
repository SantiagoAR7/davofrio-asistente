const http = require('http');
const httpProxy = require('http-proxy');

const proxy = httpProxy.createProxyServer({});
const PORT = 8080;

const server = http.createServer((req, res) => {
  proxy.web(req, res, { target: 'http://localhost:3001' });
});

server.on('error', (err) => {
  console.error('Proxy error:', err);
});

server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`Forwarding to http://localhost:3001`);
});
