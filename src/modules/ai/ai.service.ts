// ─── modules/ai/ai.service.ts — OpenRouter Streaming + Prompt Builders ────────
//
// Pipeline:
//   1. buildSystemPrompt / buildAgentPrompt — prompt construction
//   2. scoreComplexity  — dynamic token budget (Pillar 2)
//   3. resolveModel     — routing policy (Pillar 4)
//   4. callOpenRouterStream — OpenRouter HTTPS streaming call
//   5. wrapWithTelemetry — SSE passthrough that captures usage + finish_reason (Pillar 1)

import * as https from 'https';
import * as http from 'http';
import { Transform } from 'stream';

import { GenerateOptions, OpenRouterStreamResult, StreamTelemetry } from './ai.types';
import { scoreComplexity } from './ai.complexity';
import { resolveModel } from './ai.router';
import { MODEL_MAP, DEFAULT_MODEL } from '../../config/constants';

export { GenerateOptions };

// ─── Device width map ─────────────────────────────────────────────────────────

const DEVICE_WIDTHS: Record<string, number> = {
  desktop: 1440,
  tablet:  768,
  mobile:  390,
};

// ─── Theme palettes ───────────────────────────────────────────────────────────

const THEME_PALETTES: Record<string, string> = {
  luxury: `
COLOR PALETTE (Luxury / High-End Fashion / Editorial — use these EXACT values):
- Page background: #FDFBF7 (cream / warm linen)
- Section backgrounds (alternate): #FDFBF7, #F9F7F2, #F4F1EA, #1C1917 (dramatic dark accent section)
- Card surface: #FFFFFF with border: 1px solid #E7E5E4 and subtle box-shadow: 0 4px 20px rgba(0,0,0,0.03)
- Text primary: #1C1917 (warm charcoal)
- Text secondary: #78716C (warm taupe)
- Text muted: #A8A29E
- Primary accent: #1C1917
- Border: #E7E5E4
- Hero background: #F9F7F2 or warm ambient gradient
- Typography pairing: Title/Heading font: 'Playfair Display', serif (with italic subheadings); Body/Labels font: 'Inter', sans-serif
- Eyebrows: 11-12px UPPERCASE, letter-spacing: 2px, font-weight: 600
- Buttons: #1C1917 background with #FDFBF7 text, border-radius:0px or 4px subtle rounded`,

  dark: `
COLOR PALETTE (Dark Premium — use these EXACT values):
- Page background: #0A0A0F
- Section backgrounds (alternate): #0F0F18, #12121E, #0A0A0F
- Card surface: #1A1A2E with border: 1px solid rgba(255,255,255,0.06)
- Card surface elevated: #22223A
- Primary accent: #6366F1 (indigo)
- Primary gradient: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)
- Secondary accent: #3B82F6 (blue)
- Tertiary accent: #0EA5E9 (cyan)
- Success: #10B981  |  Warning: #F59E0B  |  Error: #EF4444
- Text primary: #F8FAFC
- Text secondary: #94A3B8
- Text muted: #64748B
- Border: rgba(255,255,255,0.06)
- CTA glow: box-shadow: 0 0 30px rgba(99,102,241,0.3)
- Hero gradient: linear-gradient(180deg, rgba(10,10,15,0) 0%, #0A0A0F 100%)
- Glassmorphism card: background:rgba(26,26,46,0.7);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.08)`,

  light: `
COLOR PALETTE (Light Premium — use these EXACT values):
- Page background: #FFFFFF
- Section backgrounds (alternate): #F8FAFC, #F1F5F9, #FFFFFF
- Card surface: #FFFFFF with border: 1px solid #E2E8F0 and box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.03)
- Primary accent: #4F46E5 (deep indigo)
- Primary gradient: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)
- Secondary accent: #0EA5E9
- Success: #059669
- Text primary: #0F172A
- Text secondary: #475569
- Text muted: #94A3B8
- Border: #E2E8F0
- Hero background: linear-gradient(135deg, #EEF2FF 0%, #F0F9FF 50%, #FDF4FF 100%)
- CTA glow: box-shadow: 0 4px 16px rgba(79,70,229,0.25)`,

  vibrant: `
COLOR PALETTE (Vibrant/Playful — use these EXACT values):
- Page background: #FAFAFE
- Hero background: linear-gradient(135deg, #667EEA 0%, #764BA2 100%)
- Card surface: #FFFFFF with box-shadow: 0 4px 24px rgba(102,126,234,0.08)
- Primary accent: #667EEA
- Primary gradient: linear-gradient(135deg, #667EEA 0%, #764BA2 100%)
- Secondary gradient: linear-gradient(135deg, #F093FB 0%, #F5576C 100%)
- Tertiary gradient: linear-gradient(135deg, #4FACFE 0%, #00F2FE 100%)
- Text primary: #1A1A2E
- Text secondary: #555770
- Text muted: #8E8EA0
- Decorative: gradient blobs with border-radius:999px and opacity:0.1`,

  corporate: `
COLOR PALETTE (Corporate/Enterprise — use these EXACT values):
- Page background: #FAFBFD
- Section backgrounds: #F5F7FA, #FFFFFF
- Card surface: #FFFFFF with border: 1px solid #E5E8EB and box-shadow: 0 1px 2px rgba(0,0,0,0.04)
- Primary accent: #1A56DB (professional blue)
- Primary gradient: linear-gradient(135deg, #1A56DB 0%, #1E40AF 100%)
- Secondary accent: #047857 (teal)
- Text primary: #111928
- Text secondary: #4B5563
- Text muted: #9CA3AF
- Border: #E5E8EB
- Status: #059669 (active), #D97706 (pending), #DC2626 (error)`,

  premium: `
COLOR PALETTE (Premium SaaS — use these EXACT values):
- Page background: #09090B (near-black)
- Section backgrounds (alternate): #09090B, #0C0C10, #111118
- Card surface: rgba(24,24,36,0.8) with border: 1px solid rgba(255,255,255,0.06) and backdrop-filter:blur(12px)
- Primary accent: #818CF8 (soft indigo)
- Primary gradient: linear-gradient(135deg, #6366F1 0%, #A855F7 50%, #EC4899 100%)
- Secondary accent: #38BDF8
- CTA gradient: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)
- Text primary: #F9FAFB
- Text secondary: #A1A1AA
- Text muted: #71717A
- Border: rgba(255,255,255,0.06)
- Glassmorphism: background:rgba(255,255,255,0.03);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.06)
- Glow effects: box-shadow: 0 0 60px rgba(99,102,241,0.15), 0 0 120px rgba(168,85,247,0.08)
- Gradient mesh backgrounds: use radial-gradient(ellipse at 20% 50%, rgba(99,102,241,0.12) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(168,85,247,0.08) 0%, transparent 50%)`
};

