import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same "@/..." alias the app and tsconfig use, so a test can import a module
  // that imports its siblings by alias (most of src does).
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // Dummy secrets so importing modules that init clients at import-time
    // (e.g. supabase.ts via bans.ts) doesn't throw during tests. Tests here are
    // pure parity checks — they never touch the network.
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-dummy",
      ANTHROPIC_API_KEY: "test-dummy",
    },
  },
});
