// ─── index.ts — Firebase Functions entry point (v7 / Gen2 compatible) ────────
//
// All routes handled by a single Express app exported as one HTTPS function.
// The function is deployed at:
//   https://us-central1-wireframe-ai-8079f.cloudfunctions.net/api
//
// Route map:
//   Trigger A: GET  /api/subscription/status
//   Trigger B: POST /api/features/generate/start|check|refund
//   Trigger C: POST /api/checkout/init
//   Trigger D: POST /api/checkout/topup
//   C+D webhook: POST /webhooks/dodo

import * as dotenv from 'dotenv';
dotenv.config();

import { setGlobalOptions } from 'firebase-functions';
import { onRequest } from 'firebase-functions/https';
import * as admin from 'firebase-admin';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';

import subscriptionRoutes from './modules/subscriptions/subscription.routes';
import paymentRoutes      from './modules/payments/payment.routes';
import aiRoutes           from './modules/ai/ai.routes';
import webhookRoutes      from './modules/webhooks/webhook.routes';
import { errorHandler }   from './middleware/error.middleware';
import { NotFoundError }  from './utils/errors';

// Limit concurrent containers to control costs
setGlobalOptions({ maxInstances: 10, region: 'us-central1' });

// Initialize Firebase Admin (uses default credentials in deployed env)
admin.initializeApp();

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

// CORS — allow Figma plugin iframe requests
app.use(cors({
  origin: [
    'https://www.figma.com',
    'https://figma.com',
    /^https?:\/\/localhost/,
  ],
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-figma-user-id', 'x-figma-user-name'],
}));

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
      next();
    };

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', done);
    req.on('error', done);

    setTimeout(done, 3000);
  }
);

// JSON parsing for all other routes
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/webhooks')) return next();
  express.json()(req, res, next);
});

// ─── Mount routes ─────────────────────────────────────────────────────────────

app.use('/api/subscription', subscriptionRoutes);  // Trigger A
app.use('/api/features',     aiRoutes);             // Trigger B
app.use('/api/checkout',     paymentRoutes);        // Trigger C + D
app.use('/webhooks',         webhookRoutes);        // Dodo payment webhook

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'wireframe-ai-backend' });
});

// 404 fallback
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new NotFoundError('Endpoint not found', 'not_found'));
});

// Global error handler middleware
app.use(errorHandler);

// ─── Export as Firebase HTTPS Function ───────────────────────────────────────

export const api = onRequest(app);
