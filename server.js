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

// ══════════════════════════════════════════════════════════════════════════
//  IN-MEMORY STORES
// ══════════════════════════════════════════════════════════════════════════
const apiKeys       = new Map(); // key → meta
const gameDataStore = new Map(); // gameId → Map(key → value)

// Analytics
const analyticsEvents  = [];          // all events, cap 10000
const playerProfiles   = new Map();   // userId → full profile
const gameAggregates   = new Map();   // gameId → aggregate stats

// Moderation
const bannedPlayers    = new Map();   // userId → { reason, bannedAt, bannedBy, gameId, permanent }
const timeouts         = new Map();   // userId → { until, reason, gameId }
const blacklist        = new Map();   // userId → { reason, gameId }

// Game commands (polled by Roblox)
const pendingCommands  = new Map();   // gameId → [ { id, type, target, data, createdAt } ]

// Metrics
const metrics = {
  totalRequests: 0, totalSaves: 0, totalLoads: 0,
  totalErrors: 0, totalAuthFails: 0, totalRateLimits: 0,
  responseTimes: [], startTime: Date.now(),
};

function recordRT(ms) {
  metrics.responseTimes.push(ms);
  if (metrics.responseTimes.length > 1000) metrics.responseTimes.shift();
}
function avgRT() {
  if (!metrics.responseTimes.length) return 0;
  return Math.round(metrics.responseTimes.reduce((a,b)=>a+b,0)/metrics.responseTimes.length);
}
function uptime() { return Math.floor((Date.now()-metrics.startTime)/1000); }

// ── Demo key ──────────────────────────────────────────────────────────────
const DEMO_KEY = 'rblx_demo_' + crypto.randomBytes(16).toString('hex');
apiKeys.set(DEMO_KEY, {
  gameId:'1234567890', gameName:'Demo Game', owner:'DemoUser',
  createdAt:new Date().toISOString(), requests:0, active:true,
});
Logger.info('SYSTEM','Server started',{ demoKey: DEMO_KEY });

// ══════════════════════════════════════════════════════════════════════════
//  ANALYTICS ENGINE
// ══════════════════════════════════════════════════════════════════════════
function getOrCreateProfile(userId, username) {
  if (!playerProfiles.has(userId)) {
    playerProfiles.set(userId, {
      userId, username,
      sessions: 0, totalTimeSecs: 0, interactions: 0,
      firstSeen: Math.floor(Date.now()/1000), lastSeen: null,
      accountAge: null, membership: null,
      coinsEarned: 0, coinsSpent: 0, gemsEarned: 0, gemsSpent: 0,
      purchases: [], itemsCollected: 0, levelsReached: [],
      actionCounts: {}, // action → count
      sessionHistory: [], // [{start, end, duration}]
      currentSessionStart: null,
      gameIds: new Set(),
      isBanned: false, isTimedOut: false, isBlacklisted: false,
    });
  }
  const p = playerProfiles.get(userId);
  if (username) p.username = username;
  return p;
}

function getOrCreateAggregate(gameId) {
  if (!gameAggregates.has(gameId)) {
    gameAggregates.set(gameId, {
      totalSessions: 0, totalPlayTimeSecs: 0,
      totalInteractions: 0, uniquePlayers: new Set(),
      peakPlayers: 0, currentPlayers: 0,
      totalRevenue: 0, totalPurchases: 0, payingPlayers: new Set(),
      hourlyJoins: new Array(24).fill(0),
      actionBreakdown: {},
      currentPlayerList: [],
    });
  }
  return gameAggregates.get(gameId);
}