// ─── System Prompt Base ───────────────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `You are a world-class Senior Product Designer at Apple/Stripe/Linear who outputs pixel-perfect, HIGH-FIDELITY HTML with inline styles.
Your output will be converted directly into Figma layers. It must be STUNNING, polished, and production-ready — worthy of Awwwards, Godly.website, and Land-book.
You are competing against Layermate and UXPilot premium plugins. Your output must look like a $50,000 design agency spent weeks crafting it.

ABSOLUTE RULES:
1. Output ONLY raw HTML. No markdown fences, no \`\`\`, no explanation, no comments, no reasoning text, no <think> or <thinking> tags.
2. Use ONLY inline styles (style="..."). No <style> blocks, no CSS classes.
3. Use ONLY flexbox: display:flex with flex-direction on every container. NEVER use display:grid, float, position:absolute/fixed/sticky.
4. Use px units for ALL dimensions — width, height, padding, margin, gap, font-size, border-radius. NEVER use %, rem, em, vh, vw, calc().
5. Width:100% is allowed ONLY on direct section wrappers that span the full page width. All cards, columns, images, and inner elements MUST use explicit px widths.
6. Use background (NOT background-color) so gradients work.
7. The root is a single <div> with specified width and flex-direction:column.
8. Wrap EVERY major section in <div data-section="SectionName">.
9. For icons, use simple inline <svg> with viewBox, stroke, fill.
10. NEVER use <ul>, <ol>, <li>, <table>, <tr>, <td>, <th> — use <div> for everything.
11. NEVER use emoji characters (🖼, 📊, ✅, etc.) in the output — use SVG icons or text instead.
12. Images MUST use <img> tags with src, style="width:Xpx;height:Ypx", NOT emoji or placeholder text.

DESIGN SYSTEM:
- Spacing: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 120px
- Font sizes: 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72px
- Font weights: 400 (regular), 500 (medium), 600 (semibold), 700 (bold), 800 (extrabold)
- Line heights: 1.1 for 42px+, 1.2 for headings, 1.4 for subheadings, 1.6 for body
- Letter spacing: -2px for 56px+, -1.5px for 48px, -1px for 36-47px, -0.5px for 24-35px, 0 body, 1.5px UPPERCASE labels
- Border radius: 6px subtle, 8px cards, 12px large cards, 16px hero, 24px modal, 999px pills
- Shadows (ALWAYS use 2-3 layered):
  * Cards: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)
  * Elevated: 0 2px 4px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.06)
  * Floating: 0 4px 8px rgba(0,0,0,0.04), 0 16px 48px rgba(0,0,0,0.08)

VISUAL HIERARCHY (CRITICAL — makes designs professional):
1. HERO must DOMINATE: 56-72px headline, -2px letter-spacing, font-weight:800, max-width:800px
2. Section headlines: 36-48px, font-weight:700-800, tight letter-spacing
3. Section eyebrows: 11-13px, UPPERCASE, letter-spacing:1.5px, accent color, font-weight:600
4. Body: 16-18px, line-height:1.6, secondary color, max-width:640px
5. ALTERNATE SECTION BACKGROUNDS for rhythm (don't make everything the same color)
6. GENEROUS PADDING: 80-120px vertical padding on each section
7. CTAs: gradient background, 14px 28px padding, font-weight:600, border-radius:10px, glow shadow

PREMIUM VISUAL TECHNIQUES (use throughout):
- Gradient mesh backgrounds on hero: radial-gradient overlays with accent colors at low opacity
- Glassmorphism cards: rgba background + backdrop-filter:blur(16px) + subtle border
- Floating elements: box-shadow with 3 layers for depth
- Accent glow: box-shadow: 0 0 40px rgba(accent,0.2) on CTAs and key elements
- Gradient text effect (simulate with solid accent color since Figma doesn't support gradient text)
- Icon containers: 48-56px square, rounded-12px, 10% opacity accent background

ICON SVG LIBRARY:
- Check: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
- Arrow: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
- Star: <svg width="20" height="20" viewBox="0 0 24 24" fill="#F59E0B" stroke="#F59E0B" stroke-width="1"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
- Lightning: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
- Shield: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
- Chart: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
- Users: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
- Globe: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>

═══════════════════════════════════════════════════════════════
SECTION BLUEPRINTS — Use EXACTLY the one matching the user's request
═══════════════════════════════════════════════════════════════

HEADER/NAV: <div data-section="Header" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:16px 48px;background:rgba(255,255,255,0.8);backdrop-filter:blur(12px)"><div style="font-size:20px;font-weight:800;color:#0F172A">Brand</div><div style="display:flex;gap:32px;align-items:center"><div style="font-size:14px;font-weight:500;color:#64748B">Features</div><div style="font-size:14px;font-weight:500;color:#64748B">Pricing</div><div style="font-size:14px;font-weight:500;color:#64748B">About</div><div style="background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Get Started</div></div></div>

HERO: Large 56-72px headline with -2px letter-spacing and font-weight:800. Supporting paragraph 18px. Two CTA buttons (gradient primary + outlined secondary). Optional large product screenshot/mockup image with explicit width and height in px.

SOCIAL PROOF / LOGO BAR: "Trusted by 2,000+ companies" eyebrow + row of 5-6 company name text labels (styled as muted, 14px, uppercase, letter-spacing:2px, spaced with gap:48px).

FEATURE GRID: Eyebrow + 36-48px headline + row of 3 feature cards (each card ~360px wide for 1200px content, or use flex:1). Each card: icon container (48x48, rounded-12, accent bg at 10%) + 20px bold title + 15px description.

FEATURE SPLIT (alternating): Two-column layout. One side: eyebrow + 36px headline + body text + CTA link (flex:1). Other side: large product image (width:560px;height:400px, rounded-16, with shadow). Alternate sides for each split.

STATS / METRICS ROW: 4 stat blocks in a row (each flex:1): big 42px number (font-weight:800, letter-spacing:-1.5px) + 14px label underneath.

TESTIMONIALS: 3 premium cards in a row (each flex:1). Each: 5 star SVGs + italic quote text + avatar circle (44px) + name (15px bold) + role (13px muted).

PRICING TABLE: 3 cards in a row, center card highlighted (with accent border and "Most Popular" badge). Each card: plan name + price (48px bold) + "/month" suffix + feature list with check icons + CTA button. Highlighted card gets gradient CTA, others get outlined CTA.

FAQ ACCORDION: Eyebrow "Frequently Asked Questions" + 36px headline. 6-8 items, each is a card-like row: question text (16px, font-weight:600) + chevron SVG icon on the right. First item expanded: shows answer text below (15px, color:secondary, line-height:1.6).

HOW IT WORKS: Eyebrow + headline + row of 3-4 step cards. Each step: number badge (32x32, rounded-999, accent bg, white text, font-weight:700) + title (18px bold) + description (15px muted).

INTEGRATIONS / LOGO CLOUD: Eyebrow + headline + grid of 8-12 integration cards. Each card: width:80px;height:80px, rounded-12, border:1px solid border-color, centered icon/text, padding:20px. Layout: display:flex;flex-direction:row;flex-wrap:wrap, gap:16px, justify-content:center.

BENEFITS / OUTCOMES: Eyebrow + headline + row of 3 benefit cards (each flex:1), then another row of 3 benefit cards. Each: icon container + bold title + one-line description.

CTA BANNER: Full-width section with gradient or dark background, centered layout. 36-48px white headline + supporting text + gradient CTA button with glow shadow.

FOOTER: Dark background (#0F172A or #111827). 4-column link layout (Product, Company, Resources, Legal) with 14px links. Bottom row: copyright text + social icon SVGs.

DASHBOARD STRUCTURE (for dashboard/admin/analytics prompts):
Root: <div data-section="AppShell" style="width:1440px;display:flex;flex-direction:row;background:#0A0A0F;min-height:960px">
1. Sidebar (260px, dark, nav links with active states)
2. Main Area (flex:1, vertical layout):
   - Top bar (64px, search + notifications + avatar)
   - Content area with KPI cards, charts (SVG), tables, etc.

COPY RULES:
- Write REAL copy matching the user's product/subject. No lorem ipsum.
- Headlines: max 9 words. Specific. Impactful.
- Descriptions: 1-2 sentences, value-focused.
- BANNED: elevate, seamless, unlock, empower, revolutionize, game-changing, cutting-edge, leverage, synergy

IMAGE RULES:
- Use REAL Unsplash URLs: https://images.unsplash.com/photo-{ID}?w={width}&h={height}&fit=crop
- ALWAYS specify BOTH explicit width AND height in px on every <img> element.
- NEVER use width:100% on <img> tags. Always use exact px widths.

CRITICAL INSTRUCTION: Output ALL sections the user requests. Do NOT skip or omit any. Each section must have real content, not empty placeholders.

OUTPUT EXACTLY ONE <div> AS ROOT. No DOCTYPE, html, head, or body tags.`;

