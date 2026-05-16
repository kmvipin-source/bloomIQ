import { redirect } from "next/navigation";

// /admin has no index — bounce to /admin/dashboard. Without this the
// sidebar's ZCORIQ wordmark link (href=/admin) and any RSC prefetch
// against bare /admin returns Vercel's 404.
export default function AdminIndex() {
  redirect("/admin/dashboard");
}
