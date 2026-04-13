const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const path      = require('path');
const Logger    = require('./logger');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(__dirname));

// ─── In-memory stores ─────────────────────────────────────────────────────
const apiKeys       = new Map();
const gameDataStore = new Map();

// ─── Analytics store ──────────────────────────────────────────────────────
const analyticsEvents = [];
const playerStats     = new Map();
const gameStats       = new Map();

function recordAnalyticsEvent(gameId, event) {
    analyticsEvents.unshift({ gameId, ...event });
    if (analyticsEvents.length > 5000) analyticsEvents.pop();

    if (!gameStats.has(gameId)) {
        gameStats.set(gameId, {
            totalSessions: 0, totalPlayTime: 0,
            totalInteractions: 0, uniquePlayers: new Set(), peakPlayers: 0,
        });
    }
    const gs = gameStats.get(gameId);
    if (event.eventType === 'player_join') {
        gs.totalSessions++;
        gs.uniquePlayers.add(event.data?.userId);
        const pc = event.data?.playerCount || 0;
        if (pc > gs.peakPlayers) gs.peakPlayers = pc;
    }
    if (event.eventType === 'player_leave') gs.totalPlayTime += (event.data?.sessionSecs || 0);
    if (event.eventType === 'interaction')  gs.totalInteractions++;

    const uid = event.data?.userId;
    if (uid) {
        if (!playerStats.has(uid)) {
            playerStats.set(uid, {
                userId: uid, username: event.data.username,
                sessions: 0, totalTimeSecs: 0, interactions: 0,
                lastSeen: null, firstSeen: event.ts,
                accountAge: event.data.accountAge, membership: event.data.membership,
            });
        }
        const ps = playerStats.get(uid);
        ps.username = event.data.username;
        ps.lastSeen = event.ts;
        if (event.eventType === 'player_join')  ps.sessions++;
        if (event.eventType === 'player_leave') ps.totalTimeSecs += (event.data.sessionSecs || 0);
        if (event.eventType === 'interaction')  ps.interactions++;
    }
}

// ─── Performance metrics ──────────────────────────────────────────────────
const metrics = {
    totalRequests: 0, totalSaves: 0, totalLoads: 0,
    totalErrors: 0, totalAuthFails: 0, totalRateLimits: 0,
    responseTimes: [], startTime: Date.now(),
};
function recordResponseTime(ms) {
    metrics.responseTimes.push(ms);
    if (metrics.responseTimes.length > 1000) metrics.responseTimes.shift();
}
function avgResponseTime() {
    if (!metrics.responseTimes.length) return 0;
    return Math.round(metrics.responseTimes.reduce((a,b) => a+b, 0) / metrics.responseTimes.length);
}
function uptimeSeconds() { return Math.floor((Date.now() - metrics.startTime) / 1000); }

// ─── Seed demo key ────────────────────────────────────────────────────────
const DEMO_KEY = 'rblx_demo_' + crypto.randomBytes(16).toString('hex');
apiKeys.set(DEMO_KEY, {
    gameId: '1234567890', gameName: 'Demo Game', owner: 'DemoUser',
    createdAt: new Date().toISOString(), requests: 0, active: true,
});
Logger.info('SYSTEM', 'Server started', { demoKey: DEMO_KEY });

// ─── Request logging ──────────────────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    metrics.totalRequests++;
    res.on('finish', () => {
        const ms = Date.now() - start;
        recordResponseTime(ms);
        const isError = res.statusCode >= 400;
        if (isError) metrics.totalErrors++;
        const logFn = isError ? Logger.warn : Logger.info;
        logFn('REQUEST', req.method + ' ' + req.path, {
            method: req.method, path: req.path, status: res.statusCode,
            latencyMs: ms, ip: req.ip,
            gameId: req.apiKeyMeta?.gameId, gameName: req.apiKeyMeta?.gameName,
        });
    });
    next();
});

// ─── Rate limiter ─────────────────────────────────────────────────────────
const limiter = rateLimit({
    windowMs: 60 * 1000, max: 120,
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => {
        metrics.totalRateLimits++;
        Logger.warn('RATE_LIMIT', 'Rate limit hit', { ip: req.ip, path: req.path });
        res.status(429).json({ success: false, error: 'Rate limit exceeded.' });
    },
});
app.use('/api/', limiter);

// ─── Auth middleware ──────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (!key) {
        metrics.totalAuthFails++;
        Logger.warn('AUTH', 'Missing API key', { ip: req.ip });
        return res.status(401).json({ success: false, error: 'Missing API key.' });
    }
    const meta = apiKeys.get(key);
    if (!meta) {
        metrics.totalAuthFails++;
        Logger.warn('AUTH', 'Invalid API key', { ip: req.ip, keyHint: key.slice(0,12)+'...' });
        return res.status(403).json({ success: false, error: 'Invalid API key.' });
    }
    if (!meta.active) {
        metrics.totalAuthFails++;
        return res.status(403).json({ success: false, error: 'API key revoked.' });
    }
    meta.requests++;
    req.apiKeyMeta = meta;
    req.apiKey = key;
    next();
}

// ══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({ service: 'Roblox API Gateway', status: 'online', version: '1.0.0' });
});

