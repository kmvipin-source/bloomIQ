import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { geminiJSON, geminiText, isGeminiConfigured } from "@/lib/gemini";
import { fixFrameLayout, type LayoutElement } from "@/lib/visualizerLayout";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { requireFeature } from "@/lib/featureAccess.server";
import { checkRateLimit, checkDailyCap } from "@/lib/rateLimit";
import { consumeLifetimeUse } from "@/lib/freeQuota";

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

const SYSTEM = `You are a concept visualizer for any technical or scientific subject — academic OR professional. Output a sequence of 5 frames; the React renderer will use Motion to interpolate element positions between frames so shapes that share an id move smoothly. Your job is to give the renderer clean keyframes.

================================================================================
STAGE 1 — INTERNAL PLANNING (think this through, do NOT emit it)
================================================================================
Before writing any JSON, mentally answer:
  Q1: What domain is the topic? Examples (non-exhaustive):
        Academic / scientific  — mechanics, electromagnetism, optics,
                                 thermodynamics, cell biology, organic chemistry,
                                 electronics, data structures, economics.
        Software / programming — language internals (HashMap collisions, GC,
                                 closures), algorithms, design patterns,
                                 concurrency, database transactions, OS
                                 scheduling, networking, security protocols.
        Enterprise / mainframe — CICS transaction flow, JCL job lifecycle,
                                 DB2 query plan, MQ message flow, COBOL program
                                 structure, IMS hierarchical access.
        Systems / architecture — distributed systems, microservices, message
                                 queues, caching layers, load balancing, OAuth,
                                 TLS handshake, DNS resolution.
        Business / process     — supply chain, ITIL incident lifecycle, SDLC,
                                 ERP modules, accounting cycle, KYC flow.
  Q2: What are the 5 actual phases the learner needs to see? They MUST be the
      real, named stages of the concept — not generic "intro / middle / end".
        - "Projectile motion"     → Launch / Ascent / Peak / Descent / Impact
        - "Krebs cycle"           → Acetyl-CoA enters / Citrate forms /
                                    α-Ketoglutarate / Succinyl-CoA / Oxaloacetate regen
        - "Carnot cycle"          → Isothermal expansion (T_h) / Adiabatic
                                    expansion / Isothermal compression (T_c) /
                                    Adiabatic compression / Net work label
        - "Op-amp inverting amp"  → Input applied / Virtual short /
                                    Current through R_in / Same current
                                    through R_f / V_out = -(R_f/R_in)·V_in
        - "Java HashMap put"      → Hash compute / Bucket index / Empty bucket
                                    insert / Collision (chain to linked list) /
                                    Tree-ify when chain ≥ 8
        - "CICS transaction flow" → Terminal input / TCT lookup / Task created
                                    in TCB / BMS map send / SYNCPOINT commit
        - "OAuth 2.0 auth code"   → User clicks login / Redirect to auth
                                    server with client_id / User consents,
                                    code returned / Code exchanged for token /
                                    Token used on resource server
  Q3: What entities live in each phase? Name them with semantic ids:
      "piston", "gas_molecule_1", "hot_reservoir", "cold_reservoir",
      "v_in_label", "tension_arrow_left", "rope", "pulley_wheel",
      "mitochondrion", "atp_molecule", "hash_bucket_3", "linked_list_node",
      "cics_tct_entry", "tcb_block", "auth_server", "access_token",
      "kafka_partition", "tls_client_hello", etc.
      DO NOT use generic ids like "circle1", "rect2", "ball" when the actual
      thing is "electron" or "succinate" or "load_resistor" or "hash_bucket".
  Q4: What's the takeaway formula, rule, or canonical signature that should
      appear in frame 5? It must be the canonical fact for this exact topic.
      Examples by domain:
        - Physics:  F = ma, η = 1 - T_c/T_h, V_out = -A·V_in
        - Chem:     ΔG = ΔH - TΔS
        - Software: HashMap.put: O(1) avg, O(log n) tree-ified worst case
        - Mainframe: CICS task = TCB + EIB + working storage; commit boundary at SYNCPOINT
        - Protocols: OAuth code flow: code (one-time) → token (bearer)
        - Algorithms: QuickSort avg O(n log n), worst O(n²) on sorted input

If the topic isn't a real concept (e.g. "draw a cat"), gracefully treat it as
the closest learning concept (anatomy of a cat) — never output abstract
decorative shapes.

================================================================================
STAGE 2 — JSON OUTPUT (this is what you emit)
================================================================================

Output VALID JSON only, no markdown fences:
{
  "title": "<short concept title>",
  "summary": "<2-3 sentences summarising the key idea>",
  "frames": [
    {
      "step_label": "Launch",
      "caption": "Ball leaves the ground at 20 m/s, 45° from horizontal. Velocity arrow tilts up-right.",
      "duration_ms": 4500,
      "elements": [
        { "id": "title",        "type": "text", "x": 30,  "y": 34,  "text": "Projectile motion", "fontSize": 22, "fontWeight": "700", "fill": "#0f172a" },
        { "id": "phase_badge",  "type": "text", "x": 30,  "y": 78,  "text": "Phase 1 of 5 — Launch", "fontSize": 13, "fill": "#475569" },
        { "id": "axis_x",       "type": "line", "x1": 80, "y1": 360, "x2": 720, "y2": 360, "stroke": "#94a3b8", "strokeWidth": 2 },
        { "id": "axis_y",       "type": "line", "x1": 80, "y1": 360, "x2": 80,  "y2": 110, "stroke": "#94a3b8", "strokeWidth": 2 },
        { "id": "axis_x_label", "type": "text", "x": 700, "y": 380, "text": "x (m)", "fontSize": 12, "fill": "#475569" },
        { "id": "axis_y_label", "type": "text", "x": 50,  "y": 110, "text": "y (m)", "fontSize": 12, "fill": "#475569" },
        { "id": "ground",       "type": "rect", "x": 80,  "y": 360, "width": 640, "height": 14, "fill": "#94a3b8->#475569" },
        { "id": "ball",         "type": "circle", "cx": 100, "cy": 350, "r": 14, "fill": "#ef4444->#b91c1c", "shadow": true, "emphasize": true },
        { "id": "v_arrow",      "type": "line", "x1": 100, "y1": 350, "x2": 170, "y2": 280, "stroke": "#6366f1", "strokeWidth": 4, "animate": "wiggle" },
        { "id": "v_label",      "type": "text", "x": 178, "y": 278, "text": "v₀ = 20 m/s", "fontSize": 14, "fill": "#3730a3", "fontWeight": "600" },
        { "id": "theta_label",  "type": "text", "x": 130, "y": 340, "text": "θ = 45°", "fontSize": 13, "fill": "#0f172a" },
        { "id": "g_arrow",      "type": "line", "x1": 100, "y1": 350, "x2": 100, "y2": 392, "stroke": "#0f172a", "strokeWidth": 2 },
        { "id": "g_label",      "type": "text", "x": 60,  "y": 405, "text": "g = 9.8 m/s²", "fontSize": 12, "fill": "#0f172a" },
        { "id": "trajectory",   "type": "path", "d": "M100 350 Q400 90 700 350", "stroke": "#10b981", "strokeWidth": 3, "fill": "none", "strokeDasharray": "6 6", "animate": "flow" }
      ]
    }
  ]
}

(Note how every coordinate respects the layout regions: title at y=34, phase badge at y=78, axes at y=360 + x=80, scene shapes between y=110..360, ground at y=360, takeaway would go at y=420..460. No two non-text shapes overlap. 6 motion-flagged elements with 3 different presets — emphasize/wiggle/flow.)

Rules:
- viewBox is implicitly 0 0 800 480. Coordinates fit within it. Use the full canvas — fill it visually with detail.
- **CANVAS LAYOUT — strictly observe these regions, do NOT place hero elements outside their box:**
  - **Title strip:** y = 0..50. A single text element with the concept title can sit here (fontSize 22, fontWeight 700, x ≈ 30).
  - **Top label gutter:** y = 50..100. Use for global axis labels, legend, equation badge, "Step focus" annotation.
  - **MAIN SCENE:** y = 100..360, x = 80..720. The diagram lives here. Hero shapes (pulley wheel, atom, op-amp triangle, cell membrane, P-V plot, etc.) go inside this box. Scenes wider than 640 should breathe a little — leave 30..50 px of empty margin around the focal cluster.
  - **Side gutters:** x = 0..80 and x = 720..800. Use for axis labels (m/s, kPa), legends, vector key, secondary annotations. Do not put primary shapes here.
  - **Takeaway strip:** y = 400..470. The final-frame summary rect goes here (a wide rect spanning x = 60..740, height 50, with a centred text containing the canonical formula).
- **NO OVERLAP RULE:** unless two shapes are physically connected (a tension arrow touching a mass, a label tied to its element with a 4 px gap), keep at least 32 px of empty space between non-text shapes. Text labels may sit just above/below/beside their target, but never on top of another shape.
- **GRID & ALIGNMENT — snap every coordinate to a 24 px grid (multiples of 24 for hero shape centres / rect origins; multiples of 8 for fine adjustments and text). Aligned coordinates read as "designed", drifty coordinates read as "AI-generated". Examples: cx=240 (good), cx=237 (bad). x=120 width=240 (good), x=117 width=243 (bad).** When two shapes are meant to be horizontally aligned, give them the SAME y. When stacked vertically, give them the SAME x. When in a row of 3+, evenly distribute: x = 100, 280, 460, 640.
- **LABEL ANCHORING — every text label must point at one specific shape and live in a predictable spot relative to it (above by 18 px, right by 12 px, below by 22 px, etc). Pick ONE rule per label group and keep it consistent within the frame.** Never let a label sit on top of a shape it isn't part of, and never let two labels collide. If a long label can't fit beside its target without overlapping the next shape, shorten the label or split into two lines using two text elements.
- **SAFE CANVAS INSET — keep all hero shapes inside x ∈ [60, 740] and y ∈ [60, 420]. The 40 px padding around the edges is for breathing room only — do NOT place shapes there. The takeaway-rect strip y=420..460 is the only allowed exception and must not be wider than x=80..720.**
- **AXIS / FRAME PROPS** (always include when the topic has a measurable axis):
  - Mechanics: ground line at y=380 + x-axis gridlines + y-axis gridlines + axis arrows.
  - Thermodynamics / kinetics graphs: P–V axes anchored at (120,360) → (700,360) horizontal and (120,360) → (120,110) vertical, with arrowheads at the far ends and tick labels at quarters.
  - Circuits: power rails as horizontal lines at y=140 (V+) and y=340 (GND), components live between them.
- **MINIMUM 10 elements per frame**, target 12-16. Sparse frames look amateur. Include axes, gridlines, labels, units, decorative supporting shapes (clouds, trees, springs, vector tails) wherever they make the physics readable.
- Re-use the same "id" across frames for elements that should TWEEN (the ball at different positions, an arrow that rotates). New ids appear/disappear as the story progresses. Stable scene elements (ground, axis, sun) keep the same id throughout.
- Allowed types: "circle" {cx,cy,r}, "rect" {x,y,width,height,rx?}, "ellipse" {cx,cy,rx,ry}, "line" {x1,y1,x2,y2}, "path" {d}, "polygon" {points}, "text" {x,y,text}, "group" {children: Element[], transform?}.
- Common props on every element: fill, stroke, strokeWidth, strokeDasharray, opacity (0..1), rotate (deg), fontSize (text), fontWeight (text).
- **VISUAL CHROME** props (use them to lift the design):
  - "fill" / "stroke" can be a 2-stop gradient string with the syntax "<color1>-><color2>" (e.g. "#10b981->#0ea5e9"). The renderer auto-generates a vertical <linearGradient>. Use this on at least 2 main shapes per frame.
  - "shadow": true → soft drop shadow under the shape. Use on round / hero shapes.
  - "glow": true → outer glow halo. Use sparingly on the focal element.
  - "emphasize": true → the renderer adds a gentle pulse animation to this element while the frame is on screen. Use on EXACTLY ONE element per frame — the thing the student should look at.
- **AMBIENT MOTION** — the frame should never look static. Add an "animate" preset to AT LEAST 5 elements per frame, ideally 6-8. Use a MIX of presets (don't use the same one on every flagged element — variety reads as dynamic). Pick whichever fits the physics:
  - "spin": continuous rotation around the element's centre. Use for: gears, wheels, turbines, rotating fields, planets, orbits seen from above.
  - "bob": small up-down oscillation. Use for: floating objects, breathing chest, hovering drone, suspended weight on a spring.
  - "drift": slow horizontal drift back and forth. Use for: clouds, waves moving across the scene, particles in a fluid.
  - "flash": opacity blink (1→0.4→1). Use for: lights, indicators, neuron firing, pulsing power source, "current here" markers.
  - "wiggle": tiny rotational shake. Use for: vibrating molecules, an arrow being pointed at, a button being clicked.
  - "flow": animated stroke-dashoffset (the line "moves"). Use only on path/line elements. Perfect for: current flow, signal flow, water flowing in a pipe, conveyor belts.
  - "orbit": small circular motion around the element's centre. Use for: electrons around a nucleus, satellites, particles in a centripetal field.
  Combine animate + emphasize on different elements; never on the same element.
- **MOTION DIVERSITY CHECK** — before emitting, count: each frame should use at least 3 distinct preset names. A frame with 5 "spin" elements is wrong. A frame with spin + flow + flash + bob + emphasize feels alive.
- Frames tell a story. Frame 1 = setup. Last frame = full concept + a clearly labelled "takeaway" rect at the bottom containing the key formula or rule.
- Step labels are SHORT ("Launch", "Peak", "Descent", "Impact"). Captions are 1-2 sentences and refer to specific element ids if helpful.
- **CONTENT FIDELITY** (this is the most important rule):
  - The visual must match the concept's *actual* mechanism, not a generic stand-in. A pulley problem MUST show a pulley wheel (circle) with a rope (path) draped over it, masses (rects) hanging from each side, and tension arrows. It must not show a generic ball-and-line scene that "looks pulley-ish".
  - Every text label must be a real domain term: "tension T", "gravity mg", "θ = 30°", "ATP", "succinate", "v_in", "V_out = -(R_f/R_in)·V_in", "P-V diagram", "isothermal", etc. Never use placeholder text like "Step 1" or "Force" without specifics.
  - For numerical concepts, include real numbers: "v₀ = 20 m/s", "g = 9.8 m/s²", "θ = 45°", "R_f = 10 kΩ".
  - Domain checklists:
    - **Mechanics** → ground line, gravity arrow with mg label, vector arrows with magnitude, x/y axes when angle matters, FBD-style force decomposition where relevant.
    - **Thermodynamics** → P-V or T-S axes, gas particles inside a container, hot/cold reservoir rectangles labelled with temperatures, work and heat arrows.
    - **Electronics / circuits** → component symbols (resistor zigzag via path, capacitor as two parallel lines, inductor as loops, op-amp triangle, transistor symbol), wires as paths, voltage / current labels.
    - **Cell biology / metabolism** → labelled organelles or substrate molecules with arrows showing enzymatic conversion. Each step shows the actual molecule name (Acetyl-CoA, Pyruvate, etc).
    - **Organic chemistry** → Kekulé-style structures: rings, bond lines, atomic labels (C, H, O, N), reaction arrows with conditions over them.
    - **Optics** → light rays as straight paths with arrowheads, lens/mirror cross-section, normal lines, angles labelled (i, r, c).
    - **Data structures / algorithms** → boxes for nodes/cells, arrows for pointers, the active node emphasised, index labels. For HashMap: array of buckets (rect grid) with index labels 0..n-1; each bucket either empty or holds a chain of node-rects with (key, value, next) text labels. For trees: parent/child rects connected by lines, the visited node emphasised. For sorting: an array of bars whose heights represent values; swapped pair gets emphasize+wiggle.
    - **Software systems / architecture** → labelled service/component rects (e.g. "API Gateway", "Auth Service", "Postgres", "Redis", "Kafka topic 'orders'"), connected by directional arrows (paths with arrowheads). Each arrow gets a label like "POST /login", "publish OrderCreated", "SELECT … FOR UPDATE". Use animate=flow on the active call path. Stack layers vertically (client at top, services in middle, datastores at bottom) when the topology is layered.
    - **Mainframe / CICS / JCL** → terminal/3270 rect at the left labelled with the transid (e.g. "TRAN: ORDR"), then the CICS region rect containing TCT entry, TCB block, EIB block, working storage, all stacked. Arrows show the journey: terminal → TCT lookup → TCB dispatch → COBOL program → DB2/VSAM call → BMS map send → SYNCPOINT. Use animate=flash on the active block per frame. For JCL: vertically stacked job/step rects with DD-statement sub-rects, arrows showing dataset I/O.
    - **Networking / protocols** → client rect on left, server(s) on right, arrows between them as path elements with labelled message text above each arrow ("ClientHello", "ServerHello + cert", "Finished"). Number the arrows 1, 2, 3 to convey ordering. Time flows top-to-bottom. animate=flow on the in-flight message of the current frame.
    - **Concurrency / threads** → vertical lanes per thread, time flows top-to-bottom, locks shown as small key icons (rect + circle), critical sections shaded; deadlock visualised as two threads each holding what the other wants.
    - **Business / lifecycle processes** → swim-lanes per actor (User / System / Approver / etc.) running left-to-right, rounded-rect activity nodes connected by arrows, decision diamonds (polygon) where branching happens, the active node emphasised per frame.
- **WHAT TWEEN BETWEEN FRAMES MEANS:** if the same physical entity exists in frame N and frame N+1, give it the SAME id and the renderer will smoothly interpolate its position/size/rotation. Use this to make motion read continuously: a piston compressing the gas → same "piston" id with different x; the ball flying through air → same "ball" id with different (cx, cy); the electron orbiting → same "electron" id with the orbit preset PLUS slightly different cx/cy keyframes per frame so the orbit precesses.
- Palette: #10b981 (green), #f59e0b (amber), #ef4444 (red), #6366f1 (indigo), #ec4899 (pink), #06b6d4 (cyan), #8b5cf6 (purple), #0f172a (slate-900 for text). Mix at least 3 hues per frame.
- For text, use Unicode glyphs freely: subscripts (v₀, t₁), superscripts (m²), symbols (θ, π, Δ, →, ↑, ↓), and inline equations ("F = ma", "v² = u² + 2as"). At least 3 text labels per frame, plus units where applicable ("m/s", "N", "kg").
- **MATH TYPESETTING — when a text element is a real equation, ALSO emit a "latex" field on it.** The renderer substitutes KaTeX for that text element so the equation renders with proper math typography (fractions, integrals, vectors, matrices). Example: a text element with text "V_out = -(R_f/R_in) * V_in" can carry latex "V_{out} = -\\\\frac{R_f}{R_{in}} \\\\cdot V_{in}". Always set BOTH fields so the plain-text fallback exists if KaTeX is unavailable. Use latex for: fractions \\frac, integrals \\int, sums \\sum, vectors \\vec, derivatives \\frac{d}{dt}, matrices \\begin{pmatrix}…\\end{pmatrix}, Greek (\\theta, \\pi, \\alpha), and any equation with subscripts/superscripts that require visual structure. Skip latex for short labels like axis names or units.
- duration_ms: 3500..6500. Big visual changes deserve more time.

WORKED EXAMPLES — note the SEMANTIC ids and the domain-specific elements:

1) "Projectile motion at 45°":
   - Phases: Launch / Ascent / Peak / Descent / Impact + range label
   - Persistent ids across frames: "ground", "axis_x", "axis_y", "ball", "trajectory_path", "v_arrow", "g_arrow"
   - Frame 1 elements: ground rect, x-axis line, y-axis line, ball (cx=80,cy=400), v_arrow (45° from ball), v_label "v₀ = 20 m/s", angle_arc, theta_label "θ=45°", g_arrow (down from ball), g_label "g = 9.8 m/s²", trajectory_path (dashed parabola), title text. emphasize=true on v_arrow, animate=flow on trajectory_path.
   - Frame 5 takeaway rect with "Range R = v₀²·sin(2θ)/g = 40.8 m"

2) "Newton's third law in a pulley":
   - Phases: System at rest / Pull starts / Mass A rises / Mass B falls / Equilibrium with action-reaction pairs labelled
   - Persistent ids: "ceiling", "pulley_axle", "pulley_wheel" (animate=spin), "rope" (path with stroke="#475569"), "mass_a" (rect), "mass_b" (rect), "tension_left_arrow", "tension_right_arrow", "weight_a_arrow", "weight_b_arrow"
   - Tension arrows must be opposite on the rope at the wheel (showing T = T pair). Weight arrows must point down with labels "m_A g" and "m_B g".
   - Frame 5 takeaway: "Action = -Reaction:  T_rope on A = -T_A on rope"

3) "Krebs cycle (citric acid cycle)":
   - Phases: Acetyl-CoA + OAA → Citrate / Citrate → α-KG (release CO₂, NADH) / α-KG → Succinyl-CoA (release CO₂, NADH) / Succinyl-CoA → Succinate (GTP) / Fumarate → Malate → OAA (regen, release FADH₂, NADH)
   - Persistent ids: "mito_outer" (ellipse), "mito_inner" (ellipse), and the cycle backbone: 8 "node_X" circles arranged in a circle each labelled with the substrate name. Arrows between nodes are paths with animate=flow.
   - Per-step: emphasise the current substrate node; show the released byproduct (CO₂, NADH, GTP, FADH₂) drifting outward via animate=drift.
   - Frame 5 takeaway: "Per acetyl-CoA: 3 NADH + 1 FADH₂ + 1 GTP + 2 CO₂"

4) "Op-amp inverting amplifier":
   - Phases: Op-amp idle / V_in applied / Virtual short ( V- = V+ = 0 ) / Current i = V_in/R_in flows through R_f / V_out = -i·R_f
   - Persistent ids: "opamp_triangle" (polygon), "v_minus_pin", "v_plus_pin", "ground", "r_in" (zigzag path), "r_f" (zigzag path), "v_in_label", "v_out_label", "current_arrow"
   - animate=flash on v_in_label, animate=flow on the wire path showing current direction.
   - Frame 5 takeaway: "V_out = -(R_f / R_in) · V_in"

5) "How a Java HashMap handles collisions":
   - Phases: Hash compute (h = key.hashCode()) / Bucket index (h & (n-1)) / Empty bucket — direct insert / Collision — append to linked-list chain / Tree-ify when chain length ≥ 8
   - Persistent ids: "key_node", "value_node", "hash_label", "bucket_array" (group of 8 rects in a row), "bucket_3" (the indexed bucket, emphasised), "chain_node_1", "chain_node_2", "tree_root"
   - Frame 1: key/value rects on left with arrow labelled "hashCode()" pointing to "hash_label" text. Frame 2: "h & (n-1)" formula text + an arrow from hash_label down into bucket_3. Frame 3: bucket_3 receives the entry rect; its 'next' pointer is null. Frame 4: a second entry collides — animate=flow arrow shows the new node being chained off bucket_3. Frame 5: chain length hits 8, the chain morphs into a tree node layout (rects connected in tree shape) with takeaway "put: O(1) avg, O(log n) tree-ified worst case".
   - animate=flash on hash_label in frame 1; animate=flow on the chain arrow in frame 4.

6) "CICS transaction lifecycle":
   - Phases: Terminal sends transid / TCT lookup finds program / Task dispatched on TCB with EIB / Program runs (DB2 / VSAM I/O) / SYNCPOINT commits + BMS map back to terminal
   - Persistent ids: "terminal_3270" (rect, left), "transid_label", "cics_region" (large rect, right), "tct_entry" (rect inside region), "tcb_block" (rect), "eib_block" (rect), "working_storage" (rect), "program_node" (rect), "db2_cylinder" (ellipse below), "syncpoint_marker", "request_arrow", "response_arrow"
   - Frame 1: terminal_3270 emphasised with text "TRAN: ORDR" + an animate=flow arrow leaving toward cics_region. Frame 2: tct_entry emphasised with text "ORDR → ORDPGM01". Frame 3: tcb_block + eib_block + working_storage appear inside the region, all newly created. Frame 4: program_node emphasised, animate=flow arrow to db2_cylinder labelled "EXEC SQL SELECT". Frame 5: syncpoint_marker pulses, response_arrow with animate=flow returns to terminal carrying a BMS map; takeaway rect: "CICS task = TCT entry + TCB + EIB + working storage; commit at SYNCPOINT".

7) "OAuth 2.0 authorization-code flow":
   - Phases: User clicks "Login with X" / Browser redirected to auth server with client_id + redirect_uri / User consents, code returned to redirect_uri / App exchanges code + secret for access_token / App calls resource server with Bearer token
   - Persistent ids: "user_browser" (rect, left), "client_app" (rect, mid-left), "auth_server" (rect, mid-right), "resource_server" (rect, right), "code_label", "token_label", "msg_arrow_1..5"
   - Each frame highlights ONE arrow with animate=flow + emphasize, and labels it with the actual HTTP message ("GET /authorize?client_id=…&redirect_uri=…", "302 redirect to /callback?code=abc", "POST /token  code=abc&secret=…", "200 { access_token: 'eyJ…' }", "GET /api/me  Authorization: Bearer eyJ…").
   - Frame 5 takeaway: "code (one-time, front-channel) → access_token (bearer, back-channel)".

Output the JSON. No explanation outside the JSON.`;

