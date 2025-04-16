const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const WebSocket = require('ws');

const PORT = process.env.PORT || 11001;
const app = express();
const SESSION_FILE = path.join(__dirname, 'sessions.json');
const SESSION_BACKUP_FILE = path.join(__dirname, 'sessions_backup.json');
const SESSION_LOCK_FILE = path.join(__dirname, 'sessions.lock');
const BACKUP_INTERVAL = 1000 * 60 * 1; // 1 minute
const REQUIRED_HEADER = 'X-Daemon'; // Custom header for API protection
const HEADER_VALUE = 'DaemonCyzsh'; // Expected value for the header

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to check for required header
function checkHeader(req, res, next) {
  if (req.headers[REQUIRED_HEADER.toLowerCase()] !== HEADER_VALUE) {
    return res.status(403).json({ 
      error: 'Forbidden',
      message: 'Missing required header'
    });
  }
  next();
}

// Initialize sessions storage
async function initializeSessionStore() {
  try {
    await fs.access(SESSION_FILE);
    
    // Verify the file is valid JSON
    const data = await fs.readFile(SESSION_FILE, 'utf8');
    JSON.parse(data);
    
    // Create backup if it doesn't exist
    try {
      await fs.access(SESSION_BACKUP_FILE);
    } catch {
      await fs.copyFile(SESSION_FILE, SESSION_BACKUP_FILE);
    }
  } catch (error) {
    // If main file is corrupted, try to restore from backup
    try {
      await fs.access(SESSION_BACKUP_FILE);
      const backupData = await fs.readFile(SESSION_BACKUP_FILE, 'utf8');
      JSON.parse(backupData);
      await fs.writeFile(SESSION_FILE, backupData);
      console.log('Restored sessions from backup');
    } catch (backupError) {
      // If both files are bad, start fresh
      await fs.writeFile(SESSION_FILE, JSON.stringify({}));
      console.log('Created new empty sessions file');
    }
  }
  
  // Setup periodic backups
  setInterval(async () => {
    try {
      const data = await fs.readFile(SESSION_FILE, 'utf8');
      await fs.writeFile(SESSION_BACKUP_FILE, data);
    } catch (error) {
      console.error('Failed to create backup:', error);
    }
  }, BACKUP_INTERVAL);
}

function generateSessionId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function readSessions() {
  try {
    const data = await fs.readFile(SESSION_FILE, 'utf8');
    const sessions = JSON.parse(data);
    
    // Validate the structure
    if (typeof sessions !== 'object' || sessions === null) {
      throw new Error('Invalid sessions format');
    }
    
    // Clean up old sessions (older than 7 days)
    const now = Date.now();
    const sevenDays = 1000 * 60 * 60 * 24 * 7;
    let cleaned = false;
    
    for (const [id, session] of Object.entries(sessions)) {
      if (session.createdAt && (now - new Date(session.createdAt).getTime() > sevenDays)) {
        delete sessions[id];
        cleaned = true;
      }
    }
    
    if (cleaned) {
      await writeSessions(sessions);
    }
    
    return sessions;
  } catch (error) {
    console.error('Error reading sessions:', error);
    
    // Try to restore from backup
    try {
      const backupData = await fs.readFile(SESSION_BACKUP_FILE, 'utf8');
      const sessions = JSON.parse(backupData);
      await fs.writeFile(SESSION_FILE, backupData);
      return sessions;
    } catch (backupError) {
      console.error('Failed to restore from backup:', backupError);
      return {};
    }
  }
}

async function writeSessions(sessions) {
  // Create a lock file to prevent concurrent writes
  let lockAcquired = false;
  try {
    // Try to create lock file with exclusive flag
    const lockHandle = await fs.open(SESSION_LOCK_FILE, 'wx');
    await lockHandle.close();
    lockAcquired = true;
    
    // Validate sessions data
    if (typeof sessions !== 'object' || sessions === null) {
      throw new Error('Invalid sessions data');
    }
    
    // Write to temporary file first
    const tempFile = SESSION_FILE + '.tmp';
    await fs.writeFile(tempFile, JSON.stringify(sessions, null, 2));
    
    // Atomic rename operation
    await fs.rename(tempFile, SESSION_FILE);
  } catch (error) {
    console.error('Error writing sessions:', error);
    
    // If we have the lock but failed to write, try to restore from memory
    if (lockAcquired) {
      try {
        const currentData = await fs.readFile(SESSION_FILE, 'utf8');
        // If file is empty/corrupted, try to write again
        if (!currentData || currentData.trim() === '') {
          await fs.writeFile(SESSION_FILE, JSON.stringify(sessions, null, 2));
        }
      } catch (recoveryError) {
        console.error('Failed to recover sessions file:', recoveryError);
      }
    }
  } finally {
    // Release the lock
    if (lockAcquired) {
      try {
        await fs.unlink(SESSION_LOCK_FILE);
      } catch (cleanupError) {
        console.error('Failed to remove lock file:', cleanupError);
      }
    }
  }
}