// ─── Key management ───────────────────────────────────────────────────────
app.post('/api/keys/create', (req, res) => {
    const { gameId, gameName, owner } = req.body;
    if (!gameId || !gameName || !owner)
        return res.status(400).json({ success: false, error: 'gameId, gameName, and owner are required.' });
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
    res.json({ success: true, valid: true, gameId, gameName, owner, createdAt, requests });
});

app.delete('/api/keys/revoke', requireApiKey, (req, res) => {
    req.apiKeyMeta.active = false;
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
    const gid = req.apiKeyMeta.gameId;
    const valueSize = JSON.stringify(value).length;
    if (!gameDataStore.has(gid)) gameDataStore.set(gid, new Map());
    gameDataStore.get(gid).set(String(key), value);
    metrics.totalSaves++;
    Logger.info('SAVE', 'Data saved', { gameId: gid, key: key.slice(0,40), sizeBytes: valueSize });
    res.json({ success: true, stored: { key, sizeBytes: valueSize } });
});

app.get('/api/game/data/get', requireApiKey, (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ success: false, error: 'key query param required.' });
    const gid = req.apiKeyMeta.gameId;
    const store = gameDataStore.get(gid);
    const value = store ? store.get(key) : undefined;
    if (value === undefined) {
        return res.status(404).json({ success: false, error: 'Key not found.' });
    }
    metrics.totalLoads++;
    Logger.info('LOAD', 'Data loaded', { gameId: gid, key: key.slice(0,40) });
    res.json({ success: true, key, value });
});

// ══════════════════════════════════════════════════════════════════════════
//  ANALYTICS
// ══════════════════════════════════════════════════════════════════════════

app.post('/api/analytics/event', requireApiKey, (req, res) => {
    const { eventType, gameId, placeId, jobId, ts, data } = req.body;
    if (!eventType) return res.status(400).json({ success: false, error: 'eventType required.' });

    const event = { eventType, gameId, placeId, jobId, ts, data, receivedAt: Date.now() };
    recordAnalyticsEvent(req.apiKeyMeta.gameId, event);

    Logger.info('ANALYTICS', eventType, {
        gameId: req.apiKeyMeta.gameId, gameName: req.apiKeyMeta.gameName,
        userId: data?.userId, username: data?.username,
    });

    res.json({ success: true });
});

app.get('/api/analytics/summary', requireApiKey, (req, res) => {
    const gid = req.apiKeyMeta.gameId;
    const gs  = gameStats.get(gid);

    const activePlayers = analyticsEvents
        .filter(e => e.gameId === gid && e.eventType === 'server_heartbeat')
        .slice(0, 1).map(e => e.data?.playerCount || 0)[0] || 0;

    const players = [...playerStats.values()]
        .filter(p => analyticsEvents.some(e => e.gameId === gid && e.data?.userId === p.userId))
        .sort((a, b) => (b.lastSeen||0) - (a.lastSeen||0))
        .slice(0, 50)
        .map(p => ({
            ...p,
            avgSessionMins: p.sessions > 0 ? Math.round(p.totalTimeSecs / p.sessions / 60) : 0,
            totalTimeMins:  Math.round(p.totalTimeSecs / 60),
        }));

    const recentEvents = analyticsEvents.filter(e => e.gameId === gid).slice(0, 100);

    res.json({
        success: true,
        summary: {
            totalSessions:     gs?.totalSessions     || 0,
            totalPlayTimeMins: Math.round((gs?.totalPlayTime||0) / 60),
            totalInteractions: gs?.totalInteractions  || 0,
            uniquePlayers:     gs?.uniquePlayers?.size || 0,
            peakPlayers:       gs?.peakPlayers         || 0,
            activePlayers,
        },
        players,
        recentEvents,
    });
});

// ─── Dashboard ────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
    const key = req.query.key;
    if (!key) return res.send('<h2 style="font-family:monospace;padding:2rem">Add ?key=YOUR_API_KEY to the URL<br><br>Example: /dashboard?key=rblx_xxx</h2>');
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ══════════════════════════════════════════════════════════════════════════
//  MONITORING
// ══════════════════════════════════════════════════════════════════════════

app.get('/api/monitor/health', (req, res) => {
    res.json({ success: true, status: 'healthy', uptimeSeconds: uptimeSeconds(), avgLatencyMs: avgResponseTime() });
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change_me_in_env';
app.get('/api/monitor/stats', (req, res) => {
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
        return res.status(403).json({ success: false, error: 'Forbidden.' });
    const keys = [];
    apiKeys.forEach((meta, k) => keys.push({ keyPrefix: k.slice(0,16)+'...', ...meta }));
    res.json({
        success: true,
        uptime:      { seconds: uptimeSeconds() },
        performance: { avgLatencyMs: avgResponseTime(), totalRequests: metrics.totalRequests },
        operations:  { totalSaves: metrics.totalSaves, totalLoads: metrics.totalLoads },
        security:    { totalAuthFails: metrics.totalAuthFails, totalRateLimits: metrics.totalRateLimits },
        keys:        { total: keys.length, active: keys.filter(k=>k.active).length },
    });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    Logger.info('SYSTEM', 'Gateway listening', { port: PORT, env: process.env.NODE_ENV });
});