// Typed element shape — matches what the client renderer in
// app/student/visualizer/page.tsx expects. Loose-typed here because the
// JSON comes from an LLM and we sanitise field by field.
type ElType =
  | "circle" | "rect" | "ellipse" | "line" | "path" | "polygon" | "text" | "group";

type AnimatePreset = "spin" | "bob" | "drift" | "flash" | "wiggle" | "flow" | "orbit";

type Element = {
  id: string;
  type: ElType;
  // Geometry — only the relevant subset is used for each type.
  cx?: number; cy?: number; r?: number; rx?: number; ry?: number;
  x?: number; y?: number; width?: number; height?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  d?: string; points?: string; text?: string;
  // Optional KaTeX source — present on `text` elements that should render
  // as proper math typography. The plain `text` field stays as a fallback.
  latex?: string;
  // Common props
  fill?: string; stroke?: string; strokeWidth?: number; strokeDasharray?: string;
  opacity?: number; rotate?: number;
  fontSize?: number; fontWeight?: string;
  transform?: string;
  children?: Element[];
  // Visual chrome — renderer interprets these; AI may set them.
  shadow?: boolean;     // drop a soft shadow under the shape
  glow?: boolean;       // outer glow halo
  emphasize?: boolean;  // pulse loop on this element while frame is on screen
  animate?: AnimatePreset; // per-frame ambient motion preset
};

