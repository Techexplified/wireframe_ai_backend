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