async function broadcastActiveSessions() {
  const sessions = await readSessions();
  const now = Date.now();
  
  const activeSessions = Object.entries(sessions)
    .filter(([_, session]) => ['started', 'in_progress'].includes(session.status))
    .map(([id, session]) => {
      const elapsedSeconds = (now - new Date(session.createdAt).getTime()) / 1000;
      const sharesPerSecond = session.completedShares / elapsedSeconds;
      const remainingShares = session.totalShares - (session.completedShares || 0);
      const estimatedTime = sharesPerSecond > 0 ? remainingShares / sharesPerSecond : Infinity;

      return {
        id,
        shortId: id.slice(-4),
        url: session.url,
        amount: session.totalShares,
        interval: session.interval,
        completed: session.completedShares || 0,
        failed: session.failedShares || 0,
        successRate: session.completedShares > 0 ? 
          Math.round((session.completedShares / (session.completedShares + (session.failedShares || 0)) * 100) : 0,
        startedAt: session.createdAt,
        estimatedTime: estimatedTime < Infinity ? 
          formatTime(estimatedTime) : 'Calculating...'
      };
    });

  const totalShares = Object.values(sessions).reduce((sum, s) => sum + (s.completedShares || 0), 0);
  const totalFailed = Object.values(sessions).reduce((sum, s) => sum + (s.failedShares || 0), 0);
  const successRate = totalShares > 0 ? 
    Math.round((totalShares / (totalShares + totalFailed)) * 100) : 0;

  const message = {
    type: 'sessions_update',
    data: {
      activeSessions,
      stats: {
        totalShares,
        successRate
      }
    }
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  return [
    h > 0 ? `${h}h` : '',
    m > 0 ? `${m}m` : '',
    `${s}s`
  ].filter(Boolean).join(' ');
}

async function saveProgress(sessionId, progress) {
  const sessions = await readSessions();
  
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      createdAt: new Date().toISOString(),
      status: 'started',
      totalShares: 0,
      completedShares: 0,
      failedShares: 0,
      lastUpdated: new Date().toISOString()
    };
  }
  
  sessions[sessionId] = {
    ...sessions[sessionId],
    ...progress,
    lastUpdated: new Date().toISOString(),
    successRate: progress.completedShares > 0 ? 
      Math.round((progress.completedShares / 
        (progress.completedShares + (progress.failedShares || 0))) * 100) : 0
  };
  
  await writeSessions(sessions);
  await broadcastActiveSessions();
}

// Facebook API functions
async function validateCookie(cookie) {
  try {
    const headers = {
      "authority": "business.facebook.com",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "max-age=0",
      "cookie": cookie,
      "referer": "https://www.facebook.com/",
      "sec-ch-ua": '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
    };

    const response = await axios.get("https://business.facebook.com/content_management", { headers });
    return response.status === 200;
  } catch (error) {
    console.error("Cookie validation failed:", error.message);
    return false;
  }
}

async function getFacebookToken(cookie) {
  try {
    const headers = {
      "authority": "business.facebook.com",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "max-age=0",
      "cookie": cookie,
      "referer": "https://www.facebook.com/",
      "sec-ch-ua": '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
    };

    const response = await axios.get("https://business.facebook.com/content_management", { headers });
    const token = response.data.split("EAAG")[1].split('","')[0];
    return `${cookie}|EAAG${token}`;
  } catch (error) {
    console.error("Failed to retrieve token:", error.message);
    return null;
  }
}

async function getPostId(postLink) {
  try {
    const response = await axios.post(
      "https://id.traodoisub.com/api.php",
      new URLSearchParams({ link: postLink }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
        }
      }
    );
    return response.data.id || null;
  } catch (error) {
    console.error("Error getting post ID:", error.message);
    return null;
  }
}

async function performShare(cookie, token, postId) {
  try {
    const shareUrl = `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${postId}&published=0&access_token=${token}`;
    
    const headers = {
      "authority": "graph.facebook.com",
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "cookie": cookie,
      "referer": "https://www.facebook.com/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
    };

    const response = await axios.post(shareUrl, null, { headers });
    return response.data && response.data.id;
  } catch (error) {
    console.error("Share failed:", error.message);
    return false;
  }
}

