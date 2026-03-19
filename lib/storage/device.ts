const DEVICE_KEY = "nody.device-id";

export function getDeviceId() {
  if (typeof window === "undefined") return "server-device";
  const cached = window.localStorage.getItem(DEVICE_KEY);
  if (cached) return cached;
  const next = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_KEY, next);
  return next;
}