function processEvent(gameId, event) {
  // Cap events
  analyticsEvents.unshift({ gameId, ...event });
  if (analyticsEvents.length > 10000) analyticsEvents.pop();

  const agg = getOrCreateAggregate(gameId);
  const d   = event.data || {};

  if (event.eventType === 'player_join') {
    agg.totalSessions++;
    agg.uniquePlayers.add(d.userId);
    const pc = d.playerCount || 0;
    if (pc > agg.peakPlayers) agg.peakPlayers = pc;
    agg.currentPlayers = pc;
    const hour = new Date((event.ts||Date.now()/1000)*1000).getHours();
    agg.hourlyJoins[hour]++;

    const profile = getOrCreateProfile(d.userId, d.username);
    profile.sessions++;
    profile.lastSeen = event.ts;
    profile.currentSessionStart = event.ts;
    profile.accountAge = d.accountAge;
    profile.membership = d.membership;
    profile.gameIds.add(gameId);
    if (!profile.isBanned) profile.isBanned = bannedPlayers.has(d.userId);
    if (!profile.isBlacklisted) profile.isBlacklisted = blacklist.has(d.userId);

    const playerListEntry = { userId: d.userId, username: d.username, joinedAt: event.ts };
    agg.currentPlayerList = agg.currentPlayerList.filter(p => p.userId !== d.userId);
    agg.currentPlayerList.push(playerListEntry);
  }

  if (event.eventType === 'player_leave') {
    const duration = d.sessionSecs || 0;
    agg.totalPlayTimeSecs += duration;
    agg.currentPlayerList = agg.currentPlayerList.filter(p => p.userId !== d.userId);
    agg.currentPlayers = Math.max(0, agg.currentPlayers - 1);

    const profile = getOrCreateProfile(d.userId, d.username);
    profile.totalTimeSecs += duration;
    profile.lastSeen = event.ts;
    if (profile.currentSessionStart) {
      profile.sessionHistory.push({ start: profile.currentSessionStart, end: event.ts, duration });
      if (profile.sessionHistory.length > 50) profile.sessionHistory.shift();
      profile.currentSessionStart = null;
    }
  }

  if (event.eventType === 'interaction') {
    agg.totalInteractions++;
    const action = d.action || 'unknown';
    agg.actionBreakdown[action] = (agg.actionBreakdown[action] || 0) + 1;

    const profile = getOrCreateProfile(d.userId, d.username);
    profile.interactions++;
    profile.lastSeen = event.ts;
    profile.actionCounts[action] = (profile.actionCounts[action] || 0) + 1;
  }

  if (event.eventType === 'economy') {
    const { currency, amount, action: eAction, itemId, itemName } = d;
    const profile = getOrCreateProfile(d.userId, d.username);
    profile.lastSeen = event.ts;

    if (eAction === 'earn') {
      if (currency === 'coins') profile.coinsEarned += amount || 0;
      if (currency === 'gems')  profile.gemsEarned  += amount || 0;
    }
    if (eAction === 'spend') {
      if (currency === 'coins') profile.coinsSpent += amount || 0;
      if (currency === 'gems')  profile.gemsSpent  += amount || 0;
      agg.totalRevenue += amount || 0;
      agg.totalPurchases++;
      agg.payingPlayers.add(d.userId);
      if (itemId) profile.purchases.push({ itemId, itemName, amount, ts: event.ts });
    }
  }

  if (event.eventType === 'level_up') {
    const profile = getOrCreateProfile(d.userId, d.username);
    if (d.level && !profile.levelsReached.includes(d.level)) {
      profile.levelsReached.push(d.level);
    }
    profile.lastSeen = event.ts;
  }

  if (event.eventType === 'server_heartbeat') {
    agg.currentPlayers = d.playerCount || 0;
    agg.currentPlayerList = (d.players || []).map(name => ({
      username: name, joinedAt: null,
    }));
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  const start = Date.now();
  metrics.totalRequests++;
  res.on('finish', () => {
    const ms = Date.now() - start;
    recordRT(ms);
    if (res.statusCode >= 400) metrics.totalErrors++;
    const fn = res.statusCode >= 400 ? Logger.warn : Logger.info;
    fn('REQUEST', req.method + ' ' + req.path, {
      method: req.method, path: req.path, status: res.statusCode,
      latencyMs: ms, ip: req.ip,
      gameId: req.apiKeyMeta?.gameId, gameName: req.apiKeyMeta?.gameName,
    });
  });
  next();
});

