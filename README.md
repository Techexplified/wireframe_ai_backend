# ⚡ Wireframe AI — High-Fidelity Wireframe Generator for Figma

> An enterprise-grade, AI-powered wireframe generation system for Figma. Converts natural language prompts into responsive, themeable, high-fidelity UI wireframes and design systems directly on the Figma canvas.

> **Last Updated**: 27 August 2026 — Reflects all webhook security hardening, payment failure revocation, feedback module, and updated AI model lineup.

---

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [System Flow & Design Pipeline](#-system-flow--design-pipeline)
- [Backend Infrastructure & Microservices](#-backend-infrastructure--microservices)
- [Pricing, AI Models & Credit Economics](#-pricing-ai-models--credit-economics)
- [Security & Financial Integrity Architecture](#-security--financial-integrity-architecture)
- [Database Schema & Collections](#-database-schema--collections)
- [API Reference](#-api-reference)
- [Environment Configuration](#-environment-configuration)
- [Webhook Event Lifecycle](#-webhook-event-lifecycle)
- [Development, Testing & Deployment](#-development-testing--deployment)

---

## 🏛️ Architecture Overview

The platform consists of two integrated tiers:

1. **Figma Plugin Frontend (`src/`)**:
   - **Sandbox Controller (`code.ts`)**: Secure Figma runtime execution; handles font preloading, DOM-to-Figma node hierarchy construction, auto-layout computation, vector asset placement, and component theming.
   - **Plugin UI (`ui.html`)**: Interactive interface with real-time SSE stream reader, template library (138+ templates), live generation progress visualizer, credit balance manager, and checkout integration.

2. **Serverless Cloud Backend (`functions/`)**:
   - **Firebase Functions Gen2 (Express Gateway)**: Scalable, serverless REST & SSE streaming API running in `us-central1` with 300s streaming execution timeout.
   - **AI Orchestration Engine**: Multi-pillar pipeline that analyzes prompt complexity (1–10), dynamically budgets tokens (6K–32K), resolves optimal models via OpenRouter, and measures real-time token telemetry.
   - **Payment & Credit Vault**: Dodo Payments checkout and webhook processing with HMAC-SHA256 signature verification, replay protection, and server-side atomic credit reservation tracking.
   - **MongoDB Atlas Cluster**: High-performance persistence layer utilizing atomic query operators (`$gte`, `$inc`, `$setOnInsert`), unique constraints, and automated TTL cleanup indexes.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Figma Client Runtime                          │
│                                                                        │
│   ┌────────────────────────┐             ┌─────────────────────────┐   │
│   │   Figma UI (iframe)    │  postMessage│  Figma Sandbox (code.ts)│   │
│   │ • SSE Stream Consumer  ├────────────►│ • Font Loader           │   │
│   │ • Dodo Checkout Trigger│             │ • Canvas Node Serializer│   │
│   │ • Auth & Credit Store  │◄────────────┤ • Auto-Layout Engine    │   │
│   └───────────┬────────────┘             └─────────────────────────┘   │
└───────────────┼────────────────────────────────────────────────────────┘
                │ HTTPS + Server-Sent Events (SSE)
                │ [Bearer Token / x-figma-user-id]
┌───────────────▼────────────────────────────────────────────────────────┐
│                  Firebase Functions Gen2 (Express App)                 │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │                        Middleware Pipeline                         │ │
│ │ Startup Guard ➔ CORS ➔ Body Limit ➔ RequestId (AsyncLocalStorage)  │ │
│ │ ➔ Auth Guard (Firebase Token + UID Binding) ➔ Sliding Rate Limiter │ │
│ │ ➔ Daily Quota Enforcer ➔ Complexity & Budget Pre-Flight Check      │ │
│ └─────────────────────────────────┬──────────────────────────────────┘ │
│                                   │                                    │
│        ┌──────────────────────────┴──────────────────────────┐         │
│        ▼                                                     ▼         │
│ ┌───────────────┐                                     ┌──────────────┐ │
│ │ AI Controller │                                     │ Payment &    │ │
│ │ • Reservation │                                     │ Webhook Hub  │ │
│ │ • Telemetry   │                                     │ • Dodo HMAC  │ │
│ │ • Abort/Refund│                                     │ • Idempotency│ │
│ └──────┬────────┘                                     │ • Expiry/Rev.│ │
│        │                                              └──────┬───────┘ │
└────────┼─────────────────────────────────────────────────────┼─────────┘
         │                                                     │
         ▼                                                     ▼
┌──────────────────┐                                ┌────────────────────┐
│   OpenRouter     │                                │   Dodo Payments    │
│  Streaming API   │                                │  Checkout Platform │
└──────────────────┘                                └────────────────────┘
         ▲                                                     ▲
         └──────────────────────────┬──────────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │    MongoDB Atlas    │
                         │ • Users & Credits   │
                         │ • Reservations (TTL)│
                         │ • Telemetry Logs    │
                         │ • Webhook Events    │
                         └─────────────────────┘
```

---

## 🎨 System Flow & Design Pipeline

1. **User Prompt Input**: User selects device (Desktop, Tablet, Mobile), fidelity, aesthetic style, and AI model in the Figma plugin.
2. **Pre-flight Validation & Routing**:
   - `aiRateLimitMiddleware` checks user sliding-window limit (1 per 30s for Free, 3 per 10s for Pro).
   - `aiQuotaMiddleware` verifies daily token quota.
   - `aiBudgetMiddleware` computes prompt complexity score (1–10) and verifies estimated USD cost against the plan's per-request cap.
3. **Atomic Credit Reservation**:
   - Server resolves model credit cost (e.g. Luna = 1, Gemini 3.7 = 2). Free-tier accounts are permanently routed to Luna (1 credit).
   - MongoDB atomically deducts credits using `{$gte: cost}` and generates an authoritative `CreditReservationDoc` with a 10-minute TTL.
4. **Streaming AI Generation**:
   - OpenRouter streaming connection opened with 120s socket timeout.
   - Output SSE stream piped in real time to the Figma plugin.
   - If user disconnects or cancels, `res.on('close')` immediately aborts the OpenRouter connection and refunds credits.
5. **Post-Processing & Telemetry**:
   - On completion, `ai_requests_log` captures exact token metrics (prompt, completion, reasoning tokens) and calculates actual USD cost.
   - `daily_token_quotas` increments token count.
   - `settleReservation()` marks credit reservation as complete.
6. **Canvas Node Construction**:
   - Figma UI iframe parses streaming HTML chunks with `DOMParser`.
   - Plugin sandbox recursively builds native Figma Auto-Layout Frames, Text Layers with mapped Google Fonts (Inter, Outfit, Poppins, Playfair Display), Gradients, Vector Icons, and Component Sets.

---

## 🧩 Backend Infrastructure & Microservices

The backend source is located in [`functions/src/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/):

| Directory / Module | Description |
|---|---|
| [`config/constants.ts`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/config/constants.ts) | **Single Source of Truth** for plan quotas, model pricing, credit pack tiers, rate limit configs, and cost caps. |
| [`config/database.ts`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/config/database.ts) | Re-export barrel for all collection accessors and TypeScript document interfaces. |
| [`config/db.connect.ts`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/config/db.connect.ts) | MongoDB connection singleton with lazy reconnect, connection pooling, and automatic index & TTL management. |
| [`config/user.model.ts`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/config/user.model.ts) | TypeScript document interfaces for all database collections (`UserDoc`, `CreditReservationDoc`, `FeedbackDoc`, etc.). |
| [`modules/ai/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/modules/ai/) | AI streaming controller, complexity scoring engine (`ai.complexity.ts`), model routing policy (`ai.router.ts`), and telemetry logger (`ai.telemetry.ts`). |
| [`modules/credits/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/modules/credits/) | Atomic credit reservation service, refund manager, settlement, and balance verification. |
| [`modules/payments/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/modules/payments/) | Dodo Payments checkout session initiator (`createPlanCheckout`, `createTopUpCheckout`), webhook signature validator, and subscription management API (`cancelSubscription`, `reactivateSubscription`). |
| [`modules/subscriptions/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/modules/subscriptions/) | Subscription status, cancel, and reactivate route handlers. |
| [`modules/users/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/modules/users/) | User lifecycle manager: `getActivePlanState`, `findOrCreate`, `activatePlan`, `revokeFailedPaymentPass`, `expirePass`, and trial credit provisioner. |
| [`modules/webhooks/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/modules/webhooks/) | Dodo Payments webhook handler with idempotency, signature verification, and event-specific business logic (activation, revocation, cancellation, refund). |
| [`modules/feedback/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/modules/feedback/) | User feedback submission and admin summary/analytics endpoint. |
| [`middleware/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/middleware/) | Security guards: Firebase token auth (`auth.middleware.ts`), checkout rate limiting, require-pro guard, startup env validation, and global error handler. |
| [`utils/`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/functions/src/utils/) | Shared utilities: structured logger with `AsyncLocalStorage` request IDs, idempotency helpers, error classes (`AppError`, `BadRequestError`, `UnauthorizedError`, etc.), and response formatter. |

---

## 💰 Pricing, AI Models & Credit Economics

### Plan Tiers

| Plan | Price | Included Credits | Pass Duration | Daily Token Quota | Rate Limit | Per-Request Cost Cap |
|---|---|---|---|---|---|---|
| **Free Trial** | Free | **3 credits** (one-time) | Lifetime | 50,000 tokens | 1 req / 30s | $0.10 |
| **Pro Plan** | $20.00 / month | **100 credits** | 30 days | 500,000 tokens | 3 req / 10s | $0.80 |

### Top-Up Credit Packs (Pro Subscribers Only)

| Pack | Credits Granted | Price | Unit Price | Dodo Product ID Variable |
|---|---|---|---|---|
| **Small Pack** | 20 Credits | $4.99 | ~$0.25 / credit | `DODO_PRODUCT_TOPUP_SMALL` |
| **Medium Pack** | 50 Credits | $9.99 | ~$0.20 / credit | `DODO_PRODUCT_TOPUP_MEDIUM` |
| **Large Pack** | 100 Credits | $19.99 | ~$0.20 / credit | `DODO_PRODUCT_TOPUP_LARGE` |

### Supported AI Models & Routing

| Model Key | Provider & Model Name | Credit Cost | Cost / 1M Input | Cost / 1M Output | Default For |
|---|---|---|---|---|---|
| `gpt-5-6-luna` | OpenAI GPT-5.6 Luna | **1 credit** | $0.10 | $0.60 | **Default / Free Trial** |
| `deepseek-v4-pro` | DeepSeek V4 Pro | **1 credit** | $0.44 | $0.87 | Ultra-Fast & Intelligent |
| `gemini-3-7` | Google Gemini 3.7 Flash | **2 credits** | $0.10 | $0.40 | Fast Wireframes |

> **Smart Routing Policy**: Free-tier trial users are always routed to `openai/gpt-5.6-luna` (1 credit cost) regardless of model selection in the UI to prevent trial overcharging. Pro users have full unhindered access to all models.

---

## 🔒 Security & Financial Integrity Architecture

Following our comprehensive 15-point production security audit, the platform implements enterprise-grade security controls:

```
                  ┌──────────────────────────────────────────────┐
                  │          Inbound Client Request              │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 1. Firebase Bearer Token Verification        │
                  │    • Admin SDK checks JWT signature & expiry │
                  │    • Enforces 1:1 UID ↔ figmaUserId binding  │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 2. Server-Side Credit Reservation Vault      │
                  │    • Atomic check: {$gte: cost} in MongoDB   │
                  │    • Issues UUID reservationId (10-min TTL)  │
                  │    • Client CANNOT forge refund amount/pool  │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 3. Active Stream & Disconnect Safety         │
                  │    • 120s OpenRouter timeout                 │
                  │    • res.on('close') aborts upstream call    │
                  │    • Automatic refund on stream termination  │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 4. Dodo Webhook Verification Engine          │
                  │    • HMAC-SHA256 timingSafeEqual check       │
                  │    • 300s timestamp replay window (PAY-C-01) │
                  │    • Atomic eventId idempotency index        │
                  │    • Immediate revocation on refund/reversal │
                  └──────────────────────────────────────────────┘
```

1. **Authentication & Identity Binding (`AUTH-C-01`)**:
   - Requests must carry `Authorization: Bearer <Firebase ID Token>`.
   - On initial login, the Firebase UID is immutably bound to the user's `figmaUserId`. Subsequent requests verify this one-to-one mapping, preventing cross-user account takeovers and fake UUID generation farming.
2. **Server-Side Credit Reservation Authority (`CREDIT-C-01`)**:
   - When `/generate/start` executes, a `CreditReservationDoc` is created in MongoDB recording the exact cost, pool, and timestamp.
   - The `/generate/refund` endpoint accepts **only** a `reservationId`. The server looks up the reservation record and refunds the authoritative amount. Clients cannot inject arbitrary refund sums.
3. **Webhook Replay & Tamper Protection (`PAY-C-01`, `PAY-M-01`)**:
   - Dodo webhooks verify HMAC-SHA256 signatures with `crypto.timingSafeEqual`.
   - Timestamp validation rejects payloads older than 300 seconds (5 minutes), eliminating replay attacks.
   - Unique MongoDB index on `eventId` guarantees exactly-once processing.
   - `payment.refunded` and `payment.reversed` webhook events automatically revoke plan status and expire credits.
4. **AI Reliability & DoS Guards**:
   - OpenRouter requests include a strict 120s timeout.
   - Client disconnects trigger upstream request destruction (`cancelStream()`) and credit refund.
   - Maximum request body size is capped at 50KB; Firebase Function execution timeout configured to 300 seconds.

---

## 🗄️ Database Schema & Collections

Database: **`wireframe_ai`** (MongoDB Atlas)

### 1. `users`
Primary user account and plan status ledger.
```typescript
interface UserDoc {
  figmaUserId: string;              // Primary lookup key (Unique Index)
  firebaseUid?: string;             // Firebase Anonymous UID (Sparse Unique Index)
  name?: string;                    // User display name (max 200 chars)
  plan: 'free' | 'pro';             // Active plan tier
  credits: number;                  // Standard plan credit balance
  topup_credits: number;            // Purchased top-up credit balance
  subscription_started_at: Date | null;
  subscription_ends_at: Date | null;
  dodo_subscription_id?: string | null;   // Dodo Payments subscription ID for cancel/reactivate
  subscription_cancelled?: boolean;       // True if user cancelled auto-renewal
  last_payment_attempt?: PaymentAttemptInfo | null; // Most recent failed payment info (cleared on success)
  createdAt: Date;
  updatedAt?: Date;
}

interface PaymentAttemptInfo {
  payment_id?: string;
  status: 'failed' | 'succeeded';
  error_code?: string;
  error_message?: string;
  failed_at?: Date;
}
```

### 2. `credit_reservations`
Temporary server-side vault tracking in-flight generation credit deductions.
```typescript
interface CreditReservationDoc {
  reservationId: string;            // UUID v4 (Unique Index)
  figmaUserId: string;              // Compound Index with status
  cost: number;                     // Authoritative deduction amount
  pool: 'plan' | 'topup';           // Deducted pool
  status: 'pending' | 'settled' | 'refunded';
  reservedAt: Date;
  expiresAt: Date;                  // TTL Index (Auto-expires after 10 minutes)
}
```

### 3. `processed_webhooks`
Deduplication table for payment webhook events.
```typescript
interface ProcessedWebhookDoc {
  eventId: string;                  // Dodo event/payment ID (Unique Index)
  processedAt: Date;                // TTL Index (Auto-expires after 90 days)
  status: 'processing' | 'completed' | 'failed';  // Allows safe retry of failed events
  updatedAt?: Date;
}
```

### 4. `usage_logs`
Historical ledger for generation tracking.
```typescript
interface UsageLogDoc {
  figmaUserId: string;              // Indexed with timestamp
  action: string;                   // 'generate_wireframe'
  creditsUsed: number;
  pool: 'plan' | 'topup';
  reservationId?: string;           // Links to credit_reservations record
  promptSnippet?: string;           // Truncated prompt (max 80 chars)
  timestamp: Date;                  // TTL Index (Auto-expires after 180 days)
}
```

### 5. `ai_requests_log`
Complete OpenRouter telemetry and billing audit trail.
```typescript
interface AiRequestLogDoc {
  figmaUserId: string;
  model: string;                    // OpenRouter model string
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;          // Captured for Claude/reasoning models
  totalTokens: number;
  estimatedCostUSD: number;         // Computed based on MODEL_PRICING table
  finishReason: string;             // 'stop' | 'length' | 'error'
  durationMs: number;
  complexityScore: number;          // 1 - 10
  tokenBudget: number;              // 6,144 - 32,768
  timestamp: Date;                  // TTL Index (Auto-expires after 90 days)
}
```

### 6. `generation_rate_limits`
Sliding-window request attempt log.
```typescript
interface RateLimitDoc {
  figmaUserId: string;              // Compound index with requestedAt
  requestedAt: Date;                // TTL Index (Auto-expires after 120 seconds)
}
```

### 7. `daily_token_quotas`
Per-user UTC daily token accumulator.
```typescript
interface DailyQuotaDoc {
  figmaUserId: string;              // Unique compound index with date
  date: string;                     // 'YYYY-MM-DD' (UTC)
  tokensUsed: number;               // Accumulated total tokens
  createdAt: Date;                  // TTL Index (Auto-expires after 2 days)
}
```

### 8. `checkout_rate_limits`
Sliding-window rate limiter for checkout session creation (prevents checkout spam).
```typescript
interface CheckoutRateLimitDoc {
  figmaUserId: string;              // Compound index with requestedAt
  requestedAt: Date;                // TTL Index (Auto-expires after 120 seconds)
}
```

### 9. `feedbacks`
User-submitted feedback and ratings for product analytics.
```typescript
interface FeedbackDoc {
  figmaUserId: string;
  userName?: string;
  userEmail?: string;
  plan: 'free' | 'pro';
  rating: number;                   // 1 to 5
  category: string;                 // 'wireframe_quality' | 'ai_models' | 'pricing_billing' | 'feature_request' | 'general' | ...
  message?: string;                 // Max 3000 chars
  context?: {
    lastPrompt?: string;
    selectedModel?: string;
    platform?: 'desktop' | 'mobile';
    style?: string;
  };
  pluginVersion: string;
  status: 'new' | 'reviewed' | 'in_progress' | 'resolved';
  createdAt: Date;
  updatedAt: Date;
}
```

---

## 📡 API Reference

Base URL: `https://us-central1-wireframe-ai-8079f.cloudfunctions.net/api`

### Authentication Endpoints

#### `GET /api/subscription/status`
Fetches current plan state, remaining credits, and expiration details.
* **Headers**: `Authorization: Bearer <Firebase_Token>`, `x-figma-user-id: <id>`, `x-figma-user-name: <name>`
* **Response (200 OK)**:
```json
{
  "plan": "pro",
  "isActive": true,
  "credits": 85,
  "topup_credits": 20,
  "total_credits": 105,
  "days_left": 24,
  "subscription_ends_at": "2026-09-07T12:00:00.000Z",
  "subscription_cancelled": false,
  "show_upgrade": false,
  "show_topup": true,
  "show_renew": false,
  "is_trial": false,
  "last_payment_attempt": null
}
```

---

### AI Generation Endpoints

#### `POST /api/features/generate/start`
Reserves credits, initiates model routing, and streams generated HTML back via Server-Sent Events (SSE).
* **Middleware Chain**: `authMiddleware` ➔ `aiRateLimitMiddleware` ➔ `aiQuotaMiddleware` ➔ `aiBudgetMiddleware`
* **Headers**: `Authorization: Bearer <token>`, `x-figma-user-id: <id>`
* **Request Body**:
```json
{
  "prompt": "SaaS analytics dashboard with MRR metrics, churn graphs, and recent subscriber list",
  "device": "desktop",
  "style": "minimal",
  "fidelity": "high",
  "model": "gpt-5-6-luna",
  "maxTokens": 16384
}
```
* **Response Headers (SSE Stream)**:
  * `Content-Type: text/event-stream`
  * `X-Reservation-Id: 550e8400-e29b-41d4-a716-446655440000`
  * `X-Credits-Deducted: 1`
  * `X-Credit-Pool: plan`
  * `X-Model-Used: openai/gpt-5.6-luna`
  * `X-Complexity-Score: 8`
  * `X-Token-Budget: 20480`

#### `POST /api/features/generate/check`
Informational pre-flight check verifying if the user can afford the generation without deducting any credits.
* **Request Body**: `{"model": "claude-sonnet-4-5"}`
* **Response (200 OK)**:
```json
{
  "ok": true,
  "can_afford": true,
  "credits_left": 85,
  "topup_credits_left": 20,
  "total_credits_left": 105,
  "cost_required": 5,
  "resolved_model_key": "claude-sonnet-4-5"
}
```

#### `POST /api/features/generate/refund`
Refunds credit deduction if a generation failed or was cancelled before stream completion.
* **Request Body**: `{"reservationId": "550e8400-e29b-41d4-a716-446655440000"}`
* **Response (200 OK)**: `{"ok": true, "refunded": true}`

---

### Checkout & Webhook Endpoints

#### `POST /api/checkout/init`
Initiates a Dodo checkout session for the Pro monthly plan ($20.00).
* **Middleware Chain**: `authMiddleware` ➔ `checkoutRateLimitMiddleware` (max 3/min)
* **Request Body**: `{"planId": "pro"}`
* **Response (200 OK)**: `{"checkoutUrl": "https://checkout.dodopayments.com/buy/...", "checkoutId": "chk_..."}`

#### `POST /api/checkout/topup`
Initiates a top-up credit pack checkout session.
* **Middleware Chain**: `authMiddleware` ➔ `requireProMiddleware` ➔ `checkoutRateLimitMiddleware`
* **Request Body**: `{"packId": "medium"}`
* **Response (200 OK)**: `{"checkoutUrl": "...", "checkoutId": "...", "pack_info": {"credits": 50, "price": "$9.99"}}`

#### `POST /api/subscription/cancel`
Schedules cancellation of the active Pro subscription at end of billing period.
* **Middleware Chain**: `authMiddleware`
* **Guard**: Must have active Pro plan; must not already be cancelled.
* **Response (200 OK)**:
```json
{
  "cancelled": true,
  "subscription_ends_at": "2026-09-07T12:00:00.000Z",
  "message": "Your subscription will not renew next cycle. You retain full Pro access and credits until your current period ends."
}
```

#### `POST /api/subscription/reactivate`
Un-cancels a Pro subscription that was scheduled for cancellation.
* **Middleware Chain**: `authMiddleware`
* **Guard**: Must have active Pro plan; must be in cancelled state.
* **Response (200 OK)**:
```json
{
  "reactivated": true,
  "subscription_ends_at": "2026-09-07T12:00:00.000Z",
  "message": "Auto-renewal reactivated! Your Pro plan will renew automatically on your next billing date."
}
```

---

### Feedback Endpoints

#### `POST /api/feedback/submit`
Submits user feedback (rating + category + optional message).
* **Middleware Chain**: `authMiddleware`
* **Request Body**:
```json
{
  "rating": 4,
  "category": "wireframe_quality",
  "message": "The auto-layout is amazing!",
  "pluginVersion": "v4.2.0"
}
```
* **Response (200 OK)**: `{"received": true, "feedbackId": "...", "message": "Thank you! ..."}`

#### `GET /api/feedback/summary`
Returns aggregate feedback analytics (total count, average rating, category breakdown, recent entries).
* **Middleware Chain**: `authMiddleware`
* **Admin access**: Pass `x-admin-secret` header to include PII fields.

---

### Webhook Endpoints

#### `POST /webhooks/dodo`
Webhook listener for Dodo Payments events. Handles the full lifecycle:
* **Activation events**: `payment.succeeded`, `subscription.active`, `subscription.renewed`, `subscription.updated` (status=`active`)
* **Failure events**: `payment.failed`, `subscription.failed`, `subscription.updated` (status=`failed`/`on_hold`/`paused`/`expired`)
* **Revocation events**: `payment.refunded`, `payment.reversed`
* **Cancellation events**: `subscription.cancelled`, `payment.cancelled`, `subscription.updated` (status=`cancelled`)
* **Safely ignored**: `subscription.created` (pending state — does NOT activate plan)
* **Headers**: `webhook-signature: v1,<base64_hmac>` (Svix format) or `x-dodo-signature: t=<timestamp>,v1=<hmac_signature>` (legacy)
* **Response (200 OK)**: `{"received": true, "activated_plan": "pro"}` (on success) or `{"received": true, "action": "failure_recorded"}` (on failure)

---

## ⚙️ Environment Configuration

Set these environment variables in your deployment environment or local `functions/.env` file:

```env
# ── MongoDB Atlas ─────────────────────────────────────────────────────────────
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.w9838.mongodb.net/wireframe_ai?retryWrites=true&w=majority
MONGODB_DB=wireframe_ai

# ── Dodo Payments ─────────────────────────────────────────────────────────────
DODO_API_KEY=dodo_live_api_key_here
DODO_WEBHOOK_SECRET=whsec_live_webhook_secret_here
DODO_ENV=live                          # 'live' or 'test' (defaults to 'test' — controls API base URL)

# ── Dodo Product Price IDs ────────────────────────────────────────────────────
DODO_PRODUCT_PRO=p_price_pro_subscription_id
DODO_PRODUCT_TOPUP_SMALL=p_price_topup_small_id
DODO_PRODUCT_TOPUP_MEDIUM=p_price_topup_medium_id
DODO_PRODUCT_TOPUP_LARGE=p_price_topup_large_id

# ── App Endpoints ─────────────────────────────────────────────────────────────
APP_BASE_URL=https://us-central1-wireframe-ai-8079f.cloudfunctions.net/api

# ── Plan Configuration ────────────────────────────────────────────────────────
FREE_TRIAL_CREDITS=3

# ── AI Gateway (OpenRouter) ───────────────────────────────────────────────────
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-key
```

> **⚠️ Critical**: `DODO_ENV` must be set to `live` for production. When omitted or set to `test`, all Dodo API calls route to `https://test.dodopayments.com`. When set to `live`, they route to `https://live.dodopayments.com`.

---

## 🔄 Webhook Event Lifecycle

Dodo Payments emits webhooks throughout the payment and subscription lifecycle. The backend handles each event as follows:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    Dodo Payments Webhook Events                          │
├───────────────────────────┬──────────────────────────────────────────────┤
│ Event                     │ Backend Action                               │
├───────────────────────────┼──────────────────────────────────────────────┤
│ subscription.created      │ ✅ Safely ignored (pending state)            │
│ payment.succeeded         │ ✅ Activate Pro plan OR grant top-up credits │
│ subscription.active       │ ✅ Activate Pro plan                         │
│ subscription.renewed      │ ✅ Activate Pro plan (renewal)               │
│ subscription.updated      │ ⚡ Status-dependent: active → activate,     │
│   (status-dependent)      │    failed/on_hold/paused → revoke            │
│ payment.failed            │ ❌ Record failure + revoke unearned Pro      │
│ subscription.failed       │ ❌ Record failure + revoke unearned Pro      │
│ payment.refunded          │ 🔄 Expire entire plan (revoke credits)      │
│ payment.reversed          │ 🔄 Expire entire plan (revoke credits)      │
│ subscription.cancelled    │ 📋 Mark cancelled (access until period end) │
│ payment.cancelled         │ 📋 Mark cancelled                           │
└───────────────────────────┴──────────────────────────────────────────────┘
```

**Key Safety Guarantees:**
- `subscription.created` does NOT grant credits (was the root cause of the original payment bug — now fixed)
- Every webhook is deduplicated via MongoDB unique index on `eventId`
- Failed events can be safely retried by Dodo (status transitions: `processing` → `failed` → retryable)
- HMAC-SHA256 signature + 300s timestamp window prevents forged and replayed webhooks

---

## 🚀 Development, Testing & Deployment

### 1. Prerequisites
- **Node.js**: `v20.x` or higher
- **NPM**: `v9.x` or higher
- **Firebase CLI**: `npm install -g firebase-tools`
- **Figma Desktop App**: For loading manifest and testing the plugin sandbox

---

### 2. Frontend Plugin Build
To compile the Figma plugin UI and sandbox scripts:
```bash
# In the root repository directory:
npm install

# Watch mode for local Figma development
npm run watch

# Production build
npm run build
```
Load the plugin in Figma:
1. Open Figma Desktop ➔ `Plugins` ➔ `Development` ➔ `Import plugin from manifest...`
2. Select [`manifest.json`](file:///Users/sunnytyagi/Downloads/wireframe-ai-v4-sizing-fix/manifest.json) in the project root.

---

### 3. Backend Verification & Automated Testing
The backend includes a comprehensive automated test suite testing webhook signature verification, replay protection, credit reservation atomicity, telemetry cost formulas, and plan limits:

```bash
# Navigate to functions directory
cd functions

# Install dependencies
npm install

# Run TypeScript compilation check
npm run build

# Run automated test suite (node:test)
npm test
```

Sample test output:
```text
TAP version 13
ok 1  - AI Controller & Feature Route Logic
ok 2  - Credit & Telemetry Cost Formula Invariants
ok 3  - Credit Cost & Model Routing Invariants
ok 4  - Credit Refund Service Invariants
ok 5  - Atomic Credit Reservation Invariants
ok 6  - Feedback Module & Route Logic
ok 7  - Payment Controller & Checkout Route Logic
ok 8  - Plan Configuration & Limits Invariants
ok 9  - Manage Billing & Subscription Lifecycle Invariants
ok 10 - Subscription Controller & Route Logic
ok 11 - Webhook Controller & Signature Route Logic
ok 12 - Webhook Signature & Security Verification
# tests 50
# suites 12
# pass 50
# fail 0
```

---

### 4. Deploying to Firebase
Deploy the serverless backend functions to Firebase:
```bash
cd functions
firebase login
firebase deploy --only functions
```

---

## 📄 License
Proprietary — All rights reserved by Techexplified & Wireframer AI Team.
