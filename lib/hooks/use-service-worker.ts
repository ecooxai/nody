"use client";

import { useEffect } from "react";

export function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void (async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));

      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    })().catch(() => undefined);
  }, []);
}
