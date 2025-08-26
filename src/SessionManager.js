// SessionManager.js - Enhanced Session Management with QR timeout handling + logging

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { EventEmitter } from 'events';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import axios from 'axios';

const MessageMedia = pkg.MessageMedia || pkg.default?.MessageMedia;

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.qrStates = new Map();
    this.AUTH_DIR = process.env.AUTH_DIR || './.wwebjs_auth';
  }

  sessionExistsOnDisk(sessionId) {
    const sessionPath = join(this.AUTH_DIR, `session-${sessionId}`);
    const exists = existsSync(sessionPath);
    console.log(`[SessionManager] sessionExistsOnDisk(${sessionId}) -> ${exists}`);
    return exists;
  }

  async loadSessionFromDisk(sessionId) {
    if (!this.sessionExistsOnDisk(sessionId)) {
      console.log(`[SessionManager] No session on disk for ${sessionId}`);
      return null;
    }

    console.log(`[SessionManager] Loading session ${sessionId} from disk`);
    const session = {
      id: sessionId,
      client: null,
      status: 'initializing',
      info: null,
      qr: null,
      createdAt: new Date(),
      webhook: null,
    };

    this.sessions.set(sessionId, session);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: this.AUTH_DIR }),
      puppeteer: {
        headless: true,
        executablePath:
          process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      qrMaxRetries: 1,
    });

    session.client = client;
    this.setupClientEvents(sessionId, client);

    try {
      await client.initialize();
      await new Promise((r) => setTimeout(r, 2000));
      console.log(`[SessionManager] Session ${sessionId} initialized from disk`);
      return session;
    } catch (error) {
      console.error(
        `[SessionManager] Failed to load session ${sessionId} from disk:`,
        error.message
      );
      this.sessions.delete(sessionId);
      return null;
    }
  }

  isQRActive(sessionId) {
    const qrState = this.qrStates.get(sessionId);
    const active = qrState && qrState.active && Date.now() - qrState.timestamp < 60000;
    console.log(`[SessionManager] isQRActive(${sessionId}) -> ${active}`);
    return active;
  }

  getQRTimeRemaining(sessionId) {
    const qrState = this.qrStates.get(sessionId);
    if (!qrState || !qrState.active) {
      return 0;
    }
    const elapsed = Date.now() - qrState.timestamp;
    const remaining = Math.max(0, 60 - Math.floor(elapsed / 1000));
    console.log(`[SessionManager] getQRTimeRemaining(${sessionId}) -> ${remaining}s`);
    return remaining;
  }

  async createSession(sessionId) {
    console.log(`[SessionManager] Creating session ${sessionId}`);

    if (this.sessions.has(sessionId)) {
      console.error(`[SessionManager] Session ${sessionId} already exists`);
      throw new Error('Session already exists');
    }

    const session = {
      id: sessionId,
      client: null,
      status: 'initializing',
      info: null,
      qr: null,
      createdAt: new Date(),
      webhook: null,
    };

    this.sessions.set(sessionId, session);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: this.AUTH_DIR }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
      qrMaxRetries: 1,
    });

    session.client = client;
    this.setupClientEvents(sessionId, client);

    client.initialize().catch((err) => {
      console.error(`[SessionManager] Failed to initialize session ${sessionId}:`, err.message);
      session.status = 'error';
      session.error = err.message;
    });

    return { sessionId, status: session.status, message: 'Session created, initializing...' };
  }

  async generateQR(sessionId) {
    console.log(`[SessionManager] generateQR(${sessionId}) called`);
    let session = this.sessions.get(sessionId);

    if (!session && this.sessionExistsOnDisk(sessionId)) {
      session = await this.loadSessionFromDisk(sessionId);
    }

    if (!session) {
      console.error(`[SessionManager] No session found for QR generation: ${sessionId}`);
      throw new Error('Session not found');
    }

    if (session.status === 'disconnected') {
      console.log(`[SessionManager] Restarting disconnected session ${sessionId}`);
      if (session.client) {
        await session.client.destroy().catch(() => {});
      }
      this.sessions.delete(sessionId);
      this.qrStates.delete(sessionId);
      await this.createSession(sessionId);
      session = this.sessions.get(sessionId);
    }

    if (session.status === 'ready') {
      console.log(`[SessionManager] Session ${sessionId} already authenticated`);
      return { status: 'ready', message: 'Session already authenticated', info: session.info };
    }

    if (this.isQRActive(sessionId)) {
      console.warn(`[SessionManager] QR already active for ${sessionId}`);
      throw new Error('QR generation already in progress');
    }

    this.qrStates.set(sessionId, { active: true, timestamp: Date.now(), qr: null });
    setTimeout(() => {
      const qrState = this.qrStates.get(sessionId);
      if (qrState && qrState.active) {
        qrState.active = false;
        console.warn(`[SessionManager] QR expired for ${sessionId}`);
        this.emit('qr:expired', { sessionId });
      }
    }, 60000);

    if (session.qr) {
      console.log(`[SessionManager] Returning cached QR for ${sessionId}`);
      this.qrStates.get(sessionId).qr = session.qr;
      return {
        status: 'qr',
        qr: session.qr,
        expires_in: 60,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        instructions: [
          '1. Open WhatsApp on your phone',
          '2. Go to Settings → Linked Devices',
          '3. Tap "Link a Device"',
          '4. Scan this QR code within 60 seconds',
        ],
      };
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error(`[SessionManager] QR generation timeout for ${sessionId}`);
        reject(new Error('QR generation timeout'));
      }, 10000);

      session.client.once('qr', (qr) => {
        clearTimeout(timeout);
        console.log(`[SessionManager] QR generated for ${sessionId}`);
        const qrState = this.qrStates.get(sessionId);
        if (qrState) {
          qrState.qr = qr;
        }
        resolve({
          status: 'qr',
          qr,
          expires_in: 60,
          expires_at: new Date(Date.now() + 60000).toISOString(),
          instructions: [
            '1. Open WhatsApp on your phone',
            '2. Go to Settings → Linked Devices',
            '3. Tap "Link a Device"',
            '4. Scan this QR code within 60 seconds',
          ],
        });
      });
    });
  }

  async replaceSession(sessionId, options = {}) {
    console.log(
      `[SessionManager] Replacing session ${sessionId}, preserveState=${options.preserveState}`
    );
    const existingSession = this.sessions.get(sessionId);
    let savedState = null;

    if (existingSession && options.preserveState && existingSession.status === 'ready') {
      savedState = { info: existingSession.info, createdAt: existingSession.createdAt };
    }

    if (existingSession) {
      await this.destroySession(sessionId);
    }
    await new Promise((r) => setTimeout(r, 1000));
    const result = await this.createSession(sessionId);

    if (savedState) {
      const newSession = this.sessions.get(sessionId);
      newSession.replacedAt = new Date();
      newSession.previousState = savedState;
    }

    return { ...result, replaced: true, preservedState: options.preserveState };
  }

  async setWebhook(sessionId, webhook) {
    console.log(`[SessionManager] Setting webhook for ${sessionId} -> ${webhook}`);
    let session = this.sessions.get(sessionId);
    if (!session && this.sessionExistsOnDisk(sessionId)) {
      session = await this.loadSessionFromDisk(sessionId);
    }
    if (!session) {
      throw new Error('Session not found');
    }
    session.webhook = webhook;
    return this.getSessionStatus(sessionId);
  }

  async getSessionStatus(sessionId) {
    console.log(`[SessionManager] getSessionStatus(${sessionId})`);
    let session = this.sessions.get(sessionId);
    if (!session && this.sessionExistsOnDisk(sessionId)) {
      session = await this.loadSessionFromDisk(sessionId);
    }
    if (!session) {
      throw new Error('Session not found');
    }
    return {
      sessionId,
      status: session.status,
      info: session.info,
      qrActive: this.isQRActive(sessionId),
      qrTimeRemaining: this.getQRTimeRemaining(sessionId),
      createdAt: session.createdAt,
      replacedAt: session.replacedAt,
      webhook: session.webhook,
    };
  }

  async sendMessage(sessionId, params) {
    console.log(`[SessionManager] sendMessage(${sessionId}) to=${params.to}`);
    let session = this.sessions.get(sessionId);
    if (!session && this.sessionExistsOnDisk(sessionId)) {
      session = await this.loadSessionFromDisk(sessionId);
    }
    if (!session) {
      throw new Error('Session not found');
    }
    if (session.status !== 'ready') {
      throw new Error('Session not ready');
    }

    const { to, text, media, options = {} } = params;
    if (!text && !media) {
      throw new Error('Must provide either text or media');
    }

    const formattedNumber = this.formatPhoneNumber(to);
    const chatId = formattedNumber + '@c.us';
    let content;

    if (media) {
      try {
        const { url, base64, mimetype, filename } = media;
        if (url) {
          console.log(`[SessionManager] Fetching media from URL for ${sessionId}`);
          content = await MessageMedia.fromUrl(url);
        } else if (base64 && mimetype) {
          console.log(`[SessionManager] Using base64 media for ${sessionId}`);
          content = new MessageMedia(mimetype, base64, filename);
        } else {
          throw new Error('Media must include either url or base64+mimetype');
        }
      } catch (err) {
        console.error(`[SessionManager] Failed to process media for ${sessionId}:`, err.message);
        throw new Error(`Failed to process media: ${err.message}`);
      }
    } else {
      content = text;
    }

    const message = await session.client.sendMessage(chatId, content, options);
    console.log(`[SessionManager] Message sent from ${sessionId} to ${formattedNumber}`);

    return {
      success: true,
      messageId: message.id._serialized,
      to: formattedNumber,
      type: media ? 'media' : 'text',
      timestamp: new Date().toISOString(),
    };
  }

  async destroySession(sessionId) {
    console.log(`[SessionManager] destroySession(${sessionId})`);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    try {
      if (session.client) {
        await session.client.destroy();
      }
      console.log(`[SessionManager] Session ${sessionId} client destroyed`);
    } catch (err) {
      console.error(`[SessionManager] Error destroying session ${sessionId}:`, err.message);
    }
    this.sessions.delete(sessionId);
    this.qrStates.delete(sessionId);
  }

  async getAllSessions() {
    console.log(`[SessionManager] getAllSessions()`);
    const inMemory = Array.from(this.sessions.keys());
    let onDisk = [];
    try {
      onDisk = readdirSync(this.AUTH_DIR)
        .filter((d) => d.startsWith('session-'))
        .map((d) => d.replace('session-', ''));
    } catch (err) {
      console.warn(`[SessionManager] Could not read auth dir:`, err.message);
    }
    const all = [...new Set([...inMemory, ...onDisk])];
    console.log(`[SessionManager] Found ${all.length} sessions`);
    return all;
  }

  async getHealthStatus() {
    console.log(`[SessionManager] getHealthStatus()`);
    const sessions = Array.from(this.sessions.values());
    const allSessions = await this.getAllSessions();
    return {
      status: 'ok',
      uptime: process.uptime(),
      sessions: {
        total: allSessions.length,
        ready: sessions.filter((s) => s.status === 'ready').length,
        initializing: sessions.filter((s) => s.status === 'initializing').length,
        qr_pending: sessions.filter((s) => s.status === 'qr').length,
        error: sessions.filter((s) => s.status === 'error').length,
      },
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
      },
    };
  }

  async shutdown() {
    console.log(`[SessionManager] shutdown() called`);
    const promises = Array.from(this.sessions.keys()).map((sid) =>
      this.destroySession(sid).catch((err) =>
        console.error(`[SessionManager] Error destroying ${sid} during shutdown:`, err.message)
      )
    );
    await Promise.all(promises);
  }

  async callWebhook(url, payload) {
    console.log(`[SessionManager] callWebhook -> ${url}`);
    try {
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      });
      console.log(`[SessionManager] Webhook success: ${response.status}`);
      return response.data;
    } catch (err) {
      console.error(`[SessionManager] Webhook call failed:`, err.message);
    }
  }

  setupClientEvents(sessionId, client) {
    const session = this.sessions.get(sessionId);

    client.on('qr', (qr) => {
      console.log(`[SessionManager] QR received for ${sessionId}`);
      session.status = 'qr';
      session.qr = qr;
      this.emit('session:qr', { sessionId, qr });
    });

    client.on('authenticated', () => {
      console.log(`[SessionManager] Session ${sessionId} authenticated`);
      session.status = 'authenticated';
      session.qr = null;
      const qrState = this.qrStates.get(sessionId);
      if (qrState) {
        qrState.active = false;
      }
      this.emit('session:authenticated', { sessionId });
    });

    client.on('message_create', (message) => {
      console.log(`[SessionManager] Incoming message for ${sessionId}`);
      const isValidUrl = (val) => {
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      };
      if (session.webhook && isValidUrl(session.webhook)) {
        console.log(`[SessionManager] Forwarding message to webhook: ${session.webhook}`);
        this.callWebhook(session.webhook, { sessionId, message });
      } else {
        console.log(`[SessionManager] Webhook invalid or not set for ${sessionId}`);
      }
      if (message.body === '!ping') {
        client.sendMessage(message.from, 'pong');
      }
    });

    client.on('ready', () => {
      console.log(`[SessionManager] Session ${sessionId} ready`);
      session.status = 'ready';
      session.info = client.info;
      this.emit('session:ready', { sessionId, info: client.info });
    });

    client.on('auth_failure', (msg) => {
      console.error(`[SessionManager] Auth failure for ${sessionId}:`, msg);
      session.status = 'auth_failure';
      session.error = msg;
      this.emit('session:auth_failure', { sessionId, message: msg });
    });

    client.on('disconnected', (reason) => {
      console.log(`[SessionManager] Session ${sessionId} disconnected: ${reason}`);
      session.status = reason === 'LOGOUT' ? 'logged_out' : 'disconnected';
      session.disconnectReason = reason;
      this.qrStates.delete(sessionId);
      this.emit('session:disconnected', { sessionId, reason });
    });

    client.on('message', (msg) => {
      console.log(`[SessionManager] Message received in ${sessionId} from ${msg.from}`);
      this.emit('message:received', {
        sessionId,
        message: {
          id: msg.id._serialized,
          from: msg.from,
          to: msg.to,
          body: msg.body,
          timestamp: msg.timestamp,
        },
      });
    });
  }

  formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('55') && cleaned.length === 13 && cleaned[4] === '9') {
      cleaned = '55' + cleaned.substring(2, 4) + cleaned.substring(5);
    }
    console.log(`[SessionManager] formatPhoneNumber(${phone}) -> ${cleaned}`);
    return cleaned;
  }
}
