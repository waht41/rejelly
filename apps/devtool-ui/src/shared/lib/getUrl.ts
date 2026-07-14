/**
 * Constants and configuration values
 */

/**
 * Get default WebSocket URL based on current window location
 * Uses wss:// for https, ws:// for http
 */
export function getDefaultWebSocketUrl(): string {
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/ws`;
  }
  // Fallback for SSR
  return "ws://127.0.0.1:5789/ws";
}