// ─── Prompt Builders ──────────────────────────────────────────────────────────

function detectThemeFromPrompt(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes('fashion') || p.includes('luxury') || p.includes('apparel') || p.includes('brand') || p.includes('clothing') || p.includes('editorial') || p.includes('atelier') || p.includes('jewelry') || p.includes('boutique') || p.includes('lifestyle')) return 'luxury';
  if (p.includes('dark') || p.includes('dark mode') || p.includes('dark theme') || p.includes('dark enterprise')) return 'dark';
  if (p.includes('vibrant') || p.includes('playful') || p.includes('colorful')) return 'vibrant';
  if (p.includes('corporate') || p.includes('enterprise') || p.includes('professional')) return 'corporate';
  if (p.includes('light mode') || p.includes('light theme') || p.includes('clean') || p.includes('minimal')) return 'light';
  return '';
}

function getThemePalette(style: string, prompt = ''): string {
  const detected = detectThemeFromPrompt(prompt);
  if (detected && THEME_PALETTES[detected]) return THEME_PALETTES[detected];
  if (style === 'dashboard' || style === 'enterprise') return THEME_PALETTES.dark;
  if (style === 'startup') return THEME_PALETTES.vibrant;
  if (style === 'saas' || style === 'corporate') return THEME_PALETTES.corporate;
  return THEME_PALETTES.light;
}

