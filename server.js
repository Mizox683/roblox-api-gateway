// src/server.js  —  Roblox API Gateway with full logging & monitoring
const express    = require('express');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const Logger     = require('./logger');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(helmet());

// ─── In-memory stores ────────────────────────────────────────────────────
const apiKeys      = new Map();
const gameDataStore = new Map();

// ─── Performance tracker ──────────────────────────────────────────────────
const metrics = {
    totalRequests:    0,
    totalSaves:       0,
    totalLoads:       0,
    totalErrors:      0,
    totalAuthFails:   0,
    totalRateLimits:  0,
    totalFallbacks:   0,
    responseTimes:    [],   // last 1000 response times (ms)
    startTime:        Date.now(),
};

function recordResponseTime(ms) {
    metrics.responseTimes.push(ms);
    if (metrics.responseTimes.length > 1000) metrics.responseTimes.shift();
}

function avgResponseTime() {
    if (!metrics.responseTimes.length) return 0;
    const sum = metrics.responseTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / metrics.responseTimes.length);
}

function uptimeSeconds() {
    return Math.floor((Date.now() - metrics.startTime) / 1000);
}

// ─── Seed demo key ────────────────────────────────────────────────────────
const DEMO_KEY = 'rblx_demo_' + crypto.randomBytes(16).toString('hex');
apiKeys.set(DEMO_KEY, {
    gameId: '1234567890', gameName: 'Demo Game', owner: 'DemoUser',
    createdAt: new Date().toISOString(), requests: 0, active: true,
});
Logger.info('SYSTEM', 'Server started', { demoKey: DEMO_KEY });

// ─── Request logging middleware ───────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    metrics.totalRequests++;

    res.on('finish', () => {
        const ms = Date.now() - start;
        recordResponseTime(ms);

        const isError = res.statusCode >= 400;
        const logFn   = isError ? Logger.warn : Logger.info;

        logFn('REQUEST', req.method + ' ' + req.path, {
            method:     req.method,
            path:       req.path,
            status:     res.statusCode,
            latencyMs:  ms,
            ip:         req.ip,
            gameId:     req.apiKeyMeta?.gameId,
            gameName:   req.apiKeyMeta?.gameName,
        });

        if (isError) metrics.totalErrors++;
    });

    next();
});

// ─── Rate limiter ─────────────────────────────────────────────────────────
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        metrics.totalRateLimits++;
        Logger.warn('RATE_LIMIT', 'Rate limit hit', {
            ip:      req.ip,
            path:    req.path,
            gameId:  req.apiKeyMeta?.gameId,
        });
        res.status(429).json({ success: false, error: 'Rate limit exceeded. Max 120 req/min.' });
    },
});
app.use('/api/', limiter);

// ─── Auth middleware ──────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key  = req.headers['x-api-key'] || req.query.apiKey;

    if (!key) {
        metrics.totalAuthFails++;
        Logger.warn('AUTH', 'Missing API key', { ip: req.ip, path: req.path });
        return res.status(401).json({ success: false, error: 'Missing API key. Send header: x-api-key' });
    }

    const meta = apiKeys.get(key);

    if (!meta) {
        metrics.totalAuthFails++;
        Logger.warn('AUTH', 'Invalid API key', {
            ip:      req.ip,
            path:    req.path,
            keyHint: key.slice(0, 12) + '...',
        });
        return res.status(403).json({ success: false, error: 'Invalid API key.' });
    }

    if (!meta.active) {
        metrics.totalAuthFails++;
        Logger.warn('AUTH', 'Revoked API key used', {
            ip:       req.ip,
            gameName: meta.gameName,
            gameId:   meta.gameId,
        });
        return res.status(403).json({ success: false, error: 'API key has been revoked.' });
    }

    meta.requests++;
    req.apiKeyMeta = meta;
    req.apiKey     = key;
    next();
}

// ══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({ service: 'Roblox API Gateway', status: 'online', version: '1.0.0' });
});

app.get('/api/docs', (req, res) => {
    res.json({
        authentication: 'Add header x-api-key: <your_key> to every request',
        endpoints: {
            'POST /api/keys/create':    'Create a new API key',
            'GET  /api/keys/validate':  'Validate your key',
            'DELETE /api/keys/revoke':  'Revoke your key',
            'GET  /api/ping':           'Authenticated ping',
            'GET  /api/game/info':      'Game metadata',
            'POST /api/game/data/set':  'Store a value',
            'GET  /api/game/data/get':  'Retrieve a value',
            'GET  /api/monitor/health': 'System health check',
            'GET  /api/monitor/stats':  'Full metrics (admin)',
        },
    });
});

// ─── Key management ───────────────────────────────────────────────────────
app.post('/api/keys/create', (req, res) => {
    const { gameId, gameName, owner } = req.body;
    if (!gameId || !gameName || !owner) {
        return res.status(400).json({ success: false, error: 'gameId, gameName, and owner are required.' });
    }

    const newKey = 'rblx_' + crypto.randomBytes(24).toString('hex');
    apiKeys.set(newKey, {
        gameId: String(gameId), gameName: String(gameName), owner: String(owner),
        createdAt: new Date().toISOString(), requests: 0, active: true,
    });

    Logger.info('AUTH', 'New API key created', { gameId, gameName, owner });
    res.status(201).json({ success: true, apiKey: newKey, message: 'Store this key safely.' });
});

