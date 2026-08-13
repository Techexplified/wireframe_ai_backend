// ─── config/database.ts — Re-export barrel (backwards compatibility) ───────────
//
// database.ts has been split into two focused files:
//   - db.connect.ts  : MongoDB connection singleton + collection helpers
//   - user.model.ts  : Document interfaces (UserDoc, ProcessedWebhookDoc, etc.)
//
// This file re-exports everything from both so existing imports continue to
// work without any changes. Prefer importing directly from the new files in
// new code.

export { connectToDatabase, getUsersCollection, getWebhooksCollection, getUsageLogsCollection } from './db.connect';
export type { UserDoc, ProcessedWebhookDoc, UsageLogDoc } from './user.model';