const ANIMATE_PRESETS = new Set<AnimatePreset>([
  "spin", "bob", "drift", "flash", "wiggle", "flow", "orbit",
]);

type Frame = {
  step_label: string;
  caption: string;
  duration_ms: number;
  elements: Element[];
};

const ALLOWED_TYPES = new Set<ElType>([
  "circle", "rect", "ellipse", "line", "path", "polygon", "text", "group",
]);

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)|none|currentColor|[a-zA-Z]+)$/;

function num(v: unknown, fallback?: number): number | undefined {
  const n = typeof v === "number" ? v : (v != null ? Number(v) : NaN);
  if (Number.isFinite(n)) return n as number;
  return fallback;
}

function safeStr(v: unknown, max = 200): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s.length ? s : undefined;
}

function cleanElement(raw: unknown, depth = 0): Element | null {
  if (!raw || typeof raw !== "object" || depth > 2) return null;
  const o = raw as Record<string, unknown>;
  const type = String(o.type || "").trim() as ElType;
  if (!ALLOWED_TYPES.has(type)) return null;
  const id = safeStr(o.id, 64);
  if (!id) return null;

  const el: Element = { id, type };

  // Geometry per type — drop fields that don't apply.
  if (type === "circle") {
    el.cx = num(o.cx); el.cy = num(o.cy); el.r = num(o.r);
  } else if (type === "rect") {
    el.x = num(o.x); el.y = num(o.y);
    el.width = num(o.width); el.height = num(o.height);
    if (num(o.rx) !== undefined) el.rx = num(o.rx);
    if (num(o.ry) !== undefined) el.ry = num(o.ry);
  } else if (type === "ellipse") {
    el.cx = num(o.cx); el.cy = num(o.cy);
    el.rx = num(o.rx); el.ry = num(o.ry);
  } else if (type === "line") {
    el.x1 = num(o.x1); el.y1 = num(o.y1);
    el.x2 = num(o.x2); el.y2 = num(o.y2);
  } else if (type === "path") {
    const d = safeStr(o.d, 1500);
    if (!d) return null;
    el.d = d.replace(/[<>{}]/g, "");
  } else if (type === "polygon") {
    const pts = safeStr(o.points, 1500);
    if (!pts) return null;
    el.points = pts.replace(/[<>{}]/g, "");
  } else if (type === "text") {
    el.x = num(o.x); el.y = num(o.y);
    const t = safeStr(o.text, 200);
    if (!t) return null;
    el.text = t;
    if (num(o.fontSize) !== undefined) el.fontSize = num(o.fontSize);
    const fw = safeStr(o.fontWeight, 16);
    if (fw && /^[0-9a-z]+$/i.test(fw)) el.fontWeight = fw;
    // Optional LaTeX source for math typesetting. KaTeX is rendered
    // inside a <foreignObject> on the client; we strip anything that
    // looks like an HTML / script injection vector here.
    const lx = safeStr(o.latex, 400);
    if (lx) el.latex = lx.replace(/[<>]/g, "");
  } else if (type === "group") {
    const kidsRaw = Array.isArray(o.children) ? (o.children as unknown[]) : [];
    el.children = kidsRaw
      .map((c) => cleanElement(c, depth + 1))
      .filter((c): c is Element => c !== null)
      .slice(0, 24);
    const tr = safeStr(o.transform, 200);
    if (tr) el.transform = tr.replace(/[<>{}]/g, "");
  }

  // Allow gradient syntax "color1->color2" in addition to plain colors. The
  // renderer turns this into an auto-generated <linearGradient>.
  const fill = safeFillOrGradient(o.fill);   if (fill) el.fill = fill;
  const stroke = safeFillOrGradient(o.stroke); if (stroke) el.stroke = stroke;
  if (num(o.strokeWidth) !== undefined) el.strokeWidth = num(o.strokeWidth);
  const sd = safeStr(o.strokeDasharray, 64);
  if (sd && /^[0-9.\s]+$/.test(sd)) el.strokeDasharray = sd;
  const op = num(o.opacity);
  if (op !== undefined) el.opacity = Math.max(0, Math.min(1, op));
  const rot = num(o.rotate);
  if (rot !== undefined) el.rotate = rot;
  if (o.shadow === true) el.shadow = true;
  if (o.glow === true) el.glow = true;
  if (o.emphasize === true) el.emphasize = true;
  if (typeof o.animate === "string" && ANIMATE_PRESETS.has(o.animate as AnimatePreset)) {
    el.animate = o.animate as AnimatePreset;
  }
  return el;
}

