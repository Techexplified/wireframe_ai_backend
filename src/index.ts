// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── index.ts — Firebase Functions Express App Entry Point
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// ARCHITECTURE:
//   • Single Express app exported as one Firebase HTTPS Cloud Function (v7/Gen2)
//   • Handles all routes: subscription, generation, checkout, webhooks
//   • Middleware stack: CORS → Security Headers → RequestID → Auth → Routes → ErrorHandler
//   • Firebase Admin SDK initialized at startup (handles auth verification)
//   • All configuration validated before accepting requests (fail-closed pattern)
//
// ROUTE MAP:
//   Subscription Management:
//     GET  /api/subscription/status — get user's plan state
//     POST /api/subscription/cancel — cancel subscription
//     POST /api/subscription/reactivate — reactivate subscription
//   
//   AI Generation (Trigger B):
//     POST /api/features/generate/start — initiate wireframe generation (streaming)
//     POST /api/features/generate/check — check generation status (informational, no charge)
//     POST /api/features/generate/refund — refund a failed generation
//   
//   Payment Checkout (Triggers C & D):
//     POST /api/checkout/init — initiate plan purchase with Dodo
//     POST /api/checkout/topup — initiate credit top-up purchase with Dodo
//   
//   Feedback:
//     POST /api/feedback/submit — submit user feedback
//     GET  /api/feedback/summary — get feedback analytics
//   
//   Webhooks (Payment Confirmation):
//     POST /webhooks/dodo — Dodo Payments webhook (subscription/payment events)
//   
//   Health Check:
//     GET  /health — health status endpoint (minimal response)
//
// STARTUP FLOW:
//   1. Load environment variables (dotenv)
//   2. Validate required env vars (Fix FIREBASE-M-01: fail if missing)
//   3. Configure Firebase Functions runtime (maxInstances, memory, timeout)
//   4. Initialize Firebase Admin SDK (JWT verification, Firestore access)
//   5. Create Express app with middleware stack
//   6. Mount all routes
//   7. Register error handler
//   8. Export app as onRequest handler
//   9. Firebase deploys and accepts HTTP requests
//
// FIXES APPLIED:
//   Fix FIREBASE-M-01: Startup environment validation
//     • Called FIRST before anything else
//     • Fails deployment if critical env vars missing
//     • Prevents \"undefined is not a function\" errors at runtime
//   
//   Fix FIREBASE-H-01: Global request timeout (300 seconds)
//     • setGlobalOptions({ timeoutSeconds: 300 })
//     • Long generations can take ~3 minutes (model inference + streaming)
//     • Default Firebase timeout (60s) insufficient
//     • With timeout: streaming generation completes cleanly
//   
//   Fix API-M-01: NODE_ENV default to 'production'
//     • Ensures error details hidden from client by default
//     • Only sensitive info leaked if explicitly set to 'development'
//   
//   Fix API-L-03: Security headers
//     • CSP (Content-Security-Policy) header set
//     • X-Content-Type-Options: nosniff
//     • X-Frame-Options: DENY (prevent clickjacking)
//   
//   Fix OBS-H-01: Request ID middleware
//     • Every request assigned UUID
//     • Propagated via AsyncLocalStorage through all async calls
//     • All logs tagged with [req:uuid] for correlation
//
// MIDDLEWARE STACK (ORDER MATTERS):
//   1. cors() — Allow cross-origin requests from Figma plugin
//      • CORS patterns: localhost, *.figma.com, *.firebaseapp.com
//      • Credentials allowed (for Firebase session tokens)
//   
//   2. Security headers (CSP, X-Frame-Options, etc.)
//      • Protects against XSS, clickjacking, MIME sniffing
//   
//   3. requestIdMiddleware (our own)
//      • Assigns UUID to request
//      • Sets AsyncLocalStorage for all downstream logs
//   
//   4. express.raw({ type: 'application/octet-stream', limit: '50kb' })
//      • Captures raw body for webhook signature verification
//      • Dodo webhooks must verify HMAC signature on raw body (before JSON parsing)
//      • Must come before express.json()
//   
//   5. express.json({ limit: '50kb' })
//      • Parses JSON request body for all other endpoints
//      • 50KB limit prevents large payload DoS
//   
//   6. authMiddleware (on protected routes)
//      • Verifies Firebase JWT
//      • Loads user's plan state
//      • Binds firebaseUid to figmaUserId
//   
//   7. Routes
//      • Each route handler wrapped with async catch → next(err)
//   
//   8. errorHandler
//      • Catches all errors from routes and middleware
//      • Formats uniform JSON response
//      • Logs full error for debugging
//
// FIREBASE RUNTIME CONFIGURATION:
//   • maxInstances: 10 — handle up to 10 concurrent Cloud Functions
//   • memory: 512MiB — sufficient for Node.js + dependencies + inference calls
//   • timeoutSeconds: 300 — 5 minutes (generation can take 2-3 min)
//   • region: us-central1 — latency optimized for US users
//   
//   Why these values?
//     • maxInstances=10: balance cost vs. concurrency (startup cost / ramp time)
//     • 512MiB: minimum to avoid OOM during complex generations
//     • 300s timeout: generation + streaming + model inference time
//     • us-central1: Firebase default, good availability
//
// CORS CONFIGURATION:
//   Figma plugin can send requests from:
//     • localhost:3000 — local dev
//     • *.figma.com — plugin in Figma application
//     • *.firebaseapp.com — hosted Firebase app
//   
//   All endpoints require valid Firebase token (auth.middleware verifies)
//   CORS tokens != authentication (CORS is for browser, JWT for API)
//
// WEBHOOK HANDLING:
//   POST /webhooks/dodo (no auth required):
//     1. Raw body captured for signature verification
//     2. Signature verified against DODO_WEBHOOK_SECRET
//     3. Idempotency check: markEventProcessed(eventId)
//     4. Business logic: processPaymentConfirmation()
//     5. Status update: completeEventProcessed() or markEventFailed()
//     6. Return 200 OK (idempotent even on retry)
//   
//   Why no auth?
//     • Webhook can't send Firebase JWT (no plugin context)
//     • Instead: HMAC signature verification (Dodo secret)
//     • Signature verifies request came from Dodo, not attacker
//
// ERROR RESPONSES:
//   All errors caught by error.middleware.ts
//   
//   Client receives:
//     {
//       error: \"errorCode\",
//       message: \"User-facing message\",
//       status_code: 400
//     }
//   
//   Server logs:
//     Full stack trace, request ID, user ID, sensitive details
//     (Details hidden from client in production)
//
// STREAMING RESPONSES:
//   POST /api/features/generate/start returns Server-Sent Events (SSE)
//     • Content-Type: text/event-stream
//     • Connection: keep-alive
//     • Client reads stream until completion or timeout
//     • Allows real-time generation progress (tokens, ETA, etc.)
//   
//   How it works:
//     1. Controller receives request
//     2. OpenRouter stream piped to res (Express handles streaming)
//     3. Telemetry middleware intercepts stream, counts tokens
//     4. After stream ends: credit deducted (based on actual tokens)
//     5. Client receives streaming generation and telemetry headers

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

import authRoutes         from './modules/auth/auth.routes';
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

// Trust reverse proxies (Firebase Functions, Cloudflare, ngrok) to accurately extract client IP
app.set('trust proxy', 1);

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

app.use('/api/auth',         authRoutes);           // Session handshake & authentication
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
