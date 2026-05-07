// =============================================================================
// Visualizer post-processing layout fixer.
// =============================================================================
// The LLM emits decent keyframes but routinely violates two layout rules:
//   1. Hero elements drift past the canvas margin.
//   2. Text labels sit on top of nearby shapes (the "label tucked under the
//      arrow" problem).
// Fixing this in prompt-only never quite lands — every other generation
// regresses. So we do a deterministic pass over each frame's elements:
//   - clamp coordinates to a safe inset of the 800x480 canvas
//   - snap to an 8 px grid for alignment
//   - resolve text-vs-shape overlaps by pushing the text along the shorter
//     axis until it clears
// All edits preserve element ids so cross-frame tweening is unaffected.
// =============================================================================

export type LayoutElement = {
  id: string;
  type: "circle" | "rect" | "ellipse" | "line" | "path" | "polygon" | "text" | "group";
  cx?: number; cy?: number; r?: number; rx?: number; ry?: number;
  x?: number; y?: number; width?: number; height?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  d?: string; points?: string; text?: string; latex?: string;
  fill?: string; stroke?: string; strokeWidth?: number; strokeDasharray?: string;
  opacity?: number; rotate?: number;
  fontSize?: number; fontWeight?: string;
  transform?: string;
  children?: LayoutElement[];
  shadow?: boolean; glow?: boolean; emphasize?: boolean;
  animate?: "spin" | "bob" | "drift" | "flash" | "wiggle" | "flow" | "orbit";
};

const VIEW_W = 800;
const VIEW_H = 480;
const MARGIN = 40;
const GRID = 8;

const snap = (n: number) => Math.round(n / GRID) * GRID;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type AABB = { x1: number; y1: number; x2: number; y2: number };

// Approximate text bounding box. SVG text width depends on font; we use a
// conservative monospace-ish approximation that errs slightly large so the
// nudge has room.
function textAabb(el: LayoutElement): AABB {
  const fontSize = el.fontSize ?? 14;
  // Empirical for 600-weight sans-serif at 14px: ~0.55 em average.
  const w = (el.text?.length || 0) * fontSize * 0.55;
  const h = fontSize * 1.2;
  const x = el.x ?? 0;
  const yBaseline = el.y ?? 0;
  // SVG text y is the baseline; the visual top is roughly y - fontSize.
  return { x1: x, y1: yBaseline - fontSize, x2: x + w, y2: yBaseline + h * 0.2 };
}

function shapeAabb(el: LayoutElement): AABB | null {
  switch (el.type) {
    case "circle": {
      const cx = el.cx ?? 0, cy = el.cy ?? 0, r = el.r ?? 0;
      return { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r };
    }
    case "rect": {
      const x = el.x ?? 0, y = el.y ?? 0;
      const w = el.width ?? 0, h = el.height ?? 0;
      return { x1: x, y1: y, x2: x + w, y2: y + h };
    }
    case "ellipse": {
      const cx = el.cx ?? 0, cy = el.cy ?? 0;
      const rx = el.rx ?? 0, ry = el.ry ?? 0;
      return { x1: cx - rx, y1: cy - ry, x2: cx + rx, y2: cy + ry };
    }
    case "line": {
      const x1 = el.x1 ?? 0, y1 = el.y1 ?? 0;
      const x2 = el.x2 ?? 0, y2 = el.y2 ?? 0;
      return {
        x1: Math.min(x1, x2), y1: Math.min(y1, y2),
        x2: Math.max(x1, x2), y2: Math.max(y1, y2),
      };
    }
    default:
      return null;
  }
}

function aabbOverlap(a: AABB, b: AABB): boolean {
  return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
}

