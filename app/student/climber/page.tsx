"use client";

// =============================================================================
// CLIMBER → MEMORY redirect.
//
// The Bloom Climber feature has been folded into Memory Tune-Up — same daily
// ritual idea, but built on top of spaced repetition (which is the more
// research-validated technique). Old links into /student/climber land here
// and get bounced to /student/memory automatically.
//
// Keeping this page (instead of deleting the route) means external links the
// student may have shared, bookmarked, or pinned still work.
// =============================================================================

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function ClimberRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    // 2026-05-13: dropped the 1.2 s ceremonial delay; redirect immediately.
    router.replace("/student/memory");
  }, [router]);

  return (
    <div className="max-w-md mx-auto card mt-12 text-center fade-in">
      <div className="text-3xl mb-2">🧠</div>
      <h1 className="font-bold text-lg">Bloom Climber is now Memory Tune-Up</h1>
      <p className="text-sm muted mt-2">
        Same daily ritual, built on spaced repetition (the most research-validated study technique). Sending
        you there now…
      </p>
      <div className="mt-4">
        <Link href="/student/memory" className="btn btn-primary">Open Memory Tune-Up →</Link>
      </div>
    </div>
  );
}