const limiter = rateLimit({
  windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => {
    metrics.totalRateLimits++;
    Logger.warn('RATE_LIMIT','Rate limit hit',{ ip: req.ip });
    res.status(429).json({ success: false, error: 'Rate limit exceeded.' });
  },
});
app.use('/api/', limiter);

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!key) {
    metrics.totalAuthFails++;
    return res.status(401).json({ success: false, error: 'Missing API key.' });
  }
  const meta = apiKeys.get(key);
  if (!meta) {
    metrics.totalAuthFails++;
    Logger.warn('AUTH','Invalid API key',{ ip: req.ip, keyHint: key.slice(0,12)+'...' });
    return res.status(403).json({ success: false, error: 'Invalid API key.' });
  }
  if (!meta.active) return res.status(403).json({ success: false, error: 'Key revoked.' });
  meta.requests++;
  req.apiKeyMeta = meta;
  req.apiKey = key;
  next();
}

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.adminSecret;
  const ADMIN  = process.env.ADMIN_SECRET || 'change_me_in_env';
  if (secret !== ADMIN) return res.status(403).json({ success: false, error: 'Forbidden.' });
  next();
}

// ══════════════════════════════════════════════════════════════════════════
//  ROUTES — CORE
// ══════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ service: 'Roblox API Gateway', status: 'online', version: '2.0.0' }));

app.post('/api/keys/create', (req, res) => {
  const { gameId, gameName, owner } = req.body;
  if (!gameId || !gameName || !owner)
    return res.status(400).json({ success: false, error: 'gameId, gameName, and owner required.' });
  const newKey = 'rblx_' + crypto.randomBytes(24).toString('hex');
  apiKeys.set(newKey, {
    gameId: String(gameId), gameName: String(gameName), owner: String(owner),
    createdAt: new Date().toISOString(), requests: 0, active: true,
  });
  Logger.info('AUTH','Key created',{ gameId, gameName, owner });
  res.status(201).json({ success: true, apiKey: newKey });
});

app.get('/api/keys/validate', requireApiKey, (req, res) => {
  const { gameId, gameName, owner, createdAt, requests } = req.apiKeyMeta;
  res.json({ success: true, valid: true, gameId, gameName, owner, createdAt, requests });
});

app.delete('/api/keys/revoke', requireApiKey, (req, res) => {
  req.apiKeyMeta.active = false;
  res.json({ success: true });
});

app.get('/api/ping', requireApiKey, (req, res) => {
  res.json({ success: true, pong: true, game: req.apiKeyMeta.gameName, ts: Date.now() });
});

app.get('/api/game/info', requireApiKey, (req, res) => {
  const { gameId, gameName, owner, createdAt, requests } = req.apiKeyMeta;
  res.json({ success: true, gameId, gameName, owner, createdAt, totalRequests: requests });
});

// ── Data store ────────────────────────────────────────────────────────────
app.post('/api/game/data/set', requireApiKey, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ success: false, error: 'key required.' });
  const gid = req.apiKeyMeta.gameId;
  if (!gameDataStore.has(gid)) gameDataStore.set(gid, new Map());
  gameDataStore.get(gid).set(String(key), value);
  metrics.totalSaves++;
  res.json({ success: true, stored: { key, sizeBytes: JSON.stringify(value).length } });
});

app.get('/api/game/data/get', requireApiKey, (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ success: false, error: 'key required.' });
  const gid   = req.apiKeyMeta.gameId;
  const store = gameDataStore.get(gid);
  const value = store ? store.get(key) : undefined;
  if (value === undefined) return res.status(404).json({ success: false, error: 'Not found.' });
  metrics.totalLoads++;
  res.json({ success: true, key, value });
});

// ══════════════════════════════════════════════════════════════════════════
//  ANALYTICS ROUTES
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/analytics/event', requireApiKey, (req, res) => {
  const { eventType, ts, data } = req.body;
  if (!eventType) return res.status(400).json({ success: false, error: 'eventType required.' });
  processEvent(req.apiKeyMeta.gameId, { eventType, ts: ts || Math.floor(Date.now()/1000), data: data || {}, receivedAt: Date.now() });
  res.json({ success: true });
});

