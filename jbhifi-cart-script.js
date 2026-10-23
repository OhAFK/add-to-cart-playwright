const { chromium } = require("playwright");

const CART_URL = "https://www.jbhifi.co.nz/cart/40429974520009:2";
const RETRY_INTERVAL_MS = 1500;

function getRetryInterval() {
  const variance = RETRY_INTERVAL_MS * 0.25;
  return Math.floor(
    RETRY_INTERVAL_MS - variance + Math.random() * variance * 2,
  );
}

async function run() {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No Chrome browser context is available.");
  }

  const page = await context.newPage();
  const checkoutControl = page
    .getByRole("button", { name: /checkout/i })
    .or(page.getByRole("link", { name: /checkout/i }))
    .first();

  let attemptCount = 0;
  while (true) {
    attemptCount++;

    try {
      const action =
        attemptCount === 1
          ? `Opening ${CART_URL}`
          : `Refreshing ${page.url()} to retry`;
      console.log(`[Attempt #${attemptCount}] ${action}`);
      const response =
        attemptCount === 1
          ? await page.goto(CART_URL, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
            })
          : await page.reload({
              waitUntil: "domcontentloaded",
              timeout: 30000,
            });

      if (!response?.ok()) {
        console.warn(
          `[Attempt #${attemptCount}] Cart URL returned HTTP ${response?.status() ?? "unknown"}.`,
        );
      } else {
        await checkoutControl.waitFor({ state: "visible", timeout: 15000 });
        console.log(
          `Checkout is visible at ${page.url()}. Playing alarm and showing browser alert.`,
        );
        page.once("dialog", (dialog) => {
          console.log(`Alert: ${dialog.message()}`);
        });
        await page.evaluate(async () => {
          try {
            const audioCtx = new (
              window.AudioContext || window.webkitAudioContext
            )();
            await audioCtx.resume();
            for (let i = 0; i < 3; i++) {
              const osc = audioCtx.createOscillator();
              const gain = audioCtx.createGain();
              osc.type = "sine";
              osc.frequency.value = 880;
              gain.gain.setValueAtTime(0.5, audioCtx.currentTime + i * 0.2);
              gain.gain.exponentialRampToValueAtTime(
                0.01,
                audioCtx.currentTime + i * 0.2 + 0.15,
              );
              osc.connect(gain);
              gain.connect(audioCtx.destination);
              osc.start(audioCtx.currentTime + i * 0.2);
              osc.stop(audioCtx.currentTime + i * 0.2 + 0.15);
            }
            await new Promise((resolve) => setTimeout(resolve, 800));
            await audioCtx.close();
          } catch (err) {
            console.warn("Could not play the checkout alarm:", err.message);
          }
        });
        await page.evaluate(() =>
          window.alert("JB Hi-Fi checkout is visible in the browser."),
        );
        return;
      }
    } catch (err) {
      if (err.name === "TimeoutError") {
        console.log(
          `[Attempt #${attemptCount}] Cart loaded, but no visible checkout control was found.`,
        );
      } else {
        console.error(`[Attempt #${attemptCount}] Cart check failed:`, err);
      }
    }

    const retryInterval = getRetryInterval();
    console.log(`Retrying in ${(retryInterval / 1000).toFixed(1)} seconds...`);
    await page.waitForTimeout(retryInterval);
  }
}

run().catch((err) => {
  console.error("Could not open or verify the JB Hi-Fi cart:", err);
  process.exitCode = 1;
});
