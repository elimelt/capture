/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface Window {
  /** Legacy WebKit prefix still present on older iOS Safari. */
  webkitAudioContext?: typeof AudioContext
}
