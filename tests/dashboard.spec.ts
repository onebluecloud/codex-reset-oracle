import { expect, test } from "@playwright/test";

if (!process.env.VITEST) {
  test("dashboard renders on desktop and mobile", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Codex Reset Chance" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(
      page.getByText(/Unofficial project\. Not affiliated with OpenAI, X, or Apify\./)
    ).toBeVisible();
  });
}
