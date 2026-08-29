// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/ai/ai.types.ts — AI Generation Types
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:\n//   TypeScript interfaces for AI generation workflow\n//   Covers generation request, complexity scoring, stream telemetry, and OpenRouter integration\n//\n// TYPE HIERARCHY:\n//   \n//   Client sends: GenerateOptions\n//                 ↓\n//   Middleware computes: ComplexityResult (appends to _complexity field)\n//                 ↓\n//   Service processes: GenerateOptions + ComplexityResult\n//                 ↓\n//   OpenRouter API called: returns Stream + telemetry\n//                 ↓\n//   Stream piped to: Express response (Server-Sent Events)\n//                 ↓\n//   Final result: StreamTelemetry (token counts, timing, finish reason)\n//\n// GENERATION REQUEST (GenerateOptions):\n//   \n//   Field breakdown:\n//   \n//   prompt (string, required):\n//     • User's wireframe description\n//     • Example: \"Dashboard with sidebar, 3 cards showing metrics\"\n//     • Length: typically 20-200 characters\n//     • Used to complexity score (longer = more complex)\n//     • Passed directly to OpenRouter in system prompt\n//   \n//   device (string, required):\n//     • Target device: \"desktop\" | \"tablet\" | \"mobile\"\n//     • Affects layout instructions in system prompt\n//     • Affects complexity scoring (mobile = fewer columns)\n//     • Desktop typically higher complexity than mobile\n//   \n//   style (string, required):\n//     • Design aesthetic: \"modern\" | \"minimal\" | \"glassmorphism\" | \"dark\" | etc.\n//     • Passed to OpenRouter in system prompt\n//     • Affects token consumption (some styles need more detail)\n//   \n//   fidelity (string, optional, default \"medium\"):\n//     • Output quality: \"low\" | \"medium\" | \"high\"\n//     • Affects max_tokens budget in OpenRouter call\n//     • Affects complexity scoring (high fidelity = larger token budget)\n//   \n//   model (string, optional, default from constants.ts):\n//     • Which AI model to use: \"gpt-5.6-luna\" | \"deepseek-v4-pro\" | \"gemini-3.7\"\n//     • If not provided, ai.service.ts routes based on complexity and plan\n//     • Free plan: uses cheaper model (deepseek)\n//     • Pro plan: uses better model (gpt-5.6-luna) or user's selection\n//   \n//   maxTokens (number, optional):\n//     • Caller's hard limit on output length\n//     • Overrides computed tokenBudget from complexity\n//     • Used if caller wants stricter limit (e.g., \"keep it short\")\n//   \n//   temperature (number, optional, default 0.7):\n//     • Randomness: 0.0 (deterministic) to 1.0 (creative)\n//     • Affects HTML variety (0 = always same output, 1 = always different)\n//     • 0.7 = good balance (creative but consistent)\n//   \n//   _complexity (ComplexityResult, optional, internal):\n//     • PRE-COMPUTED by aiBudgetMiddleware\n//     • Contains complexity score, token budget, section count\n//     • Set BEFORE hitting ai.controller\n//     • Avoids duplicate complexity scoring (middleware scored it already)\n//     • Marked with underscore to signal: internal field, don't set in client request\n//   \n//   _plan (string, optional, internal):\n//     • User's subscription plan (\"free\" | \"pro\")\n//     • Set by authMiddleware or aiBudgetMiddleware\n//     • Used in ai.service.ts for model routing\n//     • Marked with underscore to signal: internal field\n//\n// COMPLEXITY SCORING (ComplexityResult):\n//   \n//   Computed by ai.complexity.ts middleware\n//   Runs BEFORE budget check (estimates if request is too expensive)\n//   \n//   Fields:\n//   \n//   score (1-10 integer):\n//     • Estimated complexity of generated wireframe\n//     • 1 = single component (button, input field)\n//     • 3 = simple layout (hero + footer)\n//     • 5 = moderate layout (sidebar + content)\n//     • 7 = complex layout (multi-section dashboard)\n//     • 10 = highly complex (e-commerce with many components)\n//     • Used to: prevent users requesting excessively complex designs\n//   \n//   sectionCount (integer):\n//     • Estimated number of major sections in wireframe\n//     • Example: \"Dashboard with sidebar\" = 2 sections\n//     • Example: \"E-commerce product page with reviews\" = 5+ sections\n//     • More sections = higher complexity\n//   \n//   promptLength (integer):\n//     • Character count of user's prompt\n//     • Longer prompts = more detail = more tokens needed\n//     • Used to: predict token consumption\n//   \n//   device (string):\n//     • Echoes user's device choice (for logging)\n//     • Desktop prompts typically higher complexity than mobile\n//   \n//   tokenBudget (integer):\n//     • Recommended max_tokens for this request\n//     • Computed as: baseTokens + (complexity * tokensPerComplexityLevel)\n//     • Example: score=5 → tokenBudget=1500\n//     • Example: score=8 → tokenBudget=2500\n//     • Passed to aiBudgetMiddleware to check against per-request cap\n//     • Passed to ai.controller to set OpenRouter max_tokens\n//
// STREAM TELEMETRY (StreamTelemetry):\n//   \n//   Computed AFTER generation completes (from OpenRouter response)\n//   Filled by ai.telemetry.ts (intercepts stream end)\n//   Used for: credit settlement, quality analytics, cost tracking\n//   \n//   Fields:\n//   \n//   promptTokens (integer):\n//     • Tokens consumed by system prompt + user input\n//     • Example: system=\"You are...\", user=\"Dashboard\" → ~50 tokens\n//   \n//   completionTokens (integer):\n//     • Tokens generated by model (HTML output)\n//     • Example: complex wireframe → ~1200 tokens\n//   \n//   reasoningTokens (integer):\n//     • Tokens used for reasoning (if model has reasoning phase)\n//     • Typical models: 0 (no reasoning)\n//     • DeepSeek R1: may use 50-200 tokens for reasoning\n//   \n//   totalTokens (integer):\n//     • Sum: promptTokens + completionTokens + reasoningTokens\n//     • This is what gets counted against daily quota\n//     • This is what gets charged as credits\n//   \n//   finishReason (enum):\n//     • \"stop\" = model finished normally (completed wireframe)\n//     • \"length\" = max_tokens hit (output truncated)\n//     • \"content_filter\" = model refused (safety filter triggered)\n//     • \"error\" = OpenRouter error (shouldn't happen, but possible)\n//     • \"unknown\" = couldn't determine (shouldn't happen)\n//   \n//   durationMs (integer):\n//     • Wall-clock time from OpenRouter API call to completion\n//     • Example: gpt-5.6-luna → ~2000ms\n//     • Example: deepseek-v4-pro → ~3000ms\n//     • Used for: performance monitoring, SLA tracking\n//   \n//   model (string):\n//     • Which model actually generated (may differ from request if routed)\n//     • Example: user requested \"gpt-5.6-luna\", but routed to \"deepseek\" for cost\n//     • Used for: analytics (which models used, which perform best)\n//   \n//   complexityScore (integer, 1-10):\n//     • The complexity score estimated pre-request\n//     • Echoed back in telemetry for comparison with actual tokens\n//     • Used for: validate scoring accuracy (estimate vs. actual)\n//   \n//   tokenBudget (integer):\n//     • The token budget estimated pre-request\n//     • Echoed back in telemetry\n//     • Comparison: tokenBudget=1500 vs. totalTokens=1234 (accuracy: 82%)\n//     • Used for: improve future complexity scoring\n//
// OPENROUTER STREAM RESULT (OpenRouterStreamResult):\n//   \n//   Returned by openRouter API call\n//   Contains: stream + telemetry promise\n//   Allows: client receives HTML while telemetry is still collecting\n//   \n//   Fields:\n//   \n//   stream (Transform stream):\n//     • Node.js Transform stream wrapping OpenRouter response\n//     • Passes through OpenRouter tokens\n//     • Counts tokens as they flow (intercepts all data)\n//     • Maintains compatibility with Express res.pipe()\n//     • Client sees: Server-Sent Events with HTML chunks\n//   \n//   telemetryPromise (Promise<StreamTelemetry>):\n//     • Resolves AFTER stream ends (all tokens received)\n//     • Resolves with: total tokens, timing, finish reason\n//     • Used by ai.controller to: settle credit reservation\n//     • If stream is piped to Express res:\n//       - Client starts receiving HTML immediately\n//       - telemetryPromise resolves in background\n//       - After resolve: credits deducted, analytics logged\n//   \n//   modelUsed (string, optional):\n//     • Actual model used by OpenRouter\n//     • May differ from request if routed/scaled\n//
// FLOW EXAMPLE (entire generation):\n//   \n//   1. Client POSTs /api/features/generate/start\n//      {\n//        prompt: \"Dashboard with sidebar and cards\",\n//        device: \"desktop\",\n//        style: \"modern\"\n//      }\n//   \n//   2. ai.complexity.ts middleware:\n//      • Analyzes prompt length (30 chars)\n//      • Analyzes device (desktop = higher complexity)\n//      • Computes: score=6, sectionCount=3, tokenBudget=1800\n//      • Appends: _complexity = { score: 6, sectionCount: 3, tokenBudget: 1800 }\n//   \n//   3. aiBudgetMiddleware:\n//      • Checks: tokenBudget (1800) <= per-request cap ($0.80 equivalent)\n//      • If OK: proceed. If not: throw 402 Payment Required\n//   \n//   4. ai.controller.ts startGenerationHandler:\n//      • Reserves 6 credits (based on complexity score)\n//      • Calls ai.service.generateWithStream(opts)\n//   \n//   5. ai.service.ts:\n//      • Routes model: user didn't specify → pick gpt-5.6-luna (pro plan)\n//      • Calls OpenRouter API with:\n//        - model: \"openrouter/auto\" or specific model\n//        - max_tokens: opts._complexity.tokenBudget (1800)\n//        - system prompt: \"You generate HTML wireframes...\"\n//        - user message: \"Dashboard with sidebar...\"\n//      • OpenRouter returns stream + usage\n//   \n//   6. ai.telemetry.ts:\n//      • Wraps stream in Transform (token counting)\n//      • Passes through HTML chunks\n//      • After stream ends: computes totalTokens, finishReason\n//      • Returns telemetryPromise\n//   \n//   7. ai.controller pipes stream to Express response:\n//      • HTTP 200 OK\n//      • Content-Type: text/event-stream\n//      • SSE data: {type: \"token\", content: \"<html>...\"}\n//   \n//   8. ai.controller awaits telemetryPromise:\n//      • Gets actual token count (1234 tokens)\n//      • Settles credit reservation: 6 → 1.2 (based on actual cost)\n//      • Refunds: 6 - 1.2 = 4.8 credits (rounded up to 5)\n//   \n//   9. Credit updated, analytics logged, request complete

