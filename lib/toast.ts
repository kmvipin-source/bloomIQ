// Lightweight global toast bus. Components fire `toast.success("...")` etc.
// from anywhere; <Toaster /> mounted in app/layout.tsx renders the queue.
//
// Why a custom event instead of a context: this lets server-action callbacks,
// non-React utilities, and async helpers fire toasts without needing a hook.

export type ToastKind = "success" | "info" | "error";
export type ToastDetail = { kind: ToastKind; message: string; id: number };

const EVENT = "bloomiq:toast";
let counter = 0;

function emit(kind: ToastKind, message: string) {
  if (typeof window === "undefined") return;
  const detail: ToastDetail = { kind, message, id: ++counter };
  window.dispatchEvent(new CustomEvent<ToastDetail>(EVENT, { detail }));
}

export const toast = {
  success: (m: string) => emit("success", m),
  info: (m: string) => emit("info", m),
  error: (m: string) => emit("error", m),
};

export const TOAST_EVENT = EVENT;
