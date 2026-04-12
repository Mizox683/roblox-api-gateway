const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
app.use(express.json());
app.use(helmet());

const apiKeys = new Map();
const requestLog = [];

const DEMO_KEY = 'rblx_demo_' + crypto.randomBytes(16).toString('hex');
apiKeys.set(DEMO_KEY, {
  gameId: '1234567890',
  gameName: 'Demo Game',
  owner: 'DemoUser',
  createdAt: new Date().toISOString(),
  requests: 0,
  active: true,
});
console.log('\n🔑  DEMO API KEY:', DEMO_KEY, '\n');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Rate limit exceeded. Max 120 req/min.' },
});
app.use('/api/', limiter);

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!key) return res.status(401).json({ success: false, error: 'Missing API key.' });
  const meta = apiKeys.get(key);
  if (!meta) return res.status(403).json({ success: false, error: 'Invalid API key.' });
  if (!meta.active) return res.status(403).json({ success: false, error: 'API key revoked.' });
  req.apiKeyMeta = meta;
  req.apiKey = key;
  meta.requests++;
  requestLog.unshift({
    time: new Date().toISOString(),
    key: key.slice(0, 16) + '…',
    gameName: meta.gameName,
    method: req.method,
    path: req.path,
    ip: req.ip,
  });
  if (requestLog.length > 500) requestLog.pop();
  next();
}

app.get('/', (req, res) => {
  res.json({ service: 'Roblox API Gateway', status: 'online', version: '1.0.0' });
});

app.get('/api/docs', (req, res) => {
  res.json({
    authentication: 'Add header x-api-key: <your_key> to every request',
    endpoints: {
      'POST /api/keys/create': 'Create a new API key',
      'GET  /api/keys/validate': 'Check if your key is valid',
      'GET  /api/ping': 'Authenticated ping',
      'GET  /api/game/info': 'Return game metadata',
      'POST /api/game/data/set': 'Store a value',
      'GET  /api/game/data/get': 'Retrieve a value',
    },
  });
});

app.post('/api/keys/create', (req, res) => {
  const { gameId, gameName, owner } = req.body;
  if (!gameId || !gameName || !owner) {
    return res.status(400).json({ success: false, error: 'gameId, gameName, and owner are required.' });
  }
  const newKey = 'rblx_' + crypto.randomBytes(24).toString('hex');
  apiKeys.set(newKey, {
    gameId: String(gameId),
    gameName: String(gameName),
    owner: String(owner),
    createdAt: new Date().toISOString(),
    requests: 0,
    active: true,
  });
  res.status(201).json({ success: true, apiKey: newKey, message: 'Store this key safely.' });
});

app.get('/api/keys/validate', requireApiKey, (req, res) => {
  const { gameId, gameName, owner, createdAt, requests } = req.apiKeyMeta;
  res.json({ success: true, valid: true, gameId, gameName, owner, createdAt, requests });
});

app.delete('/api/keys/revoke', requireApiKey, (req, res) => {
  req.apiKeyMeta.active = false;
  res.json({ success: true, message: 'Key revoked.' });
});

app.get('/api/ping', requireApiKey, (req, res) => {
  res.json({ success: true, pong: true, game: req.apiKeyMeta.gameName, ts: Date.now() });
});

app.get('/api/game/info', requireApiKey, (req, res) => {
  const { gameId, gameName, owner, createdAt, requests } = req.apiKeyMeta;
  res.json({ success: true, gameId, gameName, owner, createdAt, totalRequests: requests });
});

const gameDataStore = new Map();

app.post('/api/game/data/set', requireApiKey, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ success: false, error: 'key is required.' });
  const gid = req.apiKeyMeta.gameId;
  if (!gameDataStore.has(gid)) gameDataStore.set(gid, new Map());
  gameDataStore.get(gid).set(String(key), value);
  res.json({ success: true, stored: { key, value } });
});

app.get('/api/game/data/get', requireApiKey, (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ success: false, error: 'key query param required.' });
  const gid = req.apiKeyMeta.gameId;
  const store = gameDataStore.get(gid);
  const value = store ? store.get(key) : undefined;
  if (value === undefined) return res.status(404).json({ success: false, error: 'Key not found.' });
  res.json({ success: true, key, value });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found. See /api/docs' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Roblox API Gateway running on port ${PORT}`));