app.get('/api/keys/validate', requireApiKey, (req, res) => {
    const { gameId, gameName, owner, createdAt, requests } = req.apiKeyMeta;
    Logger.info('AUTH', 'Key validated', { gameId, gameName });
    res.json({ success: true, valid: true, gameId, gameName, owner, createdAt, requests });
});

app.delete('/api/keys/revoke', requireApiKey, (req, res) => {
    const { gameId, gameName } = req.apiKeyMeta;
    req.apiKeyMeta.active = false;
    Logger.warn('AUTH', 'API key revoked', { gameId, gameName });
    res.json({ success: true, message: 'Key revoked.' });
});

// ─── Game routes ──────────────────────────────────────────────────────────
app.get('/api/ping', requireApiKey, (req, res) => {
    res.json({ success: true, pong: true, game: req.apiKeyMeta.gameName, ts: Date.now() });
});

app.get('/api/game/info', requireApiKey, (req, res) => {
    const { gameId, gameName, owner, createdAt, requests } = req.apiKeyMeta;
    res.json({ success: true, gameId, gameName, owner, createdAt, totalRequests: requests });
});

// ─── Data store ───────────────────────────────────────────────────────────
app.post('/api/game/data/set', requireApiKey, (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ success: false, error: 'key is required.' });

    const gid       = req.apiKeyMeta.gameId;
    const valueSize = JSON.stringify(value).length;

    if (!gameDataStore.has(gid)) gameDataStore.set(gid, new Map());
    gameDataStore.get(gid).set(String(key), value);

    metrics.totalSaves++;
    Logger.info('SAVE', 'Data saved', {
        gameId:    gid,
        gameName:  req.apiKeyMeta.gameName,
        key:       key.slice(0, 40),
        sizeBytes: valueSize,
    });

    res.json({ success: true, stored: { key, sizeBytes: valueSize } });
});

app.get('/api/game/data/get', requireApiKey, (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ success: false, error: 'key query param required.' });

    const gid   = req.apiKeyMeta.gameId;
    const store = gameDataStore.get(gid);
    const value = store ? store.get(key) : undefined;

    if (value === undefined) {
        Logger.info('LOAD', 'Key not found (new player)', {
            gameId:  gid,
            key:     key.slice(0, 40),
        });
        return res.status(404).json({ success: false, error: 'Key not found.' });
    }

    metrics.totalLoads++;
    Logger.info('LOAD', 'Data loaded', {
        gameId:    gid,
        gameName:  req.apiKeyMeta.gameName,
        key:       key.slice(0, 40),
        sizeBytes: JSON.stringify(value).length,
    });

    res.json({ success: true, key, value });
});

// ─── Fallback report endpoint (called by Lua when DataStore fallback used) ──
app.post('/api/monitor/fallback', requireApiKey, (req, res) => {
    const { reason, playerId } = req.body;
    metrics.totalFallbacks++;
    Logger.warn('FALLBACK', 'DataStore fallback used', {
        gameId:   req.apiKeyMeta.gameId,
        gameName: req.apiKeyMeta.gameName,
        reason:   reason || 'unknown',
        playerId: playerId || 'unknown',
    });
    res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
//  MONITORING ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════

// Public health check
app.get('/api/monitor/health', (req, res) => {
    const healthy = true;   // add DB checks here later
    Logger.info('MONITOR', 'Health check', { healthy });
    res.status(healthy ? 200 : 503).json({
        success:       healthy,
        status:        healthy ? 'healthy' : 'degraded',
        uptimeSeconds: uptimeSeconds(),
        avgLatencyMs:  avgResponseTime(),
    });
});

// Full stats (admin only)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change_me_in_env';

app.get('/api/monitor/stats', (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
        Logger.warn('AUTH', 'Unauthorized admin stats access', { ip: req.ip });
        return res.status(403).json({ success: false, error: 'Forbidden.' });
    }

    const keys = [];
    apiKeys.forEach((meta, k) => {
        keys.push({ keyPrefix: k.slice(0, 16) + '...', ...meta });
    });

    const stats = {
        success: true,
        uptime: {
            seconds:    uptimeSeconds(),
            human:      Math.floor(uptimeSeconds() / 60) + ' minutes',
        },
        performance: {
            avgLatencyMs:  avgResponseTime(),
            totalRequests: metrics.totalRequests,
        },
        operations: {
            totalSaves:     metrics.totalSaves,
            totalLoads:     metrics.totalLoads,
            totalFallbacks: metrics.totalFallbacks,
        },
        security: {
            totalAuthFails:  metrics.totalAuthFails,
            totalRateLimits: metrics.totalRateLimits,
        },
        errors: {
            totalErrors: metrics.totalErrors,
        },
        keys: {
            total:  keys.length,
            active: keys.filter(k => k.active).length,
            list:   keys,
        },
    };

    Logger.info('MONITOR', 'Admin stats accessed', { ip: req.ip });
    res.json(stats);
});

// ─── 404 ──────────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found. See /api/docs' });
});

// ─── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    Logger.info('SYSTEM', 'Gateway listening', { port: PORT, env: process.env.NODE_ENV });
});
