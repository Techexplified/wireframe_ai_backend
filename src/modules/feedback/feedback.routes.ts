// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/feedback/feedback.routes.ts — Feedback Collection & Analytics
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Collects user feedback on wireframe generation quality and app experience
//   Provides analytics endpoints for product team to analyze feedback trends
//
// ROUTE MAP (mounted at /api/feedback):
//   POST /submit  — submit user feedback after generation
//   GET  /summary — retrieve aggregated feedback analytics
//
// WORKFLOW:
//   
//   POST /api/feedback/submit:
//     1. User generates wireframe, views output
//     2. User optionally rates quality: 1-5 stars (or skips)
//     3. User optionally adds text comment (why they liked/disliked)
//     4. Client sends POST /api/feedback/submit
//     5. Server stores feedback in feedbacks collection
//     6. Server returns { success: true, feedback_id }
//     7. Client acknowledges (UI shows \"Thanks for feedback\")
//   
//   GET /api/feedback/summary:
//     1. Product manager wants to understand quality metrics
//     2. Client calls GET /api/feedback/summary
//     3. Server aggregates feedback from feedbacks collection
//     4. Returns metrics:
//        {
//          total_responses: 150,
//          avg_rating: 4.2,
//          rating_distribution: { 5: 80, 4: 40, 3: 20, 2: 5, 1: 5 },
//          common_feedback_themes: [
//            { keyword: \"responsive\", count: 12, sentiment: \"positive\" },
//            { keyword: \"needs_improvement\", count: 5, sentiment: \"negative\" }
//          ],
//          quality_by_model: {
//            \"gpt-5.6-luna\": { avg_rating: 4.3, responses: 80 },
//            \"deepseek-v4-pro\": { avg_rating: 4.1, responses: 70 }
//          }
//        }
//     5. Product team uses this to prioritize model improvements
//
// REQUEST/RESPONSE EXAMPLES:
//   
//   POST /api/feedback/submit
//   Headers:
//     Authorization: Bearer <firebase jwt>
//     X-Figma-User-Id: figma_user_456
//   
//   Request body:
//     {
//       rating: 5,
//       comment: \"Great layout! Responsive and clean.\",
//       model_used: \"gpt-5.6-luna\",
//       generation_id: \"gen_123\",
//       device: \"desktop\",
//       style: \"modern\",
//       prompt_length: 45,
//       generation_time_ms: 12000,
//       tokens_used: 1234,
//       generation_successful: true
//     }
//   
//   Response (200 OK):
//     {
//       \"success\": true,
//       \"feedback_id\": \"fbk_456\",
//       \"message\": \"Thank you for your feedback!\",
//       \"timestamp\": \"2024-01-15T12:34:56Z\"
//     }
//   
//   ---
//   
//   GET /api/feedback/summary
//   Headers:
//     Authorization: Bearer <firebase jwt>
//   
//   Response (200 OK):
//     {
//       \"total_responses\": 247,
//       \"response_rate\": 0.18,
//       \"avg_rating\": 4.25,
//       \"median_rating\": 5,
//       \"rating_distribution\": {
//         \"5_stars\": 140,
//         \"4_stars\": 65,
//         \"3_stars\": 25,
//         \"2_stars\": 10,
//         \"1_star\": 7
//       },
//       \"common_themes\": [
//         {
//           \"theme\": \"responsive_design\",
//           \"count\": 34,
//           \"sentiment\": \"positive\",
//           \"example_comments\": [\n//             \"Great at making responsive layouts\",\n//             \"Mobile-first approach works well\"\n//           ]\n//         },\n//         {\n//           \"theme\": \"simplicity\",\n//           \"count\": 28,\n//           \"sentiment\": \"positive\",\n//           \"example_comments\": [\"Clean and simple\"]\n//         },\n//         {\n//           \"theme\": \"improvement_suggestions\",\n//           \"count\": 15,\n//           \"sentiment\": \"neutral\",\n//           \"example_comments\": [\"Could use more components\"]\n//         }\n//       ],\n//       \"quality_by_model\": {\n//         \"gpt-5.6-luna\": {\n//           \"avg_rating\": 4.4,\n//           \"responses\": 150,\n//           \"response_rate\": 0.22\n//         },\n//         \"deepseek-v4-pro\": {\n//           \"avg_rating\": 4.1,\n//           \"responses\": 97,\n//           \"response_rate\": 0.15\n//         }\n//       },\n//       \"quality_by_device\": {\n//         \"desktop\": { \"avg_rating\": 4.3, \"responses\": 180 },\n//         \"mobile\": { \"avg_rating\": 4.1, \"responses\": 67 }\n//       },\n//       \"quality_by_style\": {\n//         \"modern\": { \"avg_rating\": 4.4, \"responses\": 145 },\n//         \"minimal\": { \"avg_rating\": 4.2, \"responses\": 102 }\n//       },\n//       \"trends\": {\n//         \"avg_rating_trend\": [4.1, 4.15, 4.2, 4.25],  // Last 4 weeks\n//         \"response_rate_trend\": [0.15, 0.16, 0.17, 0.18]\n//       },\n//       \"insights\": [\n//         \"Model A performs better on desktop (4.4 vs 4.1)\",\n//         \"Modern style rated higher than minimal (4.4 vs 4.2)\",\n//         \"Response rate increasing week-over-week\"\n//       ]\n//     }
//
// FEEDBACK COLLECTION STRATEGY:
//   
//   Feedback is optional, not forced:
//     • After /generate/start completes, prompt user: \"Rate this generation?\"\n//     • User can close prompt without rating (still gets output)\n//     • Only rate if they have strong opinion (positive or negative)\n//   \n//   Why optional?
//     • Required ratings → noise (users rate randomly to dismiss prompt)\n//     • Optional ratings → signal (only strong opinions collected)\n//     • Less frustration → higher long-term retention\n//   \n//   Data captured with each feedback:\n//     • rating (1-5 stars) — required if submitting\n//     • comment (text) — optional, for qualitative feedback\n//     • model_used (which model generated the wireframe)\n//     • device (desktop/mobile)\n//     • style (modern/minimal/etc.)\n//     • generation_time_ms (how fast was it?)\n//     • tokens_used (complexity indicator)\n//     • generation_successful (did output appear correct?)\n//   \n//   Why this data?\n//     • Correlate rating with model → find best performer\n//     • Correlate rating with device → identify mobile issues\n//     • Correlate rating with generation_time → speed important?\n//     • Correlate rating with tokens → complexity sweet spot?\n//
// ANALYTICS USE CASES:\n//   \n//   Use Case 1: Model Selection\n//     Q: Which model should we default to?\n//     A: Compare avg_rating and response_rate by model\n//     → Choose model with highest avg_rating\n//   \n//   Use Case 2: Device Optimization\n//     Q: Are mobile users less satisfied?\n//     A: Compare quality_by_device\n//     → If mobile < desktop, prioritize mobile improvements\n//   \n//   Use Case 3: Style Preferences\n//     Q: Do users prefer modern or minimal?\n//     A: Compare quality_by_style\n//     → Increase weight of preferred style in prompting\n//   \n//   Use Case 4: Feature Prioritization\n//     Q: What should we build next?\n//     A: Analyze common_themes for improvement suggestions\n//     → Users request components → add component library\n//   \n//   Use Case 5: Quality Regression Detection\n//     Q: Did latest model update break quality?\n//     A: Monitor trends.avg_rating_trend\n//     → Alert on sudden drop\n//     → Correlate with deployment timestamps
//
// DATABASE SCHEMA:\n//   \n//   Collection: feedbacks\n//   Document:\n//     {\n//       _id: ObjectId,\n//       firebaseUid: \"user_123\",\n//       figmaUserId: \"figma_user_456\",\n//       plan: \"pro\" | \"free\",\n//       rating: 1-5 | null,\n//       comment: \"...\",\n//       model_used: \"gpt-5.6-luna\",\n//       generation_id: \"gen_123\",\n//       device: \"desktop\" | \"mobile\",\n//       style: \"modern\" | \"minimal\",\n//       prompt_length: 45,\n//       generation_time_ms: 12000,\n//       tokens_used: 1234,\n//       generation_successful: true,\n//       createdAt: ISODate(\"2024-01-15T12:34:56Z\"),\n//       updatedAt: ISODate(\"2024-01-15T12:34:56Z\")\n//     }\n//   \n//   Indexes:\n//     • Index on firebaseUid (lookup user's own feedback)\n//     • Index on model_used (aggregate by model)\n//     • Index on device (segment by device)\n//     • Index on style (segment by style)\n//     • Index on createdAt (time series analytics)\n//
// MIDDLEWARE:\n//   \n//   Both routes require authMiddleware:\n//     • POST /submit: verify user identity, bind figmaUserId\n//     • GET /summary: verify user identity (access control)\n//   \n//   Note: /summary doesn't check for admin role (simplified)\n//   In production, should add role check: adminMiddleware before summary handler
//
// PRIVACY & DATA RETENTION:\n//   \n//   Feedback is tied to user ID (not anonymous):\n//     • Allows user to view/edit their own feedback\n//     • Allows follow-up surveys (\"Thanks for 5-star!\", \"What went wrong?\")\n//   \n//   Retention policy:\n//     • Keep feedback indefinitely (source of truth for product)\n//     • Anonymize after 12 months (complies with data retention laws)\n//     • User can request deletion (GDPR right to be forgotten)\n//
// ERROR HANDLING:\n//   \n//   Rating out of range (400):\n//     { error: \"bad_request\", message: \"Rating must be 1-5\" }\n//   \n//   Comment too long (400):\n//     { error: \"bad_request\", message: \"Comment cannot exceed 500 characters\" }\n//   \n//   Database error on submit (500):\n//     { error: \"internal_error\", message: \"Failed to save feedback\" }\n//   
//   Database error on summary (500):\n//     { error: \"internal_error\", message: \"Failed to generate analytics\" }

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { submitFeedbackHandler, getFeedbackSummaryHandler } from './feedback.controller';

const router = Router();

router.post(
  '/submit',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    submitFeedbackHandler(req, res).catch(next);
  }
);

router.get(
  '/summary',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    getFeedbackSummaryHandler(req, res).catch(next);
  }
);

export default router;
