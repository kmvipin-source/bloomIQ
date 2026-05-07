import { redirect } from "next/navigation";

/**
 * /teacher/assign — was a stand-alone "quick assign" workflow page.
 *
 * Removed because it duplicated functionality already on /teacher/quizzes
 * (every row there has an inline Assign button + an Unassigned status
 * pill, which solves the same problem in one fewer click).
 *
 * This stub redirects so any stale bookmarks or back-button clicks
 * still land somewhere useful instead of a 404.
 *
 * Safe to delete this whole directory — nothing else in the app links
 * here.
 */
export default function AssignRedirect(): never {
  redirect("/teacher/quizzes");
}
