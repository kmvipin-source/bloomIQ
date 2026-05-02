import { redirect } from "next/navigation";

// /admin/security is a wayfinding alias — every other admin link is /admin/*,
// but the security UI lives at /settings/security (shared with non-admin
// roles). Bounce admins to the canonical URL.
export default function AdminSecurityRedirect() {
  redirect("/settings/security");
}
