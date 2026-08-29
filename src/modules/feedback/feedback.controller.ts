// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/feedback/feedback.controller.ts — Feedback Collection & Analytics
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   HTTP handlers for two feedback endpoints:\n//     1. POST /api/feedback/submit (user submits feedback)\n//     2. GET /api/feedback/summary (analytics: average rating, breakdown by category)\n//   Responsible for: collecting user feedback, computing analytics\n//   NOT responsible for: moderation, feedback display (admin dashboard separate)\n//\n// WHY COLLECT FEEDBACK?\n//   \n//   Product insights:\n//     • What do users like? (high ratings for specific features)\n//     • What needs improvement? (low ratings + category)\n//     • Which users? (free vs pro, plan changes over time)\n//   \n//   Early warning system:\n//     • Sudden drop in average rating → something broke\n//     • Spike in \"pricing_billing\" complaints → price increase time?\n//     • \"Speed\" category low → performance degradation\n//   \n//   Feature prioritization:\n//     • Most requested features (from feature_request category)\n//     • By user segment (pro feedback vs free feedback)\n//     • Weighted by rating (\"I'd give 2 stars if [feature] was added\")\n//\n// FEEDBACK CATEGORIES:\n//   \n//   wireframe_quality: \"SVGs look weird\" / \"Great layouts!\"\n//   ai_models: \"Can you add GPT-5?\" / \"Why is free limited to mini model?\"\n//   components_layout: \"Button placement is confusing\" / \"Love the grid system\"\n//   speed: \"Generation takes forever\" / \"Super fast!\"\n//   pricing_billing: \"Pricing too high\" / \"Good value for money\"\n//   feature_request: \"I want bulk export\" / \"Can we have templates?\"\n//   general: \"Just wanted to say thanks!\" / \"This is great\"\n//\n// SUBMITFEEDBACKHANDLER LOGIC:\n//   \n//   Step 1: Extract request body\n//     • rating: user's 1-5 star rating\n//     • category: one of VALID_CATEGORIES (default: 'general')\n//     • message: user's text feedback (optional)\n//     • context: app state at time of feedback (optional, for debugging)\n//     • pluginVersion: which version of plugin they're using\n//   \n//   Step 2: Validate rating\n//     • Check: 1 ≤ rating ≤ 5 (integer)\n//     • If not: return 400 \"invalid_rating\"\n//     • Why? Prevent garbage data\n//   \n//   Step 3: Validate & normalize category\n//     • Check: category in VALID_CATEGORIES\n//     • If not: default to 'general'\n//     • Why? Accept partial data (category might be missing)\n//   \n//   Step 4: Sanitize message\n//     • Trim: whitespace\n//     • Limit: 3000 characters (prevent abuse)\n//     • Type: must be string\n//     • If missing: set to undefined\n//     • Why? Prevent null bytes, XSS, storage abuse\n//   \n//   Step 5: Extract user context\n//     • figmaUserId: from req (verified by auth.middleware)\n//     • plan: from planState (pro vs free)\n//     • pluginVersion: from body (e.g., \"v4.2.0\")\n//     • userName: from body (optional, user's name)\n//     • Why? Correlate feedback with user behavior\n//   \n//   Step 6: Insert into MongoDB\n//     • Create: FeedbackDoc with all fields\n//     • Insert: feedbacks.insertOne(doc)\n//     • Get: insertedId (for acknowledgment)\n//   \n//   Step 7: Log & respond\n//     • Log: \"Feedback submitted by user X | Rating: Y | Category: Z\"\n//     • Response: 200 OK { received: true, feedbackId }\n//   \n//   Example successful request:\n//     POST /api/feedback/submit\n//     {\n//       rating: 5,\n//       category: 'wireframe_quality',\n//       message: 'The SVG output is pristine. Saves hours of design work!',\n//       pluginVersion: 'v4.2.0',\n//       userName: 'Alice Design'\n//     }\n//   \n//   Example response:\n//     {\n//       received: true,\n//       feedbackId: ObjectId('507f1f77bcf86cd799439011'),\n//       message: 'Thank you! Your feedback helps us make Wireframe AI better.'\n//     }\n//\n// CONTEXT OBJECT (optional debugging info):\n//   \n//   Client can pass context:\n//     {\n//       context: {\n//         screen_width: 1920,\n//         screen_height: 1080,\n//         figma_version: '127.0',\n//         plugin_memory_mb: 45,\n//         recent_errors: ['timeout', 'network_error'],\n//         generation_count: 23,\n//         avg_generation_time_ms: 12000\n//       }\n//     }\n//   \n//   Used by: product team to understand environment when feedback given\n//     • \"I gave 1 star on slow generation\" + context.avg_generation_time_ms\n//     • Correlate: performance metrics with user satisfaction\n//     • \"This error happens on plugin v4.1 in Firefox\"\n//     • Fix: specific browser/version combo\n//\n// FEEDBACKDOC SCHEMA (MongoDB):\n//   \n//   {\n//     figmaUserId: string,               // who gave feedback\n//     userName?: string,                 // user's display name (optional)\n//     plan: 'free' | 'pro',              // user's plan at time\n//     rating: 1|2|3|4|5,                 // 1=terrible, 5=excellent\n//     category: string,                  // one of VALID_CATEGORIES\n//     message?: string,                  // text feedback (up to 3000 chars)\n//     context?: object,                  // app state (debugging)\n//     pluginVersion: string,             // which version sent this\n//     status: 'new'|'read'|'resolved',   // workflow status (admin use)\n//     createdAt: Date,                   // when submitted\n//     updatedAt: Date,                   // when last modified\n//   }\n//   \n//   Indexes:\n//     • figmaUserId: find feedback from specific user\n//     • createdAt: sort by recency (GET summary uses)\n//     • rating: find high/low feedback\n//     • category: filter by type\n//     • plan: compare free vs pro satisfaction\n//\n// GETFEEDBACKSUMMARYHANDLER LOGIC:\n//   \n//   Purpose: \"Show me analytics on all feedback\"\n//   Called by: Product team / admin dashboard\n//   Security: Requires ADMIN_SECRET (PII scrubbing)\n//   \n//   Step 1: Check authorization\n//     • Read: process.env.ADMIN_SECRET\n//     • Read: x-admin-secret header\n//     • If match: isAdmin = true (full data)\n//     • If not: isAdmin = false (scrub PII)\n//     • Why? Prevent figmaUserId leakage via API\n//   \n//   Step 2: Define projection (privacy control)\n//     • If admin: projection = {} (all fields)\n//     • If not: exclude figmaUserId, userName, userEmail, context\n//     • Result: non-admin sees only ratings, categories, timestamps\n//   \n//   Step 3: Compute analytics (parallel queries)\n//     • Total feedback count\n//     • Average rating: aggregate $avg\n//     • Category breakdown: $group by category, count each\n//     • Recent feedback: last 20 (sorted by -createdAt)\n//   \n//   Step 4: Format & return\n//     • totalFeedbacks: 1234\n//     • averageRating: 4.2 (rounded to 1 decimal)\n//     • categoryBreakdown:\n//       - { category: 'wireframe_quality', count: 300 }\n//       - { category: 'speed', count: 200 }\n//       - ...\n//     • recent: [{ rating, category, message, createdAt, ... }, ...]\n//   \n//   Example response (non-admin):\n//     {\n//       totalFeedbacks: 1234,\n//       averageRating: 4.2,\n//       categoryBreakdown: [\n//         { category: 'wireframe_quality', count: 300 },\n//         { category: 'feature_request', count: 250 },\n//         { category: 'speed', count: 200 }\n//       ],\n//       recent: [\n//         {\n//           rating: 5,\n//           category: 'wireframe_quality',\n//           message: 'Excellent SVG quality!',\n//           createdAt: '2025-01-31T10:30:00Z'\n//         },\n//         ...\n//       ]\n//     }\n//   \n//   Example response (admin):\n//     {\n//       totalFeedbacks: 1234,\n//       averageRating: 4.2,\n//       categoryBreakdown: [...],\n//       recent: [\n//         {\n//           figmaUserId: 'user_abc123',\n//           userName: 'Alice Design',\n//           plan: 'pro',\n//           rating: 5,\n//           category: 'wireframe_quality',\n//           message: 'Excellent SVG quality!',\n//           context: { generation_count: 50, ... },\n//           createdAt: '2025-01-31T10:30:00Z'\n//         },\n//         ...\n//       ]\n//     }\n//\n// PRIVACYPROTECTION (GDPR / data minimization):\n//   \n//   PII fields (personally identifiable):\n//     • figmaUserId: identifies user\n//     • userName: user's display name\n//     • context: might contain device IDs, browser history\n//   \n//   Non-admin access:\n//     • Scrubbed: figmaUserId, userName, userEmail, context\n//     • Visible: rating, category, message, pluginVersion, createdAt\n//     • Reason: product team needs feedback content, not user identity\n//   \n//   Admin access:\n//     • Full data: all fields\n//     • Why? Admins might need to contact users about feedback\n//     • Control: ADMIN_SECRET environment variable (admin-only access)\n//   \n//   Data retention:\n//     • Feedback: kept indefinitely (product insights)\n//     • Cleanup: manual via admin dashboard\n//     • Option: implement TTL index for auto-deletion (configurable)\n//\n// ANALYTICS USE CASES:\n//   \n//   Use Case 1: Product Health Dashboard\n//     • Display: current average rating (live)\n//     • Alert: if drops below 3.5 (something broke)\n//     • Trend: plot rating over time (admin dashboard)\n//     • Action: spike in \"speed\" complaints → performance review\n//   \n//   Use Case 2: Feature Prioritization\n//     • Filter: category='feature_request'\n//     • Count: how many users asked for X?\n//     • Weight: by rating (\"1-star + feature request\" = most urgent)\n//     • Result: backlog prioritization\n//   \n//   Use Case 3: User Segmentation\n//     • Compare: free user feedback vs pro user feedback\n//     • Insight: \"Free users complain about pricing, pro users love speed\"\n//     • Action: free plan marketing, speed optimization\n//   \n//   Use Case 4: Problem Detection\n//     • Category='speed' + rating < 3 + pluginVersion='v4.2.0'\n//     • Insight: \"v4.2.0 has performance regression\"\n//     • Action: hotfix release v4.2.1\n//   \n//   Use Case 5: Churn Prediction\n//     • Rating trend: user's feedback trends downward\n//     • Action: reach out (\"Hey, you gave 4 stars last month, 2 today. What's wrong?\")\n//     • Retention: proactive support\n//\n// NO RATE LIMITING:\n//   \n//   Why not limit feedback submissions?\n//     • Feedback is rare (user gives it once a week, if that)\n//     • Cost: minimal (single DB insert)\n//     • Benefit: don't discourage feedback\n//   \n//   If abuse happens (spam):\n//     • Add: rate limit by figmaUserId (1 per hour)\n//     • Or: require minimum message length (prevents empty spam)\n//     • Or: require rating ≥ 1 (already done)\n//\n// POTENTIAL IMPROVEMENTS:\n//   \n//   1. Rating weighting: pro user rating counts 2x (pays us)\n//   2. Feedback trends: plot rating over time (time series)\n//   3. Sentiment analysis: auto-categorize negative feedback\n//   4. Email notification: admin gets alerted on 1-star feedback\n//   5. Response system: admin responds to feedback, user gets notification\n//   6. NPS calculation: \"Would you recommend Wireframe AI?\" + Net Promoter Score\n//   7. A/B testing: which UI change increases satisfaction?\n//

