"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { router.replace("/login?next=/teacher"); return; }

      const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();

      // Each role has exactly one home — no ping-pong between layouts
      if (prof?.role === "student")       { router.replace("/student"); return; }
      if (prof?.role === "super_teacher") { router.replace("/school");  return; }
      if (prof?.role !== "teacher")       { router.replace("/login");   return; }

      setOk(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ok) {
    return <div className="min-h-screen grid place-items-center"><div className="spinner" /></div>;
  }
  return (
    <div className="flex min-h-screen">
      <Sidebar role="teacher" />
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  );
}