async function shareInBackground(sessionId, cookie, url, amount, interval) {
  try {
    const isAlive = await validateCookie(cookie);
    if (!isAlive) {
      await saveProgress(sessionId, { 
        status: 'failed', 
        error: 'Invalid cookie',
        failedShares: amount
      });
      return;
    }

    const facebookToken = await getFacebookToken(cookie);
    if (!facebookToken) {
      await saveProgress(sessionId, { 
        status: 'failed', 
        error: 'Token retrieval failed',
        failedShares: amount
      });
      return;
    }
    const [retrievedCookie, token] = facebookToken.split("|");

    const postId = await getPostId(url);
    if (!postId) {
      await saveProgress(sessionId, { 
        status: 'failed', 
        error: 'Invalid post ID',
        failedShares: amount
      });
      return;
    }

    let successCount = 0;
    let failedCount = 0;
    const maxRetries = 3;

    await saveProgress(sessionId, { status: 'in_progress' });

    for (let i = 0; i < amount; i++) {
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
      
      let success = false;
      for (let retry = 0; retry < maxRetries; retry++) {
        success = await performShare(retrievedCookie, token, postId);
        if (success) break;
      }

      if (success) {
        successCount++;
      } else {
        failedCount++;
      }

      await saveProgress(sessionId, {
        completedShares: successCount,
        failedShares: failedCount
      });
    }

    await saveProgress(sessionId, {
      status: 'completed',
      completedShares: successCount,
      failedShares: failedCount
    });
  } catch (error) {
    await saveProgress(sessionId, {
      status: 'failed',
      error: error.message,
      failedShares: amount
    });
  }
}

function apiResponse(res, status, message, data = null) {
  const response = {
    data: {
      status: status,
      message: message,
      createdBy: "CyZsh0x",
      ...data
    }
  };
  return res.status(status).json(response);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Protected API endpoints
app.post("/api/v1/submit", checkHeader, async (req, res) => {
  try {
    const { cookie, url, amount, interval } = req.body;
    
    if (typeof cookie !== 'string' || 
        typeof url !== 'string' || 
        typeof amount !== 'number' || 
        typeof interval !== 'number') {
      return apiResponse(res, 400, "Invalid parameter types. Expected: cookie(string), url(string), amount(number), interval(number)");
    }

    const requiredCookieKeys = ['xs=', 'c_user=', 'fr=', 'datr='];
    const isValidCookie = requiredCookieKeys.some(key => cookie.includes(key));
    if (!isValidCookie) {
      return apiResponse(res, 400, "Invalid Facebook cookie format. Must contain authentication tokens.");
    }

    if (!url.match(/^https?:\/\/(www\.)?facebook\.com\/.+/i)) {
      return apiResponse(res, 400, "Invalid Facebook URL format. Must start with https://facebook.com/");
    }

    if (amount <= 0) {
      return apiResponse(res, 400, "Share amount must be at least 1 or greater than 0");
    }

    if (interval < 1 || interval > 60) {
      return apiResponse(res, 400, "Interval must be between 1 and 60 seconds");
    }

    const sessionId = generateSessionId();

    await saveProgress(sessionId, {
      status: 'started',
      totalShares: Math.floor(amount),
      completedShares: 0,
      url: url.trim(),
      interval: Math.max(1, Math.min(60, interval)),
      createdAt: new Date().toISOString()
    });

    shareInBackground(sessionId, cookie, url, Math.floor(amount), Math.max(1, interval))
      .catch(err => {
        console.error(`Background sharing error for session ${sessionId}:`, err);
        saveProgress(sessionId, {
          status: 'failed',
          error: err.message,
          failedShares: amount
        });
      });

    return apiResponse(res, 200, "Sharing process started successfully", {
      sessionId: sessionId
    });

  } catch (error) {
    console.error('Submit endpoint error:', error);
    return apiResponse(res, 500, "Internal server error", {
      error: error.message
    });
  }
});

app.get("/api/v1/total-sessions", checkHeader, async (req, res) => {
  try {
    const sessions = await readSessions();
    const activeSessions = Object.entries(sessions)
      .filter(([_, session]) => ['started', 'in_progress'].includes(session.status))
      .map(([id, session]) => ({
        id,
        shortId: id.slice(-4),
        url: session.url,
        amount: session.totalShares,
        interval: session.interval,
        completed: session.completedShares || 0,
        failed: session.failedShares || 0,
        status: session.status
      }));

    res.json({
      data: {
        activeSessions,
        totalShares: Object.values(sessions).reduce((sum, s) => sum + (s.completedShares || 0), 0),
        successRate: activeSessions.reduce((rate, s) => {
          const total = s.completed + s.failed;
          return total > 0 ? rate + (s.completed / total) : rate;
        }, 0) / (activeSessions.length || 1) * 100
      }
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Session cleanup on startup
initializeSessionStore().then(async () => {
  console.log('Session store initialized');
  
  // Clean up any in-progress sessions on startup
  const sessions = await readSessions();
  let needsUpdate = false;
  
  for (const [id, session] of Object.entries(sessions)) {
    if (session.status === 'in_progress') {
      sessions[id].status = 'failed';
      sessions[id].error = 'Server restart interrupted this session';
      needsUpdate = true;
    }
  }
  
  if (needsUpdate) {
    await writeSessions(sessions);
  }
});

// Error handling for persistence
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  try {
    await writeSessions(await readSessions()); // Force a save
  } catch (e) {
    console.error('Failed to save sessions during crash:', e);
  }
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('Server shutting down...');
  try {
    await writeSessions(await readSessions());
  } catch (e) {
    console.error('Failed to save sessions during shutdown:', e);
  }
  process.exit();
});

module.exports = app;