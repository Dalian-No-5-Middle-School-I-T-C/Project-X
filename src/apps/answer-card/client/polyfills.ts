/**
 * Runtime polyfills for iOS 15.0–15.3 (Safari 15.4+ ships these natively).
 * Import this module before any other app code in main.tsx.
 */
(function applyIos15Polyfills(): void {
  if (typeof Object.hasOwn !== "function") {
    Object.hasOwn = (obj: object, prop: PropertyKey) =>
      Object.prototype.hasOwnProperty.call(obj, prop);
  }

  if (typeof globalThis.structuredClone !== "function") {
    globalThis.structuredClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  }
})();
