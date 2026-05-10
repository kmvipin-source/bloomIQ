import { test, expect } from "@playwright/test";

// /api/healthz must always return ok:true with the three sub-checks
// green. UptimeRobot already pings this, but we want the failure to
// surface on the PR before the deploy reaches prod.
test("/api/healthz returns ok:true with all checks green", async ({ request }) => {
  const res = await request.get("/api/healthz");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.checks?.env_supabase_url).toBe("ok");
  expect(body.checks?.env_service_role).toBe("ok");
  expect(body.checks?.db_read).toBe("ok");
});
