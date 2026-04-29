"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export default function Stale() {
  const r = useRouter();
  useEffect(() => { r.replace("/"); }, [r]);
  return null;
}