app.post('/api/analytics/batch', requireApiKey, (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ success: false, error: 'events array required.' });
  events.forEach(e => processEvent(req.apiKeyMeta.gameId, { ...e, receivedAt: Date.now() }));
  res.json({ success: true, processed: events.length });
});

app.get('/api/analytics/summary', requireApiKey, (req, res) => {
  const gid = req.apiKeyMeta.gameId;
  const agg = getOrCreateAggregate(gid);

  const players = [...playerProfiles.values()]
    .filter(p => p.gameIds.has(gid))
    .map(p => ({
      userId:         p.userId,
      username:       p.username,
      sessions:       p.sessions,
      totalTimeSecs:  p.totalTimeSecs,
      totalTimeMins:  Math.round(p.totalTimeSecs / 60),
      avgSessionMins: p.sessions > 0 ? Math.round(p.totalTimeSecs / p.sessions / 60) : 0,
      interactions:   p.interactions,
      lastSeen:       p.lastSeen,
      firstSeen:      p.firstSeen,
      accountAge:     p.accountAge,
      membership:     p.membership,
      coinsEarned:    p.coinsEarned,
      coinsSpent:     p.coinsSpent,
      gemsEarned:     p.gemsEarned,
      gemsSpent:      p.gemsSpent,
      purchases:      p.purchases,
      levelsReached:  p.levelsReached,
      actionCounts:   p.actionCounts,
      isBanned:       bannedPlayers.has(p.userId),
      isTimedOut:     timeouts.has(p.userId) && timeouts.get(p.userId).until > Date.now()/1000,
      isBlacklisted:  blacklist.has(p.userId),
    }))
    .sort((a,b) => (b.lastSeen||0) - (a.lastSeen||0));

  const now = Date.now()/1000;
  const recentEvents = analyticsEvents.filter(e => e.gameId === gid).slice(0, 200);

  // Retention
  const calcRetention = (days) => {
    const cutoff = now - days * 86400;
    const eligible = players.filter(p => p.firstSeen < cutoff);
    if (!eligible.length) return 0;
    const returned = eligible.filter(p => p.sessions >= 2 && p.lastSeen > cutoff + 3600);
    return Math.round(returned.length / eligible.length * 100);
  };

  // Avg session
  const avgSessionMins = players.length
    ? Math.round(players.reduce((a,p) => a + p.avgSessionMins, 0) / players.length)
    : 0;

  // Monetization
  const payingCount = agg.payingPlayers.size;
  const arpu = agg.uniquePlayers.size > 0 ? Math.round(agg.totalRevenue / agg.uniquePlayers.size) : 0;
  const ltv  = payingCount > 0 ? Math.round(agg.totalRevenue / payingCount) : 0;

  res.json({
    success: true,
    summary: {
      activePlayers:     agg.currentPlayers,
      totalSessions:     agg.totalSessions,
      uniquePlayers:     agg.uniquePlayers.size,
      totalPlayTimeMins: Math.round(agg.totalPlayTimeSecs / 60),
      peakPlayers:       agg.peakPlayers,
      totalInteractions: agg.totalInteractions,
      avgSessionMins,
      retention: { d1: calcRetention(1), d7: calcRetention(7), d30: calcRetention(30) },
      monetization: {
        totalRevenue:   agg.totalRevenue,
        totalPurchases: agg.totalPurchases,
        payingPlayers:  payingCount,
        arpu, ltv,
        conversionRate: agg.uniquePlayers.size > 0 ? Math.round(payingCount / agg.uniquePlayers.size * 100) : 0,
      },
      hourlyJoins:      agg.hourlyJoins,
      actionBreakdown:  agg.actionBreakdown,
      currentPlayers:   agg.currentPlayerList,
    },
    players,
    recentEvents,
  });
});