export function buildSystemPrompt(style: string, prompt = ''): string {
  return SYSTEM_PROMPT_BASE + '\n\n' + getThemePalette(style, prompt);
}

export function buildAgentPrompt(prompt: string, device: string, style: string): string {
  const w = DEVICE_WIDTHS[device] || 1440;

  const sectionHits = (prompt.toLowerCase().match(/\b(hero|header|nav|footer|pricing|faq|testimonial|feature|benefit|how it works|integration|showcase|cta|social proof|stats|metric|logo|newsletter|about|team|contact|gallery|portfolio|blog|comparison|announcement|banner)\b/g) || []).length;

  const estimatedSections = Math.max(sectionHits, 8);

  return `${prompt.trim()}

TECHNICAL REQUIREMENTS:
- Root div: style="width:${w}px;display:flex;flex-direction:column"
- Use the color palette from the system prompt — do NOT invent random colors
- Use the section blueprints from the system prompt for each section type
- Every section: generous 80-120px vertical padding, centered content with max-width:1200px
- Hero headline: 56-72px, font-weight:800, letter-spacing:-2px
- Layered shadows on all cards (2-3 shadow values)
- SVG icons in feature cards and navigation
- Gradient backgrounds on CTA buttons
- Alternate section backgrounds for visual rhythm
- Real Unsplash image URLs (https://images.unsplash.com/photo-...)
- Output ALL ${estimatedSections}+ sections with data-section attributes — do NOT skip any
- Write REAL copy specific to this product. No lorem ipsum, no placeholder text.
- Every section must have FULL content — populated cards, real text, proper styling. No empty sections.`;
}

