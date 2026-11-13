import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("another person's message in a shared group sits on the left", async ({
  page,
  browser,
}, testInfo) => {
  const stamp = Date.now();
  const ownerEmail = `shared-owner-${stamp}@rakazo.test`;
  const personEmail = `shared-person-${stamp}@rakazo.test`;
  await signup(page, ownerEmail, "password12", "Ada");
  await completeOnboarding(page);

  const personContext = await browser.newContext();
  const person = await personContext.newPage();
  try {
    await signup(person, personEmail, "password12", "Bo");
    await completeOnboarding(person);

    const group = await rpc<{ id: string }>(page, "groups/createShared", {
      name: "Shared planning",
      emails: [personEmail],
    });
    const groupUrl = `/app/g/${group.id}`;

    await page.goto(groupUrl);
    const composer = page.getByRole("combobox", { name: "Message Shared planning" });
    await expect(composer).toBeVisible();
    await composer.fill("Mine from Ada");
    await composer.press("Enter");

    await person.goto(groupUrl);
    const personComposer = person.getByRole("combobox", { name: "Message Shared planning" });
    await expect(personComposer).toBeVisible();
    await personComposer.fill("Theirs from Bo");
    await personComposer.press("Enter");
    const personTranscript = person.getByTestId("transcript");
    const personOwn = personTranscript
      .getByTestId("message-user-bubble")
      .filter({ hasText: "Theirs from Bo" });
    const personOther = personTranscript
      .getByTestId("message-user-bubble")
      .filter({ hasText: "Mine from Ada" });
    await expect(personOwn).toBeVisible();
    await expect(personOther).toBeVisible();
    // Each side is relative to who is looking: the sender's own message stays right.
    const personFrame = (await personTranscript.boundingBox())!;
    const personCenter = personFrame.x + personFrame.width / 2;
    const personOwnBox = (await personOwn.boundingBox())!;
    const personOtherBox = (await personOther.boundingBox())!;
    expect(personOwnBox.x + personOwnBox.width / 2).toBeGreaterThan(personCenter);
    expect(personOtherBox.x + personOtherBox.width / 2).toBeLessThan(personCenter);

    await page.reload();
    const transcript = page.getByTestId("transcript");
    const own = transcript.getByTestId("message-user-bubble").filter({ hasText: "Mine from Ada" });
    const other = transcript
      .getByTestId("message-user-bubble")
      .filter({ hasText: "Theirs from Bo" });
    await expect(own).toBeVisible();
    await expect(other).toBeVisible();
    await expect(transcript.getByText("Bo", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByTestId("bot-settings-trigger").locator("[data-shared-mark]"),
    ).toBeVisible();

    const frame = (await transcript.boundingBox())!;
    const center = frame.x + frame.width / 2;
    const ownBox = (await own.boundingBox())!;
    const otherBox = (await other.boundingBox())!;
    expect(otherBox.x + otherBox.width / 2).toBeLessThan(center);
    expect(ownBox.x + ownBox.width / 2).toBeGreaterThan(center);

    await captureScreenshot(page, testInfo, "shared-group-messages");
  } finally {
    await personContext.close();
  }
});
