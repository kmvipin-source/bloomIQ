// scripts/apply-teaching-context-r6-per-bloom-counts.mjs
// =============================================================================
// Per-Bloom-level question counts on /teacher/generate (matches independent
// student form's flexibility). In custom Bloom mode, teacher can override
// the default `perLevel` value for individual Bloom levels.
//
// Adds:
//   - perLevelCustom state: Partial<Record<BloomLevel, number>>
//   - Per-level inputs grid (only in custom mode, only for picked levels)
//   - totalQs calc factors per-level overrides
//   - API body includes perLevelCounts when any override is set
//
// Idempotent. Run:  node scripts/apply-teaching-context-r6-per-bloom-counts.mjs
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. STATE: perLevelCustom ─────────────────────────────────────────
  {
    tag: "state_perLevelCustom",
    file: "app/teacher/generate/page.tsx",
    description: "Add per-level override state",
    find: `  const [perLevel, setPerLevel] = useState(2);`,
    replace: `  const [perLevel, setPerLevel] = useState(2);
  // Per-Bloom override map (custom mode only). When a level has a number here,
  // it overrides the default \`perLevel\` for that level. Empty = use perLevel
  // uniformly. Resets when picked levels change so stale overrides don't bleed.
  const [perLevelCustom, setPerLevelCustom] = useState<Partial<Record<BloomLevel, number>>>({});`,
  },

  // ─── 2. RESET perLevelCustom when pickedLevels changes ─────────────────
  // Avoid stale overrides when teacher removes a level from the picker.
  {
    tag: "reset_perLevelCustom",
    file: "app/teacher/generate/page.tsx",
    description: "Reset overrides when picked levels change",
    find: `  function togglePickedLevel(l: BloomLevel) {`,
    replace: `  // Drop overrides for levels that are no longer in pickedLevels, so a
  // level the teacher de-selected then re-selected starts fresh at perLevel.
  useEffect(() => {
    setPerLevelCustom((prev) => {
      const next: Partial<Record<BloomLevel, number>> = {};
      for (const lv of pickedLevels) {
        if (prev[lv] !== undefined) next[lv] = prev[lv];
      }
      return next;
    });
  }, [pickedLevels]);

  function togglePickedLevel(l: BloomLevel) {`,
  },

  // ─── 3. PER-LEVEL INPUTS UI (custom mode, after Bloom chips) ─────────
  {
    tag: "per_level_inputs_ui",
    file: "app/teacher/generate/page.tsx",
    description: "Insert per-level input grid below the Bloom chip picker",
    find: `              <p className="text-xs muted mt-2">
                {pickedLevels.length} of {MAX_PICKED} selected
                {pickedLevels.length === 0 ? " — pick at least one." : ""}
              </p>
            </>
          )}`,
    replace: `              <p className="text-xs muted mt-2">
                {pickedLevels.length} of {MAX_PICKED} selected
                {pickedLevels.length === 0 ? " — pick at least one." : ""}
              </p>
              {pickedLevels.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-700">Questions per level (override)</span>
                    <span className="text-[11px] muted">Default {perLevel} each — leave blank to use default</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {pickedLevels.map((lv) => (
                      <div key={lv} className="flex items-center gap-2 bg-slate-50 rounded-md px-2 py-1.5 border border-slate-200">
                        <span className={\`badge badge-\${lv} text-[10px]\`}>{BLOOM_META[lv].label}</span>
                        <input
                          type="number"
                          min={0}
                          max={25}
                          className="input input-sm w-14 ml-auto text-sm"
                          placeholder={String(perLevel)}
                          value={perLevelCustom[lv] ?? ""}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setPerLevelCustom((prev) => {
                              const next = { ...prev };
                              if (raw === "") delete next[lv];
                              else next[lv] = Math.max(0, Math.min(25, Number(raw) || 0));
                              return next;
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}`,
  },

  // ─── 4. TOTAL Qs CALC inside the pre-flight IIFE ─────────────────────
  // Replace `effectiveLevels.length * perLevel` with a sum that factors in
  // perLevelCustom overrides when in custom mode.
  {
    tag: "totalQs_with_overrides",
    file: "app/teacher/generate/page.tsx",
    description: "Sum per-level counts (override or default) for totalQs",
    find: `          const effectiveLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
          const totalQs = effectiveLevels.length * perLevel;`,
    replace: `          const effectiveLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
          // totalQs honors per-level overrides in custom mode; in "all" mode
          // overrides don't apply (uniform perLevel everywhere).
          const totalQs = mode === "custom"
            ? pickedLevels.reduce((s, lv) => s + (perLevelCustom[lv] ?? perLevel), 0)
            : effectiveLevels.length * perLevel;`,
  },

  // ─── 5. API BODY — send perLevelCounts when any override exists ──────
  {
    tag: "api_body_perLevelCounts",
    file: "app/teacher/generate/page.tsx",
    description: "Include perLevelCounts in API body when overrides exist",
    find: `      const body: Record<string, unknown> = {
        source,
        topic,
        levels: mode === "all" ? BLOOM_LEVELS : pickedLevels,
        perLevel,
        numericalPercent,`,
    replace: `      // Build perLevelCounts when teacher set any overrides. API merges
      // this with the default perLevel for missing keys (see /api/generate
      // route). Empty object = no overrides, API uses perLevel uniformly.
      const _perLevelCounts: Record<string, number> = {};
      if (mode === "custom") {
        for (const lv of pickedLevels) {
          if (perLevelCustom[lv] !== undefined) _perLevelCounts[lv] = perLevelCustom[lv] as number;
        }
      }
      const body: Record<string, unknown> = {
        source,
        topic,
        levels: mode === "all" ? BLOOM_LEVELS : pickedLevels,
        perLevel,
        ...(Object.keys(_perLevelCounts).length > 0 ? { perLevelCounts: _perLevelCounts } : {}),
        numericalPercent,`,
  },
];

const applied = [];
const skipped = [];
for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) {
    skipped.push({ tag: fx.tag, reason: `file not found: ${fx.file}` });
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not present (already applied?)" });
    continue;
  }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not unique - cowardly refusing" });
    continue;
  }
  fs.writeFileSync(abs, before.replace(fx.find, fx.replace), "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== r6 (per-Bloom-level counts) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
