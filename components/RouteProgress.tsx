"use client";

// Route progress bar — slim accent-coloured bar pinned to the top of
// the viewport that animates whenever the user clicks a Link / nav
// item. Solves the long-running "I clicked but nothing happened" UX
// complaint that led to double-click frustration.
//
// Why this exists:
//   In dev mode Next.js compiles routes on demand. The first click on
//   a route bundle that isn't compiled yet has no immediate visual
//   feedback — the URL flips but the new page can take 1–3 seconds to
//   appear. Users assumed the click was lost and clicked again. The
//   second click sometimes raced compilation in a way that LOOKED like
//   "every link needs two clicks".
//
//   In production the same blank-time can happen on slow connections
//   when the route bundle is fetched over the wire.
//
//   This bar fires the instant a Link is intercepted by Next.js' router
//   (we listen to pathname changes via usePathname). It animates
//   forward on a fixed schedule — fast at first, then slowing — so the
//   user always sees motion. When the new route's children render and
//   the pathname is stable for a frame, we fade the bar out.
//
// No npm dependency: NProgress and similar pull in a wad of CSS we'd
// have to override. A 60-line component does the job.

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function RouteProgress() {
  const pathname = usePathname();
  // Width of the bar, 0–100. We animate via setState rather than CSS
  // keyframes so we can stop / resume on URL change without restarting.
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Don't fire on initial mount — the user didn't click anything yet.
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    // Cancel any previous animation and start fresh — covers the case
    // where the user clicks a second link before the first transition
    // completes.
    if (tickRef.current) clearInterval(tickRef.current);
    if (hideRef.current) clearTimeout(hideRef.current);
    setVisible(true);
    setWidth(8);

    // Ease toward 90% but never get there — the final 10% is reserved
    // for the "render finished" signal below. Decay rate slows as we
    // get higher so the bar looks like it's working hard but stalled,
    // not finished.
    tickRef.current = setInterval(() => {
      setWidth((w) => {
        if (w >= 90) return w;
        const remaining = 90 - w;
        return w + Math.max(0.5, remaining * 0.08);
      });
    }, 100);

    // After a paint, assume the new route is rendered. Snap to 100,
    // then fade out. usePathname updates synchronously when the URL
    // changes; the children below us re-render after that. requestAnimation-
    // Frame nests two frames so we land squarely after the children paint.
    let raf1 = 0, raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (tickRef.current) clearInterval(tickRef.current);
        setWidth(100);
        hideRef.current = setTimeout(() => {
          setVisible(false);
          // Reset back to 0 after the fade so the next click starts
          // from a blank bar rather than a full one.
          setTimeout(() => setWidth(0), 250);
        }, 200);
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (tickRef.current) clearInterval(tickRef.current);
      if (hideRef.current) clearTimeout(hideRef.current);
    };
    // Pathname-only — query-string-only changes (e.g. report range
    // filter) don't need a route-progress flash, and depending on
    // useSearchParams would force this component into a Suspense
    // boundary throughout the layout tree.
  }, [pathname]);

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 9999,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 250ms ease",
      }}
    >
      <div
        style={{
          width: `${width}%`,
          height: "100%",
          background: "linear-gradient(90deg, var(--brand-500, #10b981), var(--brand-700, #047857))",
          boxShadow: "0 0 8px color-mix(in oklab, var(--brand-500, #10b981) 60%, transparent)",
          transition: "width 100ms linear",
        }}
      />
    </div>
  );
}
