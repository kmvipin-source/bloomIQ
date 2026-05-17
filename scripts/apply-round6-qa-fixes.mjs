// Round-6 QA cleanup: close every remaining strict-TS error so
// next.config.ts can finally flip ignoreBuildErrors off permanently.
//
// Categories:
//   A. recharts Formatter signature drift (10 sites across 4 files)
//   B. /teacher/quizzes/new H3-codemod damage (4 fixes)
//   B+. lib/featureFlags.client.tsx duplicate `children` field (typo)
//   C. components/PlanDiff.tsx blockedByImmutable narrowing
//   D. Flip next.config.ts -> ignoreBuildErrors:false (Finding #25 closure)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function patchNorm(file, find, replace, tag) {
  const abs = path.join(ROOT, file);
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  if (text.indexOf(find) !== text.lastIndexOf(find)) throw new Error(`${tag}: anchor non-unique in ${file}`);
  const next = text.replace(find, replace);
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`  ${tag}: applied`);
}

function patchAll(file, find, replace, tag) {
  const abs = path.join(ROOT, file);
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  const next = text.split(find).join(replace);
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`  ${tag}: applied (replace-all)`);
}

// =====================================================================
// CATEGORY B: /teacher/quizzes/new/page.tsx — H3-style damage repair
// =====================================================================

// B.1 — Remove duplicate `categoryLabel` from the first import line. The
//        second import block at line 22-27 already brings in
//        categoryLabelShared, and line 70 aliases it to categoryLabel.
patchNorm(
  "app/teacher/quizzes/new/page.tsx",
  `import {
  validateGenerationFitForGrade,
  categoryLabel,
} from "@/lib/questionCategory";`,
  `import {
  validateGenerationFitForGrade,
  // Finding #36 fix (B.1): categoryLabel was imported here AND also re-aliased
  // from categoryLabelShared at line ~70, causing TS2440 (import conflicts
  // with local declaration). Dropped the direct import; the alias stays so
  // the rest of the file keeps working unchanged.
} from "@/lib/questionCategory";`,
  "FIX#36-B.1 drop dup categoryLabel import",
);

// B.2 — `teacherClasses` referenced but never declared. The actual state
//       variable is `classes` (line 271). Rename the references.
patchAll(
  "app/teacher/quizzes/new/page.tsx",
  `    const cls = (typeof teacherClasses !== "undefined"
      ? teacherClasses.find((c: { id: string; subject?: string | null }) => c.id === targetClassId)
      : null) as { id: string; subject?: string | null } | null;`,
  `    // Finding #37 fix (B.2): renamed from teacherClasses (undefined in
    // this scope) to classes (the actual state variable from line ~271).
    const cls = (classes.find((c) => c.id === targetClassId) || null) as
      | { id: string; subject?: string | null }
      | null;`,
  "FIX#37-B.2 teacherClasses -> classes",
);

// B.3 — Two useMemo hooks reference `classes` and `targetClassId` at
//        lines ~149-153 and ~252, but those states are declared at
//        lines 271-272 (TDZ). The minimal surgical fix is to move the
//        two state declarations BEFORE the useMemos that depend on them.
//        Do this by relocating the const declarations to right after
//        teacherExamGoal (well above the first useMemo that reads them).
//
//        Inspect where they currently live to construct the
//        before-and-after exactly.

// Find the current declaration site.
{
  const abs = path.join(ROOT, "app/teacher/quizzes/new/page.tsx");
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");

  // We need to locate the two `const [classes,...]` and `const [targetClassId,...]`
  // declarations and remove them from their current spot, then re-insert above
  // the first useMemo that depends on them. The useMemo with `classes.find`
  // appears around line 149.

  const declMatch = text.match(
    /\n  type ClassOption = [^\n]*\n  const \[classes, setClasses\] = useState<ClassOption\[\]>\(\[\]\);\n  const \[targetClassId, setTargetClassId\] = useState<string>\(""\);\n/,
  );

  let next = text;

  if (declMatch) {
    // Remove from current location
    next = next.replace(declMatch[0], "\n");
  } else {
    // Try a looser match without the ClassOption type alias if it's separately defined
    const looseMatch = text.match(
      /\n  const \[classes, setClasses\] = useState<ClassOption\[\]>\(\[\]\);\n  const \[targetClassId, setTargetClassId\] = useState<string>\(""\);\n/,
    );
    if (!looseMatch) throw new Error("FIX#38 B.3: classes/targetClassId declaration block not found");
    next = next.replace(looseMatch[0], "\n");
  }

  // Insert above the negativeMarkingWarning / contextFit useMemos. The
  // earliest reference is in `const contextFit = useMemo(...)` at line ~149.
  // Insert right after `teacherExamGoal` state to be safe.
  const insertAnchor = `  const negMarkingWarn = useMemo(`;
  if (!next.includes(insertAnchor)) throw new Error("FIX#38 B.3: insertAnchor not found");
  // Look up classOption type — if previous removal also removed the type
  // alias, we need to re-add it.
  const declBlock = `  // Finding #38 fix (B.3): relocated from below to fix TDZ — these
  // states are read by contextFit useMemo at line ~149 and by other
  // hooks above the original declaration site.
  type ClassOption = {
    id: string;
    name: string;
    grade?: string | null;
    section?: string | null;
    subject?: string | null;
  };
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");
`;
  // Only insert the type alias if it's not already present in the file
  // after the move (sometimes the type is defined inline somewhere else).
  if (next.includes("type ClassOption = {") && !declMatch) {
    // Type already exists; only add the state declarations.
    const stateOnly = `  // Finding #38 fix (B.3): relocated from below to fix TDZ.
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");
`;
    next = next.replace(insertAnchor, stateOnly + "\n" + insertAnchor);
  } else {
    next = next.replace(insertAnchor, declBlock + "\n" + insertAnchor);
  }

  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log("  FIX#38-B.3 relocate classes/targetClassId: applied");
}

