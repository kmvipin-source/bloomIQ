import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 90;

// =============================================================================
// POST /api/visualizer/create
// -----------------------------------------------------------------------------
// Body: { topic: string }
//
// Generates an animated explainer for the topic. Each frame ships with
// EMBEDDED SMIL animations (<animate>, <animateTransform>, <animateMotion>)
// so motion happens INSIDE the SVG itself — orbiting electrons, pulsing
// hearts, flowing currents — not just cross-fades between static slides.
//
// We sanitize each SVG (strip script/iframe/foreignObject) before persisting
// since these are rendered with dangerouslySetInnerHTML on the client.
// =============================================================================

const SYSTEM = `You are an expert teacher creating a step-by-step animated explainer of a concept for a student. The frames will be cross-faded into a flipbook so the student SEES the concept come alive.

Output a sequence of 4-5 frames. Each frame is:
- a RICH labeled SVG (viewBox 0 0 800 480, no scripts) with EMBEDDED SMIL ANIMATIONS
- a 1-2 sentence caption explaining what the frame shows
- a duration in ms (4000-6500)

The frames must tell a story: frame 1 sets up the scene, each subsequent frame adds, transforms, or zooms in on a key part. Build the concept progressively. The LAST frame should show the full concept in its complete form.

==============================
THE BIG RULE: EVERY FRAME MUST MOVE.
==============================
A static SVG is not enough. Inside EVERY frame, embed at least 3 SMIL animations that loop while the frame is on screen. Pick what fits the concept:

1. <animateMotion dur="3s" repeatCount="indefinite"><mpath href="#path-id"/></animateMotion>
   Moves an element along a path. Perfect for: electrons orbiting, blood through vessels, current through a circuit, water through a cycle, planets orbiting, particles in a reaction.

2. <animateTransform attributeName="transform" type="rotate" from="0 cx cy" to="360 cx cy" dur="6s" repeatCount="indefinite"/>
   Rotates a group around (cx,cy). Perfect for: gears, planets, wheels, rotating fields.

3. <animate attributeName="r" dur="1.5s" repeatCount="indefinite" values="20;28;20" keyTimes="0;0.5;1"/>
   Pulses size or color. Perfect for: heartbeat, neuron firing, signal nodes, hot spots, attention focus.

4. <animate attributeName="stroke-dashoffset" from="200" to="0" dur="2s" repeatCount="indefinite"/>
   Draws a flowing line (combine with stroke-dasharray="8 8"). Perfect for: current, signal flow, conveyor belts, time arrows.

5. <animate attributeName="opacity" values="0.3;1;0.3" dur="2s" repeatCount="indefinite"/>
   Fades in and out. Perfect for: glowing, breathing, blinking indicators.

CONCRETE EXAMPLES (inspiration, do NOT copy verbatim):
- Atom: nucleus + 2 electrons each on their own elliptical <path id="orbit1"> with <circle><animateMotion><mpath href="#orbit1"/></animateMotion></circle>.
- Heart pump: heart shape with <animate attributeName="transform" type="scale" values="1;1.08;1" dur="0.9s" repeatCount="indefinite"/> for the pulse, plus dashed arrows on vessels showing flow.
- Photosynthesis: sunlight rays as <line> elements with stroke-dashoffset animating; CO2/O2 molecules as small <circle>s moving along curved paths into and out of the leaf.
- Newton's third law: rocket with thrust flame whose height pulses; exhaust particles travel down along motion paths; rocket itself gently translates upward.

SVG quality bar (still applies):
- viewBox="0 0 800 480"
- 8-14 distinct visual elements per frame
- Gradients via <defs><linearGradient/></defs> on at least 2 main shapes
- Label every important shape with <text>
- Palette: #10b981 #f59e0b #ef4444 #6366f1 #ec4899 #06b6d4 - mix 3+ hues per frame
- Background: soft gradient or grid (not blank white)
- One shared shadow <filter> in <defs> for depth
- Final frame: include a "key takeaway" rect + text at the bottom

Allowed elements: <svg>, <defs>, <linearGradient>, <radialGradient>, <stop>, <filter>, <feGaussianBlur>, <feOffset>, <feMerge>, <feMergeNode>, <marker>, <rect>, <circle>, <ellipse>, <line>, <path>, <polygon>, <polyline>, <text>, <tspan>, <g>, <use>, <title>, <animate>, <animateTransform>, <animateMotion>, <mpath>, <set>.
NOT allowed: <script>, <foreignObject>, <iframe>, <object>, <embed>, on* event handlers, javascript: URLs, external href.

Each frame's SVG should LOOK related to the previous one (same scene, progressive additions) so the cross-fade reads as motion. Reuse position+size of stable elements across frames.

Keep total chars per SVG under 6500. Final frame can be slightly richer.

Respond with VALID JSON only:
{
  "title": "<short concept title>",
  "summary": "<2-3 sentences summarising the key idea>",
  "frames": [
    {
      "svg": "<svg viewBox=\\"0 0 800 480\\" xmlns=\\"http://www.w3.org/2000/svg\\">...</svg>",
      "caption": "...",
      "duration_ms": 5000
    }
  ]
}`;

type Frame = { svg: string; caption: string; duration_ms: number };

function sanitizeSvg(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  s = s.replace(/<\?xml[^>]*\?>/gi, "");
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  s = s.replace(/<object[\s\S]*?<\/object>/gi, "");
  s = s.replace(/<embed[\s\S]*?<\/embed>/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/href\s*=\s*"javascript:[^"]*"/gi, "");
  s = s.replace(/href\s*=\s*'javascript:[^']*'/gi, "");
  if (!/^<svg[\s>]/i.test(s)) return "";
  // Generous cap so verbose SMIL <animate values=...> tags don't get truncated.
  return s.slice(0, 12000);
}

function cleanFrames(arr: unknown): Frame[] {
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[])
    .map((f) => {
      const o = (f || {}) as Record<string, unknown>;
      const svg = sanitizeSvg(String(o.svg || ""));
      const caption = String(o.caption || "").trim().slice(0, 400);
      const dur = Math.max(2000, Math.min(8000, Math.round(Number(o.duration_ms) || 4500)));
      if (!svg || !caption) return null;
      return { svg, caption, duration_ms: dur };
    })
    .filter((f): f is Frame => f !== null)
    .slice(0, 6);
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const topic: string = String(body.topic || "").trim();
    if (topic.length < 3) {
      return NextResponse.json({ error: "Pick a topic (at least 3 characters)." }, { status: 400 });
    }
    if (topic.length > 200) {
      return NextResponse.json({ error: "Topic too long (max 200 chars)." }, { status: 400 });
    }

    const userPrompt = `Topic: ${topic}\n\nProduce the JSON now. Remember: 4-5 SVG frames, each tells one step of the story, with embedded SMIL motion.`;
    const raw = await groqJSON(SYSTEM, userPrompt);

    const frames = cleanFrames((raw as { frames?: unknown }).frames);
    if (frames.length < 2) {
      return NextResponse.json(
        { error: "We couldn't build a clean animation for that topic. Try rephrasing." },
        { status: 502 }
      );
    }

    const title = String((raw as { title?: unknown }).title || topic).trim().slice(0, 120);
    const summary = String((raw as { summary?: unknown }).summary || "").trim().slice(0, 1000) || null;

    const { data: row, error: insErr } = await sb
      .from("concept_animations")
      .insert({
        user_id: user.id,
        topic,
        title,
        frames,
        summary,
      })
      .select("id, created_at")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      id: row.id,
      created_at: row.created_at,
      title,
      summary,
      frames,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Visualizer failed" },
      { status: 500 }
    );
  }
}
