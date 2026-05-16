import { redirect } from "next/navigation";

/**
 * /student/classes — REMOVED.
 *
 * The "My Classes" surface used to let a student self-enrol via class
 * code and view/leave their classes. ZCORIQ school pilots are
 * fully admin-onboarded (no self-enrol), so the page served no
 * purpose. Anyone landing here from an old bookmark gets redirected
 * back to the dashboard.
 *
 * The directory itself is preserved (deletion blocked by repo perms);
 * a future cleanup commit can `git rm -r app/student/classes`.
 */
export default function ClassesRemovedRedirect() {
  redirect("/student");
}