// "#10b981->#0ea5e9" is a 2-stop linear gradient; otherwise reuse safeColor.
function safeFillOrGradient(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (s.includes("->")) {
    const parts = s.split("->").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2 && parts.every((p) => COLOR_RE.test(p))) {
      return parts[0] + "->" + parts[1];
    }
    return undefined;
  }
  return COLOR_RE.test(s) ? s : undefined;
}

function cleanFrames(arr: unknown): Frame[] {
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[])
    .map((f) => {
      const o = (f || {}) as Record<string, unknown>;
      const elementsRaw = Array.isArray(o.elements) ? (o.elements as unknown[]) : [];
      const elements = elementsRaw
        .map((e) => cleanElement(e))
        .filter((e): e is Element => e !== null)
        .slice(0, 24);
      const caption = String(o.caption || "").trim().slice(0, 400);
      const stepLabel = String(o.step_label || "").trim().slice(0, 80) || `Step`;
      const dur = Math.max(2500, Math.min(8000, Math.round(Number(o.duration_ms) || 4500)));
      if (elements.length < 6 || !caption) return null;
      return {
        step_label: stepLabel,
        caption,
        duration_ms: dur,
        elements,
      };
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
    // Visualizer is expensive (two Gemini calls per request). Burst 3,
    // refill 6/hr, hard daily cap 15.
    const rate = checkRateLimit(user.id, "visualizer.create", { capacity: 3, refillPerHour: 6 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    const daily = checkDailyCap(user.id, "visualizer.create", 15);
    if (!daily.allowed) return NextResponse.json({ error: `Daily limit reached (${daily.limit}).`, code: "daily_cap" }, { status: 429 });

    // Server-side feature gate. Concept Visualizer is gated to top-tier
    // plans (Premium Plus / School Plus). The client-side dashboard tile
    // already locks-and-paywalls non-eligible users, but a determined user
    // could POST to this endpoint directly — so we enforce on the server
    // too. Returns a structured 403 the UI can show as an upgrade CTA.
    const gate = await requireFeature(user.id, "concept_visualizer");
    if (!gate.allowed) {
      return NextResponse.json(
        { error: (gate as unknown as { reason: string }).reason, code: "feature_locked", required_tier: (gate as unknown as { requiredTier: string | null }).requiredTier },
        { status: 403 },
      );
    }

    // Showcase-Free lifetime gate: one taste for Free users. Paid plans
    // short-circuit. Atomic claim — burns up-front; transient LLM
    // failure below does not refund.
    const ltGate = await consumeLifetimeUse(user.id, "visualizer");
    if (!ltGate.allowed) {
      return NextResponse.json(
        { error: ltGate.reason, code: "free_lifetime_used" },
        { status: 402 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const topic: string = String(body.topic || "").trim();
    if (topic.length < 3) {
      return NextResponse.json({ error: "Pick a topic (at least 3 characters)." }, { status: 400 });
    }
    if (topic.length > 200) {
      return NextResponse.json({ error: "Topic too long (max 200 chars)." }, { status: 400 });
    }

    // Soft profile bias — sent to the model as a one-line context hint
    // so ambiguous topics ("stack", "tree", "queue") are interpreted in
    // the right register: a Class-9 student gets a CS-curriculum stack
    // diagram, a Java trainee gets a JVM call-stack frame, a CAT
    // aspirant gets a logical-reasoning interpretation. Defaults to k12
    // when the client doesn't send a value.
    const rawProfile = typeof body.learner_profile === "string" ? body.learner_profile : "k12";
    const learnerProfile: "k12" | "competitive_exam" | "corporate" =
      rawProfile === "competitive_exam" || rawProfile === "corporate" ? rawProfile : "k12";

    const PROFILE_HINTS: Record<typeof learnerProfile, string> = {
      k12:
        "The learner is a school student (K-12). When the topic is ambiguous, " +
        "prefer the school-curriculum interpretation (biology, physics, chemistry, " +
        "basic math, simple electronics). Avoid jargon from professional software " +
        "engineering, enterprise mainframe, or business operations unless the topic " +
        "explicitly names them.",
      competitive_exam:
        "The learner is a competitive-exam aspirant (JEE / NEET / CAT / GATE / GRE / " +
        "UPSC etc.). Prefer rigorous, exam-style depth: numerical setups, full " +
        "derivations, named theorems, and the canonical takeaway formula. Avoid " +
        "professional software / mainframe / business interpretations unless the " +
        "topic explicitly names them.",
      corporate:
        "The learner is a working professional or trainee (Java / cloud / mainframe / " +
        "networking / certifications). When the topic is ambiguous, prefer the " +
        "professional interpretation: programming-language internals, system " +
        "architecture, mainframe (CICS / JCL / DB2), networking protocols, security " +
        "flows, or business processes — over a school-curriculum reading.",
    };
    const profileHint = PROFILE_HINTS[learnerProfile];

    // Granular exam-goal refinement — the 3-bucket learner_profile above
    // bins everyone into k12/competitive_exam/corporate, which loses the
    // signal between "Class-10 student" and "CAT aspirant" (both are
    // ambiguous-topic interpretations differ wildly). Layer on the
    // exam-goal context from profiles.exam_goal — if it's set, a CAT
    // student's "stack" diagram pitches differently from a JEE Main
    // student's "stack" diagram even though both are competitive_exam.
    // Falls through (empty prompt) when goal is "exploring" or unset.
    let goalRefinement = "";
    let contextAwareTopic = topic;
    try {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { loadLearningContext, buildExamAwareTopic } = await import("@/lib/learningContext");
      const admin = supabaseAdmin();
      const ctx = await loadLearningContext(admin, user.id);
      if (ctx.prompt) {
        goalRefinement = `\nExam refinement: ${ctx.prompt}`;
        contextAwareTopic = buildExamAwareTopic(topic, ctx);
      }
    } catch { /* non-fatal — bare profile hint still applies */ }

    const userPrompt =
      `Learner context: ${profileHint}${goalRefinement}\n\n` +
      `Topic: ${contextAwareTopic}\n\n` +
      `Produce the JSON now. 5 frames, typed elements, ids reused across frames for elements that should tween.`;
    // Prefer Gemini 2.5 Flash for keyframe layout. When configured, do a
    // two-pass pipeline:
    //   Stage A — plan the diagram in plain text. The model has to commit
    //             to phases, entities, ids, and the takeaway formula
    //             without the cognitive load of also producing JSON.
    //   Stage B — convert that plan to the typed-element JSON the
    //             renderer expects, with the plan in scope as context.
    // Plan-then-execute consistently outperforms one-shot JSON for spatial
    // reasoning. If anything in the Gemini path errors we fall back to a
    // single-pass Groq call so the feature still works.
    let raw: Record<string, unknown>;
    if (isGeminiConfigured()) {
      try {
        const planSystem = `You are a concept visualizer planning a 5-frame animation. The topic may be academic (physics, chemistry, biology, math) OR professional (programming, software architecture, mainframe / CICS / JCL, networking protocols, business processes). Produce a CONCISE plan in plain text (no JSON). For the given topic, output:

Domain: <mechanics | thermodynamics | electronics | optics | cell biology | organic chemistry | data structures | algebra | calculus | software-language-internals | software-architecture | mainframe-cics | mainframe-jcl | networking-protocol | concurrency | business-process | other>

Key formula, rule, or canonical signature: <the canonical equation, signature, or invariant — e.g. F=ma, η=1-T_c/T_h, HashMap.put O(1) avg, CICS task = TCT+TCB+EIB+WS commit at SYNCPOINT, OAuth: code → token>.

Frames (5 total — name each phase with the real domain term, not generic 'intro/middle/end'):
  Frame 1 [Phase name] — what's on screen, which entities (with semantic ids like piston, electron, succinate, op-amp_triangle), which element gets emphasised, which gets motion (spin/bob/drift/flash/wiggle/flow/orbit).
  Frame 2 [Phase name] — same shape.
  Frame 3 [Phase name] — same shape.
  Frame 4 [Phase name] — same shape.
  Frame 5 [Phase name] — must include a takeaway rect at y=420..460 carrying the formula.

Persistent ids (entities that exist in multiple frames and tween): <list>.

LaTeX equations: list each equation that should render with KaTeX, in raw LaTeX (e.g. V_{out} = -\\\\frac{R_f}{R_{in}} V_{in}).

Domain-specific elements to include: <axes / circuit symbols / molecule structures / FBD vectors / etc., named explicitly>.

Stay under 350 words. No JSON. No backticks.`;
        const plan = await geminiText(
          planSystem,
          `Learner context: ${profileHint}\n\nTopic: ${topic}`,
        );
        const stage2User =
          `Learner context: ${profileHint}\n\n` +
          `Topic: ${topic}\n\n` +
          `Diagram plan (use this as the spec — produce JSON that matches it):\n${plan}\n\n` +
          `Produce the JSON now. 5 frames, typed elements, ids reused across frames for elements that should tween. Honour the plan's persistent ids and emit the LaTeX equations on text elements via the latex field.`;
        raw = await geminiJSON(SYSTEM, stage2User);
      } catch (geminiErr) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[visualizer] Gemini failed, falling back to Groq:", geminiErr);
        }
        raw = await groqJSON(SYSTEM, userPrompt);
      }
    } else {
      raw = await groqJSON(SYSTEM, userPrompt);
    }

    const frames = cleanFrames((raw as { frames?: unknown }).frames);
    if (frames.length < 2) {
      return NextResponse.json(
        { error: "We couldn't build a clean animation for that topic. Try rephrasing." },
        { status: 502 }
      );
    }

    // Deterministic layout pass — snap to 8 px grid, clamp into the safe
    // canvas inset, push overlapping text labels away from nearby shapes.
    // The model handles 80% of layout via the tightened prompt; this fixer
    // catches the remaining drift / collisions so the output looks polished
    // every time, not just on a good roll.
    for (const f of frames) {
      f.elements = fixFrameLayout(f.elements as unknown as LayoutElement[]) as typeof f.elements;
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