export interface GenerateOptions {
  prompt: string;
  device: string;
  style: string;
  fidelity?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Pre-computed by aiBudgetMiddleware — avoids double-scoring in the service */
  _complexity?: ComplexityResult;
  /** Plan string passed through for model routing */
  _plan?: string;
}

// ─── Complexity Scoring ───────────────────────────────────────────────────────

export interface ComplexityResult {
  score: number;        // 1 (single component) to 10 (full multi-section layout)
  sectionCount: number;
  promptLength: number;
  device: string;
  tokenBudget: number;  // recommended max_tokens for this request
}

// ─── Stream Telemetry ─────────────────────────────────────────────────────────

export interface StreamTelemetry {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error' | 'unknown';
  durationMs: number;
  model: string;
  complexityScore: number;
  tokenBudget: number;
}

// ─── OpenRouter Stream Result ─────────────────────────────────────────────────

import { Transform } from 'stream';

export interface OpenRouterStreamResult {
  /** Telemetry-intercepting passthrough stream — pipe this to Express res */
  stream: Transform;
  /** Resolves with telemetry after the stream fully ends */
  telemetryPromise: Promise<StreamTelemetry>;
  /** Actual OpenRouter model used (may differ from user selection after routing) */
  model: string;
  complexityScore: number;
  tokenBudget: number;
  /** Fix AI-H-03: Aborts the active upstream OpenRouter request if client disconnects */
  cancelStream?: () => void;
}