// Push the text element's (x,y) along the shorter overlap axis until the
// boxes no longer collide. Bounded by a max delta so a runaway nudge can't
// throw the label across the canvas.
function nudgeTextOut(text: LayoutElement, obstacle: AABB) {
  const t = textAabb(text);
  if (!aabbOverlap(t, obstacle)) return;
  const overlapX = Math.min(t.x2 - obstacle.x1, obstacle.x2 - t.x1);
  const overlapY = Math.min(t.y2 - obstacle.y1, obstacle.y2 - t.y1);
  if (overlapX < overlapY) {
    // Shift horizontally toward the side that needs less travel.
    const center = (t.x1 + t.x2) / 2;
    const obsCenter = (obstacle.x1 + obstacle.x2) / 2;
    const sign = center < obsCenter ? -1 : 1;
    const dx = sign * (overlapX + 6);
    text.x = Math.max(8, Math.min(VIEW_W - 8, (text.x ?? 0) + dx));
  } else {
    const center = (t.y1 + t.y2) / 2;
    const obsCenter = (obstacle.y1 + obstacle.y2) / 2;
    const sign = center < obsCenter ? -1 : 1;
    const dy = sign * (overlapY + 6);
    text.y = Math.max(16, Math.min(VIEW_H - 8, (text.y ?? 0) + dy));
  }
}

function clampElement(el: LayoutElement) {
  switch (el.type) {
    case "circle":
    case "ellipse": {
      if (el.cx != null) el.cx = snap(clamp(el.cx, MARGIN, VIEW_W - MARGIN));
      if (el.cy != null) el.cy = snap(clamp(el.cy, MARGIN, VIEW_H - MARGIN));
      break;
    }
    case "rect": {
      if (el.x != null) el.x = snap(clamp(el.x, MARGIN, VIEW_W - MARGIN));
      if (el.y != null) el.y = snap(clamp(el.y, MARGIN, VIEW_H - MARGIN));
      if (el.width != null) el.width = Math.max(8, Math.min(VIEW_W - 2 * MARGIN, el.width));
      if (el.height != null) el.height = Math.max(8, Math.min(VIEW_H - 2 * MARGIN, el.height));
      break;
    }
    case "line": {
      if (el.x1 != null) el.x1 = snap(clamp(el.x1, MARGIN / 2, VIEW_W - MARGIN / 2));
      if (el.y1 != null) el.y1 = snap(clamp(el.y1, MARGIN / 2, VIEW_H - MARGIN / 2));
      if (el.x2 != null) el.x2 = snap(clamp(el.x2, MARGIN / 2, VIEW_W - MARGIN / 2));
      if (el.y2 != null) el.y2 = snap(clamp(el.y2, MARGIN / 2, VIEW_H - MARGIN / 2));
      break;
    }
    case "text": {
      // Text x/y don't snap to the same coarse grid (legibility wins over
      // alignment for labels). We only clamp into the canvas.
      if (el.x != null) el.x = clamp(el.x, 8, VIEW_W - 8);
      if (el.y != null) el.y = clamp(el.y, 16, VIEW_H - 8);
      break;
    }
    case "group": {
      (el.children || []).forEach(clampElement);
      break;
    }
    default:
      // path / polygon — leave coordinates alone, they're encoded in
      // strings and the renderer trusts them.
      break;
  }
}

/**
 * Run the deterministic layout fixer over a frame's element list.
 * - Each element is clamped to the safe inset of the 800x480 canvas and
 *   snapped to the 8-px grid.
 * - Text elements that overlap a nearby shape get nudged along the shorter
 *   collision axis. Up to N rounds; bounded so an irresolvable cluster
 *   doesn't loop.
 */
export function fixFrameLayout(elements: LayoutElement[]): LayoutElement[] {
  // Pass 1: clamp + grid-snap every element in place.
  for (const el of elements) clampElement(el);

  // Pass 2: build shape AABBs once, then nudge each text element away from
  // every shape it currently overlaps. We limit text-vs-text moves — the
  // model usually handles label spacing within a cluster well enough.
  const obstacles: AABB[] = [];
  for (const el of elements) {
    if (el.type === "text") continue;
    const a = shapeAabb(el);
    if (a) obstacles.push(a);
  }

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const el of elements) {
      if (el.type !== "text") continue;
      for (const ob of obstacles) {
        const before = textAabb(el);
        nudgeTextOut(el, ob);
        const after = textAabb(el);
        if (after.x1 !== before.x1 || after.y1 !== before.y1) {
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  return elements;
}