import { Request, Response } from 'express';
import { getFeedbacksCollection } from '../../config/database';
import { FeedbackCategory, FeedbackDoc, FeedbackSubmitRequest } from './feedback.types';
import { BadRequestError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

const VALID_CATEGORIES: FeedbackCategory[] = [
  'wireframe_quality',
  'ai_models',
  'components_layout',
  'speed',
  'pricing_billing',
  'feature_request',
  'general',
];

export async function submitFeedbackHandler(
  req: Request,
  res: Response
): Promise<void> {
  const figmaUserId = req.figmaUserId;
  const planState   = req.planState;

  const body = req.body as FeedbackSubmitRequest & { userName?: string };

  // Validate rating (1 to 5)
  const rating = Number(body.rating);
  if (!rating || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new BadRequestError('Rating must be an integer between 1 and 5', 'invalid_rating');
  }

  // Validate category
  let category: FeedbackCategory = 'general';
  if (body.category && VALID_CATEGORIES.includes(body.category)) {
    category = body.category;
  }

  // Sanitize message
  const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
  const message = rawMessage.slice(0, 3000);

  const pluginVersion = typeof body.pluginVersion === 'string' ? body.pluginVersion.trim().slice(0, 30) : 'v4.2.0';
  const userName = typeof body.userName === 'string' ? body.userName.trim().slice(0, 100) : undefined;

  const feedbacks = await getFeedbacksCollection();
  const now = new Date();

  const doc: FeedbackDoc = {
    figmaUserId,
    userName,
    plan:          planState?.plan === 'pro' ? 'pro' : 'free',
    rating,
    category,
    message:       message || undefined,
    context:       body.context && typeof body.context === 'object' ? body.context : undefined,
    pluginVersion,
    status:        'new',
    createdAt:     now,
    updatedAt:     now,
  };

  const result = await feedbacks.insertOne(doc as any);

  logger.info(`[feedback.controller] Feedback submitted by ${figmaUserId} | Rating: ${rating}★ | Category: ${category} | ID: ${result.insertedId}`);

  sendSuccess(res, {
    received: true,
    feedbackId: result.insertedId,
    message: 'Thank you! Your feedback helps us make Wireframe AI better.',
  });
}

export async function getFeedbackSummaryHandler(
  req: Request,
  res: Response
): Promise<void> {
  const feedbacks = await getFeedbacksCollection();

  const adminSecret = process.env.ADMIN_SECRET;
  const isAdmin = Boolean(adminSecret && req.headers['x-admin-secret'] === adminSecret);

  // If not admin, scrub PII (figmaUserId, userName, userEmail, context)
  const projection = isAdmin
    ? {}
    : { figmaUserId: 0, userName: 0, userEmail: 0, context: 0 };

  const [totalCount, avgRatingResult, categoryCounts, recentFeedbacks] = await Promise.all([
    feedbacks.countDocuments(),
    feedbacks.aggregate<{ _id: null; avgRating: number }>([
      { $group: { _id: null, avgRating: { $avg: '$rating' } } }
    ]).toArray(),
    feedbacks.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray(),
    feedbacks.find({})
      .sort({ createdAt: -1 })
      .limit(20)
      .project(projection)
      .toArray(),
  ]);

  const avgRating = avgRatingResult.length > 0 && avgRatingResult[0].avgRating
    ? Math.round(avgRatingResult[0].avgRating * 10) / 10
    : 0;

  sendSuccess(res, {
    totalFeedbacks: totalCount,
    averageRating: avgRating,
    categoryBreakdown: categoryCounts.map(c => ({ category: c._id, count: c.count })),
    recent: recentFeedbacks,
  });
}
