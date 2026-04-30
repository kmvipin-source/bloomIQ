"use client";

import Link from "next/link";
import {
  GraduationCap, Search, ScanSearch, CalendarDays, Timer, Crosshair,
  Trophy, Bot, Film, Brain, Gauge, Mic, Network, Users, Lock,
} from "lucide-react";
import type { TileMeta } from "@/lib/studentGoalTiles";

/**
 * StudentFeatureTile
 *
 * Renders a single feature card on the independent-student dashboard.
 * Reads its presentation from `lib/studentGoalTiles.ts` so the dashboard
 * is fully data-driven.
 *
 * Lock-aware: when `locked` is true, the card renders dimmed with a Lock
 * icon and a tier badge ("Premium" / "Premium Plus"), and on click calls
 * `onLockedClick` instead of navigating. This implements the visibility-
 * but-not-usability pattern from the 2026-04-30 strategy session: free
 * users SEE every feature so they know what they're missing, and clicking
 * a locked tile opens a paywall modal instead of letting them in.
 */

const ICON_MAP = {
  GraduationCap, Search, ScanSearch, CalendarDays, Timer, Crosshair,
  Trophy, Bot, Film, Brain, Gauge, Mic, Network, Users,
} as const;

export default function StudentFeatureTile({
  meta,
  fullWidth = false,
  locked = false,
  lockedTierLabel,
  onLockedClick,
}: {
  meta: TileMeta;
  // Sprint tile spans two columns on the dashboard; opt in via this prop.
  fullWidth?: boolean;
  // True when the user's current plan does NOT include this tile's feature.
  locked?: boolean;
  // Display name of the tier that unlocks this tile (e.g. "Premium").
  lockedTierLabel?: string;
  // Called instead of navigating when locked. Parent should open paywall.
  onLockedClick?: (featureKey: string | undefined) => void;
}) {
  const Icon = ICON_MAP[meta.iconName];
  const baseClass = "card card-hover flex items-start gap-3 relative";
  const span = fullWidth ? "sm:col-span-2" : "";
  const highlight = !locked && meta.highlight ? "border-emerald-200 bg-emerald-50/30" : "";
  const lockedClass = locked
    ? "opacity-70 cursor-pointer hover:opacity-90 transition"
    : "";

  const inner = (
    <>
      <div className={`rounded-lg ${meta.color.bg} ${meta.color.fg} p-2 shrink-0 ${locked ? "opacity-70" : ""}`}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold flex items-center gap-2 flex-wrap">
          <span>{meta.label}</span>
          {locked && lockedTierLabel && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold text-amber-800 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
              <Lock size={10} /> {lockedTierLabel}
            </span>
          )}
        </div>
        <div className="text-xs muted mt-1">{meta.description}</div>
      </div>
    </>
  );

  if (locked) {
    return (
      <button
        type="button"
        onClick={() => onLockedClick?.(meta.featureKey)}
        className={`${baseClass} ${span} ${lockedClass} text-left w-full`}
        aria-label={`${meta.label} (locked)`}
      >
        {inner}
      </button>
    );
  }

  return (
    <Link href={meta.href} className={`${baseClass} ${span} ${highlight}`.trim()}>
      {inner}
    </Link>
  );
}