app.get('/api/analytics/player/:userId', requireApiKey, (req, res) => {
  const uid = parseInt(req.params.userId);
  const p   = playerProfiles.get(uid);
  if (!p) return res.status(404).json({ success: false, error: 'Player not found.' });

  const events = analyticsEvents
    .filter(e => e.gameId === req.apiKeyMeta.gameId && e.data?.userId === uid)
    .slice(0, 100);

  res.json({
    success: true,
    player: {
      ...p,
      gameIds: [...p.gameIds],
      totalTimeMins: Math.round(p.totalTimeSecs / 60),
      avgSessionMins: p.sessions > 0 ? Math.round(p.totalTimeSecs / p.sessions / 60) : 0,
      isBanned: bannedPlayers.has(uid),
      banInfo: bannedPlayers.get(uid) || null,
      isTimedOut: timeouts.has(uid) && timeouts.get(uid).until > Date.now()/1000,
      timeoutInfo: timeouts.get(uid) || null,
      isBlacklisted: blacklist.has(uid),
    },
    events,
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  MODERATION ROUTES
// ══════════════════════════════════════════════════════════════════════════
function pushCommand(gameId, command) {
  if (!pendingCommands.has(gameId)) pendingCommands.set(gameId, []);
  const cmd = { id: crypto.randomUUID(), createdAt: Date.now(), ...command };
  pendingCommands.get(gameId).push(cmd);
  // Keep only last 100 commands
  const cmds = pendingCommands.get(gameId);
  if (cmds.length > 100) cmds.splice(0, cmds.length - 100);
  return cmd;
}

// Ban
app.post('/api/moderation/ban', requireApiKey, (req, res) => {
  const { userId, username, reason, permanent } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'userId required.' });
  const uid = parseInt(userId);
  const info = { userId: uid, username, reason: reason || 'No reason given', bannedAt: Date.now()/1000, permanent: !!permanent, gameId: req.apiKeyMeta.gameId };
  bannedPlayers.set(uid, info);
  const profile = getOrCreateProfile(uid, username);
  profile.isBanned = true;
  const cmd = pushCommand(req.apiKeyMeta.gameId, { type: 'kick', targetUserId: uid, targetUsername: username, reason: 'You have been banned: ' + (reason || 'No reason given') });
  Logger.warn('MODERATION','Player banned',{ userId: uid, username, reason, gameId: req.apiKeyMeta.gameId });
  res.json({ success: true, banned: info, command: cmd });
});

app.delete('/api/moderation/ban/:userId', requireApiKey, (req, res) => {
  const uid = parseInt(req.params.userId);
  bannedPlayers.delete(uid);
  const profile = playerProfiles.get(uid);
  if (profile) profile.isBanned = false;
  Logger.info('MODERATION','Ban lifted',{ userId: uid });
  res.json({ success: true });
});

// Timeout
app.post('/api/moderation/timeout', requireApiKey, (req, res) => {
  const { userId, username, reason, minutes } = req.body;
  if (!userId || !minutes) return res.status(400).json({ success: false, error: 'userId and minutes required.' });
  const uid  = parseInt(userId);
  const until = Date.now()/1000 + (parseInt(minutes) * 60);
  const info  = { userId: uid, username, reason: reason || 'No reason given', until, minutes: parseInt(minutes), gameId: req.apiKeyMeta.gameId };
  timeouts.set(uid, info);
  const cmd = pushCommand(req.apiKeyMeta.gameId, { type: 'kick', targetUserId: uid, targetUsername: username, reason: 'You have been timed out for ' + minutes + ' minutes: ' + (reason || '') });
  Logger.warn('MODERATION','Player timed out',{ userId: uid, username, minutes, reason });
  res.json({ success: true, timeout: info, command: cmd });
});

app.delete('/api/moderation/timeout/:userId', requireApiKey, (req, res) => {
  timeouts.delete(parseInt(req.params.userId));
  res.json({ success: true });
});

// Blacklist
app.post('/api/moderation/blacklist', requireApiKey, (req, res) => {
  const { userId, username, reason } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'userId required.' });
  const uid  = parseInt(userId);
  const info = { userId: uid, username, reason: reason || 'No reason given', addedAt: Date.now()/1000, gameId: req.apiKeyMeta.gameId };
  blacklist.set(uid, info);
  Logger.warn('MODERATION','Player blacklisted',{ userId: uid, username, reason });
  res.json({ success: true, blacklisted: info });
});