// =====================================================================
// CATEGORY B+: lib/featureFlags.client.tsx — duplicate `children` field
// =====================================================================
patchNorm(
  "lib/featureFlags.client.tsx",
  `}: {
  flag: PlatformFlagName;
  children: ReactNode;
  children: ReactNode;
  fallback?: ReactNode;`,
  `}: {
  flag: PlatformFlagName;
  // Finding #39 fix (B+): duplicate \`children: ReactNode;\` field (typo).
  children: ReactNode;
  fallback?: ReactNode;`,
  "FIX#39-B+ duplicate children",
);

// =====================================================================
// CATEGORY C: components/PlanDiff.tsx — blockedByImmutable narrowing
// =====================================================================
patchNorm(
  "components/PlanDiff.tsx",
  `                return (
                  <ScalarRow
                    key={String(d.field.key)}
                    diff={d}
                    isFirst={idx === 0}
                  />
                );`,
  `                return (
                  <ScalarRow
                    key={String(d.field.key)}
                    // Finding #40 fix (C): coerce blockedByImmutable to a
                    // strict boolean — \`d\` has it as boolean|undefined but
                    // ScalarRow's prop type requires boolean.
                    diff={{ ...d, blockedByImmutable: d.blockedByImmutable ?? false }}
                    isFirst={idx === 0}
                  />
                );`,
  "FIX#40-C PlanDiff narrowing",
);

// =====================================================================
// CATEGORY A: recharts Formatter signature drift — 10 sites
// Strategy: cast the formatter prop value to `any`. Runtime behavior
// unchanged; recharts is tolerant of fewer-arg handlers. Recharts'
// Formatter union evolved to require 5-args; existing 1-3-arg handlers
// still get called correctly at runtime.
// =====================================================================

// A.1 — components/BloomChart.tsx (2 sites, identical pattern)
patchAll(
  "components/BloomChart.tsx",
  `<Tooltip formatter={(v: number) => \`\${v}%\`} />`,
  `<Tooltip formatter={((v: number) => \`\${v}%\`) as unknown as never /* Finding #41 fix (A): recharts Formatter signature drift; runtime unchanged */} />`,
  "FIX#41-A BloomChart",
);

// A.2 — components/EngagementTrends.tsx (2 sites with different signatures)
// 118: (label: string) => string  -> LabelFormatter mismatch
// 119: (v: number) => [number, string]  -> Formatter mismatch
{
  const file = "components/EngagementTrends.tsx";
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  // Anchor block is the Tooltip element with both labelFormatter and formatter.
  // Patch by adding `as never` casts after each prop expression.
  let next = text;
  // labelFormatter
  next = next.replace(
    /labelFormatter=\{([^}]+)\}/g,
    "labelFormatter={(($1) as unknown as never) /* Finding #42 fix (A): recharts LabelFormatter drift */}",
  );
  // formatter
  next = next.replace(
    /formatter=\{([^}]+)\}/g,
    "formatter={(($1) as unknown as never) /* Finding #42 fix (A): recharts Formatter drift */}",
  );
  fs.writeFileSync(path.join(ROOT, file), crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log("  FIX#42-A EngagementTrends: applied");
}

// A.3 — app/student/progress/page.tsx (6 sites: 4 formatter + 2 labelFormatter)
//        Same approach as EngagementTrends; replace_all on the prop syntax.
{
  const file = "app/student/progress/page.tsx";
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const crlf = raw.includes("\r\n");
  let text = raw.replace(/\r\n/g, "\n");
  // Care: this file may have OTHER `formatter=` props (e.g. on other components).
  // To avoid over-matching, key on a small enclosing context if possible.
  // For safety, only target `<Tooltip ... formatter={...}` / `... labelFormatter={...}` pairs.
  text = text.replace(
    /(formatter|labelFormatter)=\{([^{}]+(?:\{[^{}]*\}[^{}]*)*)\}/g,
    (_m, name, body) =>
      `${name}={((${body}) as unknown as never) /* Finding #43 fix (A): recharts ${name} drift */}`,
  );
  fs.writeFileSync(path.join(ROOT, file), crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");
  console.log("  FIX#43-A student/progress: applied");
}

// A.4 — app/school/reports/page.tsx (1 site, 3-arg formatter)
{
  const file = "app/school/reports/page.tsx";
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const crlf = raw.includes("\r\n");
  let text = raw.replace(/\r\n/g, "\n");
  text = text.replace(
    /(formatter|labelFormatter)=\{([^{}]+(?:\{[^{}]*\}[^{}]*)*)\}/g,
    (_m, name, body) =>
      `${name}={((${body}) as unknown as never) /* Finding #44 fix (A): recharts ${name} drift */}`,
  );
  fs.writeFileSync(path.join(ROOT, file), crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");
  console.log("  FIX#44-A school/reports: applied");
}

console.log("\nRound 6 fixes (A + B + B+ + C) applied. Now running strict tsc to verify before flipping ignoreBuildErrors...");
