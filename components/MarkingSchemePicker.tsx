"use client";

/**
 * <MarkingSchemePicker />
 *
 * Reusable form control for picking a per-test marking scheme. Used by:
 *   - Teacher quiz builder            (/teacher/quizzes/new)
 *   - Teacher generate flow           (/teacher/generate)
 *   - Independent-student generate    (/student/generate)
 *
 * Renders three things:
 *   1. A preset dropdown (Practice / Boards / JEE Main / JEE Adv / NEET /
 *      CAT / Custom).
 *   2. A toggle "Apply negative marking" — when off, wrong-answer marks
 *      are forced to 0 regardless of preset.
 *   3. (When preset === "CUSTOM") three numeric inputs for correct /
 *      wrong / unattempted.
 *
 * Emits a MarkingScheme object on every change via `onChange`. The
 * parent typically persists it to `quizzes.marking_scheme`. A NULL
 * value is permitted both as initial state and output — null is
 * canonically equivalent to PRACTICE (+1/0/0).
 */

import { useEffect, useState } from "react";
import {
  SCORING_PRESETS,
  resolveRule,
  type ScoringPresetKey,
  type MarkingRule,
} from "@/lib/scoringPresets";
import type { MarkingScheme } from "@/lib/scoring";

export type MarkingSchemePickerProps = {
  /**
   * Currently-selected scheme. `null` means "use legacy default
   * (PRACTICE, no negatives)" — the picker renders that as PRACTICE
   * selected, negative toggle off.
   */
  value: MarkingScheme | null;
  onChange: (next: MarkingScheme) => void;
  /**
   * Auto-suggested preset (e.g., from the student's exam_goal). When
   * provided AND differs from the current selection AND the user
   * hasn't yet manually changed the picker, we render a one-line
   * banner: "Practising for JEE? Switch to JEE Main."
   */
  suggested?: ScoringPresetKey;
  /**
   * Disable the entire control. Used when the test is already live /
   * locked.
   */
  disabled?: boolean;
};

