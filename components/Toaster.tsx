"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Info, XCircle, X } from "lucide-react";
import { TOAST_EVENT, type ToastDetail } from "@/lib/toast";

const AUTO_DISMISS_MS = 4000;

export default function Toaster() {
  const [items, setItems] = useState<ToastDetail[]>([]);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (!detail) return;
      setItems((curr) => [...curr, detail]);
      window.setTimeout(() => {
        setItems((curr) => curr.filter((t) => t.id !== detail.id));
      }, AUTO_DISMISS_MS);
    }
    window.addEventListener(TOAST_EVENT, handler);
    return () => window.removeEventListener(TOAST_EVENT, handler);
  }, []);

  function dismiss(id: number) {
    setItems((curr) => curr.filter((t) => t.id !== id));
  }

  if (!items.length) return null;
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {items.map((t) => {
        const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? XCircle : Info;
        const bg = t.kind === "success" ? "#ecfdf5" : t.kind === "error" ? "#fef2f2" : "#eff6ff";
        const border = t.kind === "success" ? "#10b981" : t.kind === "error" ? "#ef4444" : "#3b82f6";
        const fg = t.kind === "success" ? "#065f46" : t.kind === "error" ? "#991b1b" : "#1e3a8a";
        return (
          <div
            key={t.id}
            role="status"
            className="flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg border-l-4 animate-fade-in"
            style={{ background: bg, borderLeftColor: border, color: fg, minWidth: 280 }}
          >
            <Icon size={18} className="mt-0.5 shrink-0" />
            <div className="text-sm font-medium flex-1">{t.message}</div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