// ─── Telemetry SSE Passthrough ────────────────────────────────────────────────
//
// Wraps the raw IncomingMessage in a Transform stream that:
//   1. Passes every byte through unchanged (stream behaviour is identical)
//   2. Inspects SSE data lines for finish_reason and usage metadata
//   3. Resolves telemetryPromise when the stream ends

function wrapWithTelemetry(
  source: http.IncomingMessage,
  startTime: number,
  model: string,
  complexityScore: number,
  tokenBudget: number
): OpenRouterStreamResult {
  let promptTokens     = 0;
  let completionTokens = 0;
  let reasoningTokens  = 0;
  let totalTokens      = 0;
  let finishReason: StreamTelemetry['finishReason'] = 'unknown';
  let resolveTelemetry!: (t: StreamTelemetry) => void;

  const telemetryPromise = new Promise<StreamTelemetry>((resolve) => {
    resolveTelemetry = resolve;
  });

  let lineBuffer = '';

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      lineBuffer += chunk.toString('utf8');

      // Process complete lines from the buffer
      let nlIdx: number;
      while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nlIdx).trim();
        lineBuffer  = lineBuffer.slice(nlIdx + 1);

        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const json = JSON.parse(line.slice(6));

            // Capture finish_reason (may appear before usage in some models)
            const choice = json.choices?.[0];
            if (choice?.finish_reason && choice.finish_reason !== null) {
              finishReason = choice.finish_reason as StreamTelemetry['finishReason'];
            }

            // Capture token usage (usually in the last non-[DONE] chunk)
            if (json.usage) {
              promptTokens     = json.usage.prompt_tokens     ?? promptTokens;
              completionTokens = json.usage.completion_tokens ?? completionTokens;
              reasoningTokens  = json.usage.reasoning_tokens  ?? reasoningTokens;
              totalTokens      = json.usage.total_tokens       ?? totalTokens;
            }
          } catch { /* ignore SSE parse errors — data passes through unchanged */ }
        }
      }

      this.push(chunk);
      callback();
    },

    flush(callback) {
      const durationMs = Date.now() - startTime;
      resolveTelemetry({
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalTokens:   totalTokens || promptTokens + completionTokens,
        finishReason,
        durationMs,
        model,
        complexityScore,
        tokenBudget,
      });
      callback();
    },
  });

  // Pipe source into transform; propagate source errors
  source.pipe(transform);
  source.on('error', (err) => transform.destroy(err));

  return { stream: transform, telemetryPromise, model, complexityScore, tokenBudget };
}

