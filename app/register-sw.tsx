"use client";

import { useEffect } from "react";

// Service Worker を登録して、アプリ本体をオフラインでも起動できるようにする。
export default function RegisterSW() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* 登録失敗は無視(オフライン機能が無効になるだけ) */
      });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);
  return null;
}
