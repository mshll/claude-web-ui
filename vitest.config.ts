import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["api/**/*.test.ts", "web/**/*.test.tsx", "web/**/*.test.ts"],
    environment: "node",
    environmentMatchGlobs: [
      ["web/**/*.test.tsx", "jsdom"],
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
