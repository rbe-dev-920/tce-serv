const http = require('http');

const PORT = process.env.PORT || 8081;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Routes
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok'}));
  } else if (req.url === '/api/today') {
    const today = new Date().toISOString().split('T')[0];
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({today}));
  } else if (req.url === '/api/services' || req.url === '/api/lignes' || req.url === '/api/conducteurs' || req.url === '/api/vehicles') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify([]));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP Server listening on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
