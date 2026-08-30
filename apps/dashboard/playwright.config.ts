import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  reporter: [["list"], ["json", { outputFile: "../../.omo/evidence/dashboard/playwright-report.json" }]],
  use: { baseURL: "http://127.0.0.1:4174", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "pnpm preview --host 127.0.0.1 --port 4174",
    cwd: import.meta.dirname,
    port: 4174,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
