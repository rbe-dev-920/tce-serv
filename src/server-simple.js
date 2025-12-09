// backend/src/server-simple.js
// Version minimale pour diagnostiquer les problèmes
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8081;
const HOST = '0.0.0.0';

console.log('[INIT] Starting Express app...');

// CORS simple
app.use(cors());
app.use(express.json());

console.log('[INIT] CORS and JSON middleware added...');

// Routes basiques
app.get('/', (req, res) => {
  res.send('TC Outil API - Voyages TC Essonnes');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/today', (req, res) => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const today = `${year}-${month}-${day}`;
  
  res.json({ today });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`🚀 TC Outil - API running on http://${HOST}:${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📝 NODE_ENV=${process.env.NODE_ENV}`);
  console.log(`🔌 PORT=${PORT}`);
});