// ─── callOpenRouterStream ─────────────────────────────────────────────────────
//
// Main entry point for generation.
//
// Integrates all 4 pillars:
//   Pillar 1 — Wraps stream in telemetry passthrough (wrapWithTelemetry)
//   Pillar 2 — Uses dynamic token budget from scoreComplexity
//   Pillar 4 — Routes model via resolveModel based on complexity + plan
//
// @param opts - Generation options (prompt, device, style, model, etc.)
// @param plan - User's plan for model routing ('free' | 'pro')

export function callOpenRouterStream(
  opts: GenerateOptions,
  plan = 'free'
): Promise<OpenRouterStreamResult> {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      return reject(new Error('OPENROUTER_API_KEY is not configured on the server.'));
    }

    // ── Pillar 2: Dynamic Token Budget ───────────────────────────────────────
    // Use pre-computed complexity if budget middleware already scored (avoids re-scoring)
    const complexity  = opts._complexity ?? scoreComplexity(opts.prompt, opts.device);
    const tokenBudget = opts.maxTokens
      ? Math.min(opts.maxTokens, complexity.tokenBudget)
      : complexity.tokenBudget;

    // ── Pillar 4: Model Routing ───────────────────────────────────────────────
    const modelKey   = opts.model ?? 'kimi-2-6';
    const rawModel   = MODEL_MAP[modelKey] ?? (modelKey.includes('/') ? modelKey : DEFAULT_MODEL);
    const modelName  = resolveModel(rawModel, complexity.score, plan);

    // ── Prompt Construction ───────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(opts.style, opts.prompt);
    const userPrompt   = buildAgentPrompt(opts.prompt, opts.device, opts.style);

    const payload = JSON.stringify({
      model:       modelName,
      max_tokens:  tokenBudget,
      temperature: opts.temperature ?? 0.3,
      stream:      true,
      // Ask OpenRouter to include usage metadata in stream chunks (Pillar 1)
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    });

    const startTime = Date.now();

    const reqOptions: https.RequestOptions = {
      hostname: 'openrouter.ai',
      port:     443,
      path:     '/api/v1/chat/completions',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'HTTP-Referer':   'https://wireframe-ai.figma.plugin',
        'X-Title':        'Wireframer AI',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(reqOptions, (res: http.IncomingMessage) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          reject(new Error(`OpenRouter error ${res.statusCode}: ${body}`));
        });
        return;
      }

      // ── Pillar 1: Wrap stream with telemetry passthrough ──────────────────
      const result = wrapWithTelemetry(res, startTime, modelName, complexity.score, tokenBudget);
      resolve(result);
    });

    req.on('error', (err: Error) => {
      reject(new Error(`OpenRouter network error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}
