import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
