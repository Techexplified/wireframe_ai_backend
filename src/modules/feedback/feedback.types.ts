import { ObjectId } from 'mongodb';

export type FeedbackCategory =
  | 'wireframe_quality'
  | 'ai_models'
  | 'components_layout'
  | 'speed'
  | 'pricing_billing'
  | 'feature_request'
  | 'general';

export interface FeedbackContext {
  lastPrompt?: string;
  selectedModel?: string;
  platform?: 'desktop' | 'mobile';
  style?: string;
}

export interface FeedbackDoc {
  _id?: ObjectId;
  figmaUserId: string;
  userName?: string;
  userEmail?: string;
  plan: 'free' | 'pro';
  rating: number; // 1 to 5
  category: FeedbackCategory;
  message?: string;
  context?: FeedbackContext;
  pluginVersion: string;
  status: 'new' | 'reviewed' | 'in_progress' | 'resolved';
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackSubmitRequest {
  rating: number;
  category?: FeedbackCategory;
  message?: string;
  context?: FeedbackContext;
  pluginVersion?: string;
}
