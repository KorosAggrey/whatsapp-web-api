// server.js - Enhanced WhatsApp HTTP Service with proper QR handling + logging
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { SessionManager } from './SessionManager.js';
import { Router } from '../lib/Router.js';
import { validateRequest } from '../middleware/validation.js';
import { errorHandler } from '../middleware/error.js';

const sessionManager = new SessionManager();
const router = new Router();

// Apply middleware
router.use(validateRequest);

// ===== SESSION ROUTES =====

// Create new session
router.post('/sessions', async (req, res) => {
  let { sessionId } = req.body;
  if (!sessionId) {
    sessionId = randomUUID();
  }

  console.log(`[POST] /sessions - Creating session ${sessionId}`);

  try {
    const result = await sessionManager.createSession(sessionId);
    console.log(`[POST] /sessions - Session ${sessionId} created`);
    res.status(201).json(result);
  } catch (error) {
    console.error(`[POST] /sessions - Error creating session ${sessionId}:`, error.message);
    res.status(400).json({ error: error.message });
  }
});

// Get session status
router.get('/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  console.log(`[GET] /sessions/${sessionId} - Fetching status`);

  try {
    const status = await sessionManager.getSessionStatus(sessionId);
    console.log(`[GET] /sessions/${sessionId} - Status fetched`);
    res.json(status);
  } catch (error) {
    console.error(`[GET] /sessions/${sessionId} - Error:`, error.message);
    res.status(404).json({ error: 'Session not found' });
  }
});

// Add sessionWebhook
router.post('/sessions/:sessionId/webhook', async (req, res) => {
  const { sessionId } = req.params;
  const { webhook } = req.body;

  console.log(`[POST] /sessions/${sessionId}/webhook - Setting webhook: ${webhook}`);

  try {
    const status = await sessionManager.setWebhook(sessionId, webhook);
    console.log(`[POST] /sessions/${sessionId}/webhook - Webhook set`);
    res.json(status);
  } catch (error) {
    console.error(`[POST] /sessions/${sessionId}/webhook - Error:`, error.message);
    res.status(404).json({ error: 'Session not found' });
  }
});

// Get QR code (with 60s timeout handling)
router.get('/sessions/:sessionId/qr', async (req, res) => {
  const { sessionId } = req.params;
  console.log(`[GET] /sessions/${sessionId}/qr - Requesting QR`);

  try {
    if (sessionManager.isQRActive(sessionId)) {
      const remaining = sessionManager.getQRTimeRemaining(sessionId);
      console.warn(`[GET] /sessions/${sessionId}/qr - QR already active (${remaining}s left)`);
      return res.status(409).json({
        error: 'QR_ALREADY_ACTIVE',
        message: 'QR code already generated for this session',
        retry_after: remaining,
        help: 'Wait for current QR to expire or scan it',
      });
    }

    const result = await sessionManager.generateQR(sessionId);
    console.log(`[GET] /sessions/${sessionId}/qr - QR generated`);
    res.json(result);
  } catch (error) {
    console.error(`[GET] /sessions/${sessionId}/qr - Error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Replace session
router.put('/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { preserveState = false } = req.body;

  console.log(`[PUT] /sessions/${sessionId} - Replacing session (preserveState=${preserveState})`);

  try {
    const result = await sessionManager.replaceSession(sessionId, { preserveState });
    console.log(`[PUT] /sessions/${sessionId} - Session replaced`);
    res.json(result);
  } catch (error) {
    console.error(`[PUT] /sessions/${sessionId} - Error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Destroy session
router.delete('/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  console.log(`[DELETE] /sessions/${sessionId} - Destroying session`);

  try {
    await sessionManager.destroySession(sessionId);
    console.log(`[DELETE] /sessions/${sessionId} - Session destroyed`);
    res.status(204).send();
  } catch (error) {
    console.error(`[DELETE] /sessions/${sessionId} - Error:`, error.message);
    res.status(404).json({ error: 'Session not found' });
  }
});

// ===== MESSAGE ROUTES =====

// Send message (text or media)
router.post('/sessions/:sessionId/messages', async (req, res) => {
  const { sessionId } = req.params;
  const { to, text, media, options } = req.body;

  console.log(`[POST] /sessions/${sessionId}/messages - Sending message to ${to}`);

  if (!to) {
    console.warn(`[POST] /sessions/${sessionId}/messages - Missing "to" field`);
    return res.status(400).json({
      error: 'Invalid request',
      help: 'Provide "to" (recipient phone number)',
    });
  }

  if (!text && !media) {
    console.warn(`[POST] /sessions/${sessionId}/messages - Missing content`);
    return res.status(400).json({
      error: 'Invalid request',
      help: 'Provide either "text" or "media"',
    });
  }

  if (media) {
    const { url, base64, mimetype } = media;
    if (!url && !base64) {
      console.warn(`[POST] /sessions/${sessionId}/messages - Invalid media`);
      return res.status(400).json({
        error: 'Invalid media',
        help: 'Media must include either "url" or "base64" with "mimetype"',
      });
    }
    if (base64 && !mimetype) {
      console.warn(`[POST] /sessions/${sessionId}/messages - Missing mimetype with base64`);
      return res.status(400).json({
        error: 'Invalid media',
        help: 'When using base64, "mimetype" is required',
      });
    }
  }

  try {
    const result = await sessionManager.sendMessage(sessionId, { to, text, media, options });
    console.log(`[POST] /sessions/${sessionId}/messages - Message sent to ${to}`);
    res.status(201).json(result);
  } catch (error) {
    console.error(`[POST] /sessions/${sessionId}/messages - Error:`, error.message);
    if (error.message.includes('not ready')) {
      res.status(503).json({
        error: 'Session not ready',
        help: 'Check session status or authenticate with QR',
      });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: 'Session not found' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ===== HEALTH & MONITORING =====

router.get('/health', async (req, res) => {
  console.log(`[GET] /health - Checking health status`);
  const health = await sessionManager.getHealthStatus();
  res.json(health);
});

// ===== SERVER SETUP =====

const server = createServer(async (req, res) => {
  console.log(`[SERVER] ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');

  if (req.method === 'OPTIONS') {
    console.log(`[SERVER] OPTIONS preflight handled for ${req.url}`);
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    await router.handle(req, res);
  } catch (error) {
    console.error(`[SERVER] Uncaught error:`, error.message);
    errorHandler(error, req, res);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[SERVER] SIGTERM received, shutting down gracefully...');
  await sessionManager.shutdown();
  server.close(() => {
    console.log('[SERVER] Closed successfully');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[SERVER] WhatsApp HTTP Service running on :${PORT}`);
});
