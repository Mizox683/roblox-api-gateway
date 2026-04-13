// src/logger.js
// Structured logger — all output goes to Render logs (stdout)
// Every line is JSON so you can filter/search easily in Render dashboard

const os = require('os');

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO;

function emit(level, category, message, data = {}) {
    if (LOG_LEVELS[level] < MIN_LEVEL) return;

    const entry = {
        ts:       new Date().toISOString(),
        level,
        category,
        message,
        host:     os.hostname(),
        ...data,
    };

    // Render captures stdout — one JSON line per log entry
    console.log(JSON.stringify(entry));
}

const Logger = {
    debug: (cat, msg, data)  => emit('DEBUG', cat, msg, data),
    info:  (cat, msg, data)  => emit('INFO',  cat, msg, data),
    warn:  (cat, msg, data)  => emit('WARN',  cat, msg, data),
    error: (cat, msg, data)  => emit('ERROR', cat, msg, data),
};

module.exports = Logger;
