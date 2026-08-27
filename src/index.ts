// ─── index.ts — Firebase Functions entry point (v7 / Gen2 compatible) ────────
//
// All routes handled by a single Express app exported as one HTTPS function.
//
// Route map:
//   Trigger A: GET  /api/subscription/status
//   Trigger B: POST /api/features/generate/start|check|refund
//   Trigger C: POST /api/checkout/init
//   Trigger D: POST /api/checkout/topup
//   C+D webhook: POST /webhooks/dodo

import * as dotenv from 'dotenv';
dotenv.config();

// Fix FIREBASE-M-01: Validate required env vars at startup before anything else
import { validateStartupEnv } from './middleware/startup.validation';
validateStartupEnv();

import { setGlobalOptions } from 'firebase-functions';
import { onRequest }        from 'firebase-functions/https';
import * as admin           from 'firebase-admin';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';

import subscriptionRoutes from './modules/subscriptions/subscription.routes';
import paymentRoutes      from './modules/payments/payment.routes';
import aiRoutes           from './modules/ai/ai.routes';
import webhookRoutes      from './modules/webhooks/webhook.routes';
import feedbackRoutes     from './modules/feedback/feedback.routes';
import { errorHandler }   from './middleware/error.middleware';
import { NotFoundError }  from './utils/errors';
import { requestIdStore } from './utils/logger';

// Fix FIREBASE-H-01: Set 300s timeout so complex generations (Claude Sonnet, 32K tokens)
// are not killed mid-stream. Also increase memory for SSE stream buffering.
setGlobalOptions({ maxInstances: 10, region: 'us-central1', timeoutSeconds: 300, memory: '512MiB', invoker: 'public' });

// Initialize Firebase Admin (uses default credentials in deployed env)
admin.initializeApp();

// Fix API-M-01: Ensure NODE_ENV is set — defaults to 'production' if not specified
// so that internal error details are never leaked in API responses.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

// 1. CORS is mounted first with validated allowed origins
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(www\.)?figma\.com$/,
  /^https:\/\/[a-z0-9-]+\.ngrok-free\.app$/,
  /^https:\/\/[a-z0-9-]+\.ngrok\.io$/,
  /^http:\/\/localhost(:[0-9]+)?$/,
  /^http:\/\/127\.0\.0\.1(:[0-9]+)?$/,
  /^null$/,
];

app.use(cors({
  origin: (requestOrigin, callback) => {
    if (!requestOrigin) return callback(null, true);
    const isAllowed = ALLOWED_ORIGIN_PATTERNS.some(pattern => pattern.test(requestOrigin));
    if (isAllowed || requestOrigin === 'null') {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'x-figma-user-id',
    'x-figma-user-name',
    'x-admin-secret',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'ngrok-skip-browser-warning',
    'User-Agent'
  ],
  exposedHeaders: ['X-Credits-Left', 'X-Topup-Credits-Left', 'X-Credit-Pool', 'X-Reservation-Id'],
  credentials: true,
}));

// Preflight options handler
app.options('*', cors());

// Fix API-L-03 & NEW-L-03: Add security headers and CSP to every response
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'none'");
  next();
});

// Fix OBS-H-01: Attach a unique requestId to every request for log correlation
app.use((_req: Request, _res: Response, next: NextFunction) => {
  const requestId = crypto.randomUUID();
  requestIdStore.run(requestId, next);
});

// ── Raw body capture for webhook signature verification ───────────────────────
app.use(
  '/webhooks',
  (req: Request, _res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      const raw = Buffer.concat(chunks);
      (req as Request & { rawBody: Buffer }).rawBody =
        raw.length > 0 ? raw : Buffer.from(JSON.stringify(req.body || ''));
      if ((!req.body || Object.keys(req.body).length === 0) && raw.length > 0) {
        try {
          req.body = JSON.parse(raw.toString('utf8'));
        } catch {}
      }
      next();
    };

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', done);
    req.on('error', done);
    setTimeout(done, 3000);
  }
);

// Fix API-H-01: Apply explicit JSON body size limit (50KB) for all non-webhook routes
// Prompts over 50KB are rejected before they reach any controller logic.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/webhooks')) return next();
  express.json({ limit: '50kb' })(req, res, next);
});

// ─── Mount routes ─────────────────────────────────────────────────────────────

app.use('/api/subscription', subscriptionRoutes);  // Trigger A
app.use('/api/features',     aiRoutes);             // Trigger B
app.use('/api/checkout',     paymentRoutes);        // Trigger C + D
app.use('/api/feedback',     feedbackRoutes);       // User Feedback Module
app.use('/webhooks',         webhookRoutes);        // Dodo payment webhook

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// 404 fallback
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError('Endpoint not found', 'not_found'));
});

// Global error handler
app.use(errorHandler);

// ─── Export as Firebase HTTPS Function ───────────────────────────────────────

export const wireframeApi = onRequest({ invoker: 'public' }, app);
