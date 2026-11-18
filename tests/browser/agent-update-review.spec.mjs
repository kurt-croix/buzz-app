import { test, expect } from "./source-fixture.mjs";

test("agent changes wait for owner review in the agent's own settings form", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?change");
  const dialog = page.getByRole("dialog", { name: "Edit Ada" });
  await expect(dialog).toContainText(
    "Parent proposed these changes. Nothing changes until you save.",
  );
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toHaveValue("Ada Reviewer");
  await expect(
    dialog.getByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("Review pull requests before they merge.");
  await expect(dialog).toContainText("The provider changes");
  await expect(dialog).toContainText("Dropped");
  expect(await page.evaluate(() => window.updateReviewResult())).toEqual([]);
  const save = dialog.getByRole("button", { name: "Save changes" });
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(name).toBeInViewport();
      await expect(save).toBeInViewport();
    }
  }
  await name.fill("Reviewer");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.updateReviewResult())).toEqual([
    expect.objectContaining({
      name: "Reviewer",
      type: "fixture/other",
      config: { instructions: "Review pull requests before they merge." },
    }),
  ]);
});

test("a Codex agent's settings proposal persists only on the owner Save", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/agent-library.html?settingsSync=codex&proposeSettings",
  );
  const proposal = {
    model: "codex-fixture-model",
    effort: "high",
    scope: "community",
    workspace: "~/example",
    voice: "maple",
    apps: true,
  };
  const propose = () =>
    page.evaluate((value) => window.proposeFixtureSettings(value), proposal);
  const review = page.getByRole("dialog", { name: "Edit Ada" });
  const saved = () => page.evaluate(() => window.updateReviewResult());
  await propose();
  await expect(review.getByRole("textbox", { name: "Workspace" })).toHaveValue(
    "~/example",
  );
  await expect(
    review.getByRole("combobox", { name: "Sessions" }),
  ).toContainText("One session per community");
  await expect(
    review.getByRole("button", { name: "Huddle voice" }),
  ).toContainText("Maple");
  await expect(
    review.getByRole("switch", { name: "Codex apps and plugins" }),
  ).toBeChecked();
  await expect(
    review.getByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("Review the change.");

  await review.getByRole("button", { name: "Huddle voice" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose voice" });
  await chooser.getByRole("radio", { name: "Cove", exact: true }).click();
  await chooser.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    review.getByRole("button", { name: "Huddle voice" }),
  ).toContainText("Cove");
  expect(await saved()).toEqual([]);
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(await saved()).toEqual([]);

  await propose();
  await page.setViewportSize({ width: 390, height: 950 });
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.fontSize = "20px";
  });
  const save = review.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeInViewport();
  await save.click();
  await expect(review).toHaveCount(0);
  expect(await saved()).toEqual([
    expect.objectContaining({
      config: expect.objectContaining({
        ...proposal,
        instructions: "Review the change.",
      }),
    }),
  ]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const pane = page.getByRole("tabpanel", { name: "Settings", exact: true });
  await expect(pane.getByRole("combobox", { name: "Sessions" })).toContainText(
    "One session per community",
  );
  await expect(
    pane.getByRole("button", { name: "Huddle voice" }),
  ).toContainText("Maple");
  await expect(
    pane.getByRole("switch", { name: "Codex apps and plugins" }),
  ).toBeChecked();
  await expect(pane.getByRole("textbox", { name: "Workspace" })).toHaveValue(
    "~/example",
  );
});

test("a proposed Huddle voice needs a verified catalog before Save", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/agent-library.html?settingsSync=codex&proposeSettings&voicesUnavailable",
  );
  await page.evaluate(() =>
    window.proposeFixtureSettings({ voice: "unknown" }),
  );
  const review = page.getByRole("dialog", { name: "Edit Ada" });
  await expect(review).toContainText("Voice choices could not be checked");
  await review.getByRole("button", { name: "Save", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText(
    "Check Huddle voices or choose Codex default before saving.",
  );
  expect(await page.evaluate(() => window.updateReviewResult())).toEqual([]);
  await review.getByRole("button", { name: "Huddle voice" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose voice" });
  await chooser
    .getByRole("radio", { name: "Codex default", exact: true })
    .click();
  await chooser.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    review.getByRole("button", { name: "Huddle voice" }),
  ).toContainText("Default");
  await review.getByRole("button", { name: "Save", exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(
    await page.evaluate(() => window.updateReviewResult()[0].config),
  ).not.toHaveProperty("voice");
});