app.delete('/api/moderation/blacklist/:userId', requireApiKey, (req, res) => {
  blacklist.delete(parseInt(req.params.userId));
  res.json({ success: true });
});

// Kick (instant)
app.post('/api/moderation/kick', requireApiKey, (req, res) => {
  const { userId, username, reason } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'userId required.' });
  const uid = parseInt(userId);
  const cmd = pushCommand(req.apiKeyMeta.gameId, { type: 'kick', targetUserId: uid, targetUsername: username, reason: reason || 'Kicked by admin' });
  Logger.warn('MODERATION','Player kicked',{ userId: uid, username, reason });
  res.json({ success: true, command: cmd });
});

// Get all moderation lists
app.get('/api/moderation/list', requireApiKey, (req, res) => {
  const gid = req.apiKeyMeta.gameId;
  const now = Date.now()/1000;
  res.json({
    success: true,
    banned:      [...bannedPlayers.values()].filter(b => b.gameId === gid),
    timedOut:    [...timeouts.values()].filter(t => t.gameId === gid && t.until > now),
    blacklisted: [...blacklist.values()].filter(b => b.gameId === gid),
  });
});

// Check if player is moderated (called by Roblox on join)
app.get('/api/moderation/check/:userId', requireApiKey, (req, res) => {
  const uid = parseInt(req.params.userId);
  const now = Date.now()/1000;
  const ban = bannedPlayers.get(uid);
  const timeout = timeouts.get(uid);
  const bl = blacklist.get(uid);

  res.json({
    success: true,
    isBanned: !!ban,
    banInfo: ban || null,
    isTimedOut: !!(timeout && timeout.until > now),
    timeoutInfo: (timeout && timeout.until > now) ? timeout : null,
    isBlacklisted: !!bl,
    blacklistInfo: bl || null,
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  GAME COMMANDS (polled by Roblox every 5s)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/commands/send', requireApiKey, (req, res) => {
  const { type, targetUserId, targetUsername, data } = req.body;
  if (!type) return res.status(400).json({ success: false, error: 'type required.' });
  const cmd = pushCommand(req.apiKeyMeta.gameId, { type, targetUserId, targetUsername, data: data || {} });
  Logger.info('COMMAND','Command sent',{ type, targetUserId, gameId: req.apiKeyMeta.gameId });
  res.json({ success: true, command: cmd });
});

// Roblox polls this every 5 seconds
app.get('/api/commands/poll', requireApiKey, (req, res) => {
  const gid  = req.apiKeyMeta.gameId;
  const cmds = pendingCommands.get(gid) || [];
  // Return pending commands and clear them
  pendingCommands.set(gid, []);
  res.json({ success: true, commands: cmds });
});

// ══════════════════════════════════════════════════════════════════════════
//  DASHBOARD ROUTE
// ══════════════════════════════════════════════════════════════════════════
app.get('/dashboard', (req, res) => {
  const key = req.query.key;
  if (!key) return res.send('<h2 style="font-family:monospace;padding:2rem">Add ?key=YOUR_API_KEY to the URL</h2>');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ══════════════════════════════════════════════════════════════════════════
//  MONITORING
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/monitor/health', (req, res) => {
  res.json({ success: true, status: 'healthy', uptimeSeconds: uptime(), avgLatencyMs: avgRT() });
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change_me_in_env';
app.get('/api/monitor/stats', (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(403).json({ success: false, error: 'Forbidden.' });
  res.json({
    success: true,
    uptime: { seconds: uptime() },
    performance: { avgLatencyMs: avgRT(), totalRequests: metrics.totalRequests },
    operations: { totalSaves: metrics.totalSaves, totalLoads: metrics.totalLoads },
    security: { totalAuthFails: metrics.totalAuthFails, totalRateLimits: metrics.totalRateLimits },
    moderation: { banned: bannedPlayers.size, timedOut: timeouts.size, blacklisted: blacklist.size },
  });
});

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => Logger.info('SYSTEM','Gateway listening',{ port: PORT, env: process.env.NODE_ENV }));
