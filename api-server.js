const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8081;

// CORS pour toutes les origines
app.use(cors());
app.use(express.json());

// Routes de diagnostic
app.get('/', (req, res) => {
  res.json({ message: 'TCE API', version: '1.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/today', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json({ today });
});

// Mock endpoints pour développement
app.get('/api/services', (req, res) => {
  res.json([]);
});

app.get('/api/lignes', (req, res) => {
  res.json([]);
});

app.get('/api/conducteurs', (req, res) => {
  res.json([]);
});

app.get('/api/vehicles', (req, res) => {
  res.json([]);
});

app.listen(PORT, () => {
  console.log(`API Server running on http://localhost:${PORT}`);
});