export default function MarkingSchemePicker(props: MarkingSchemePickerProps) {
  const { value, onChange, suggested, disabled } = props;

  // Local mirror for the "Custom" numeric inputs. We keep these as
  // strings so the user can type "−" and clear / retype freely without
  // the parsed value snapping back to 0 mid-keystroke.
  const initial = value
    ? value
    : ({
        preset: "PRACTICE" as ScoringPresetKey,
        negative_marks_enabled: false,
        rules: { default: { correct: 1, wrong: 0, unattempted: 0 } },
      } as MarkingScheme);

  const [preset, setPreset] = useState<ScoringPresetKey>(initial.preset);
  const [negEnabled, setNegEnabled] = useState<boolean>(initial.negative_marks_enabled);
  const [customCorrect, setCustomCorrect] = useState<string>(String(initial.rules.default.correct));
  const [customWrong, setCustomWrong] = useState<string>(String(initial.rules.default.wrong));
  const [customUnatt, setCustomUnatt] = useState<string>(String(initial.rules.default.unattempted));
  const [userTouched, setUserTouched] = useState<boolean>(false);

  // Recompute and emit the resolved scheme whenever any input changes.
  // Custom marks are clamped to a sane range — without this, a user
  // could set correct=+1000 / wrong=+99 and game any downstream
  // scoring or rank prediction. The server-side resolveScheme()
  // would still accept extreme numbers (Number.isFinite passes), so
  // the bounds belong here in the UI control.
  useEffect(() => {
    const custom: Partial<MarkingRule> =
      preset === "CUSTOM"
        ? {
            correct: clampMark(numOrFallback(customCorrect, 1), 0, 10),
            wrong: clampMark(numOrFallback(customWrong, 0), -10, 0),
            unattempted: clampMark(numOrFallback(customUnatt, 0), -5, 5),
          }
        : {};
    const resolved = resolveRule(preset, negEnabled, custom);
    const scheme: MarkingScheme = {
      preset,
      negative_marks_enabled: negEnabled,
      rules: { default: resolved },
    };
    onChange(scheme);
    // We intentionally exclude `onChange` from deps — parents typically
    // pass an inline function, which would trigger an infinite loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, negEnabled, customCorrect, customWrong, customUnatt]);

  // Surface a soft warning when a typed Custom value is being clamped
  // so the user understands why their input snapped.
  const customCorrectNum = numOrFallback(customCorrect, 1);
  const customWrongNum = numOrFallback(customWrong, 0);
  const customUnattNum = numOrFallback(customUnatt, 0);
  const customOutOfRange =
    preset === "CUSTOM" && (
      customCorrectNum < 0 || customCorrectNum > 10 ||
      (negEnabled && (customWrongNum < -10 || customWrongNum > 0)) ||
      customUnattNum < -5 || customUnattNum > 5
    );

  // When the operator picks a new preset, flip the negative-marks
  // toggle to that preset's canonical default (PRACTICE → off, JEE →
  // on). Operator can immediately override either way.
  function handlePresetChange(next: ScoringPresetKey) {
    setUserTouched(true);
    setPreset(next);
    if (next !== "CUSTOM") {
      setNegEnabled(SCORING_PRESETS[next].negative_default);
      // Reset the custom inputs to the new preset's numbers so a later
      // toggle to Custom doesn't show stale values.
      setCustomCorrect(String(SCORING_PRESETS[next].rule.correct));
      setCustomWrong(String(SCORING_PRESETS[next].rule.wrong));
      setCustomUnatt(String(SCORING_PRESETS[next].rule.unattempted));
    }
  }

  const showSuggestion =
    !!suggested &&
    suggested !== preset &&
    !userTouched &&
    suggested !== "PRACTICE";

  const rule = SCORING_PRESETS[preset].rule;
  const effectiveWrong = preset === "CUSTOM"
    ? (negEnabled ? numOrFallback(customWrong, 0) : 0)
    : (negEnabled ? rule.wrong : 0);
  const effectiveCorrect = preset === "CUSTOM"
    ? numOrFallback(customCorrect, 1)
    : rule.correct;
  const effectiveUnatt = preset === "CUSTOM"
    ? numOrFallback(customUnatt, 0)
    : rule.unattempted;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      {/* Suggestion banner — pre-empts the dropdown with a one-line
          recommendation tied to the student's exam_goal. */}
      {showSuggestion && (
        <div className="text-xs px-3 py-2 rounded-md bg-emerald-50 text-emerald-900 border border-emerald-200">
          <strong>Tip:</strong> Switch to <em>{SCORING_PRESETS[suggested!].label}</em> to
          match real-exam conditions.{" "}
          <button
            type="button"
            className="underline font-medium"
            onClick={() => handlePresetChange(suggested!)}
            disabled={disabled}
          >
            Use {SCORING_PRESETS[suggested!].label}
          </button>
        </div>
      )}

      <div>
        <label className="block text-sm font-semibold text-slate-800 mb-1">
          Marking scheme
        </label>
        <select
          className="select w-full"
          value={preset}
          onChange={(e) => handlePresetChange(e.target.value as ScoringPresetKey)}
          disabled={disabled}
        >
          {Object.values(SCORING_PRESETS).map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
        <p className="text-[11px] text-slate-500 mt-1">{SCORING_PRESETS[preset].description}</p>
      </div>

      {/* Negative marking toggle — applies for every preset except CUSTOM,
          where it gates the `wrong` numeric input below. */}
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={negEnabled}
          onChange={(e) => { setUserTouched(true); setNegEnabled(e.target.checked); }}
          disabled={disabled}
          className="mt-0.5"
        />
        <div>
          <div className="text-sm font-medium text-slate-800">Apply negative marking</div>
          <div className="text-[11px] text-slate-500">
            When on, wrong answers deduct marks. When off, wrong answers earn 0
            regardless of the preset.
          </div>
        </div>
      </label>

      {/* Custom inputs — visible only when preset === "CUSTOM". */}
      {preset === "CUSTOM" && (
        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-100">
          <div>
            <label className="text-xs font-medium text-slate-700">Correct (+)</label>
            <input
              className="input w-full"
              type="number"
              step="0.25"
              value={customCorrect}
              onChange={(e) => { setUserTouched(true); setCustomCorrect(e.target.value); }}
              disabled={disabled}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-700">
              Wrong {negEnabled ? "(−)" : "(disabled)"}
            </label>
            <input
              className="input w-full"
              type="number"
              step="0.25"
              value={customWrong}
              onChange={(e) => { setUserTouched(true); setCustomWrong(e.target.value); }}
              disabled={disabled || !negEnabled}
              title={!negEnabled ? "Turn on \"Apply negative marking\" to use this." : undefined}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-700">Unattempted</label>
            <input
              className="input w-full"
              type="number"
              step="0.25"
              value={customUnatt}
              onChange={(e) => { setUserTouched(true); setCustomUnatt(e.target.value); }}
              disabled={disabled}
            />
          </div>
        </div>
      )}

      {customOutOfRange && (
        <div className="text-[11px] px-2 py-1 rounded-md bg-amber-50 text-amber-900 border border-amber-200">
          Out-of-range values are clamped (correct 0&ndash;10, wrong &minus;10&ndash;0, skip &minus;5&ndash;5).
        </div>
      )}

      {/* Effective rule preview — always visible so the picker is never
          ambiguous about what will actually be applied. */}
      <div className="grid grid-cols-3 gap-2 text-xs text-slate-700 bg-slate-50 rounded-md p-2 mt-2">
        <div>
          <span className="text-slate-500">Correct:</span>{" "}
          <strong className="text-emerald-700">+{effectiveCorrect}</strong>
        </div>
        <div>
          <span className="text-slate-500">Wrong:</span>{" "}
          <strong className={effectiveWrong < 0 ? "text-red-700" : "text-slate-700"}>
            {effectiveWrong > 0 ? "+" : ""}{effectiveWrong}
          </strong>
        </div>
        <div>
          <span className="text-slate-500">Skip:</span>{" "}
          <strong className="text-slate-700">{effectiveUnatt}</strong>
        </div>
      </div>
    </div>
  );
}

function numOrFallback(s: string, fallback: number): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function clampMark(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  // Round to nearest 0.25 to match the picker step.
  return Math.round(n * 4) / 4;
}
