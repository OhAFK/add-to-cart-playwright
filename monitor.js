// monitor.js
const { chromium } = require("playwright");
const fs = require("fs");
const sites = require("./sites"); // Import your separate configuration file

// Helper to randomize a base value by a percentage variance (default ±20%)
function getRandomizedValue(baseValue, variancePercent = 0.2) {
  if (!baseValue || typeof baseValue !== "number") return baseValue;
  const min = baseValue * (1 - variancePercent);
  const max = baseValue * (1 + variancePercent);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to record success to a file
function logSuccessToFile(workerId, name, url) {
  const successRecord = {
    workerId,
    name,
    url,
    timestamp: new Date().toISOString(),
  };

  const fileName = "success.json";
  let existingRecords = [];

  try {
    if (fs.existsSync(fileName)) {
      const fileData = fs.readFileSync(fileName, "utf8");
      existingRecords = JSON.parse(fileData);
    }
  } catch (err) {
    console.warn(
      `[Warning] Could not read existing ${fileName}, starting a fresh list.`,
    );
  }

  existingRecords.push(successRecord);

  try {
    fs.writeFileSync(
      fileName,
      JSON.stringify(existingRecords, null, 2),
      "utf8",
    );
    console.log(`[Worker #${workerId}] Success record saved to ${fileName}`);
  } catch (err) {
    console.error(
      `[Worker #${workerId}] Failed to write success record to file:`,
      err.message,
    );
  }
}

async function monitorProduct({
  context,
  url,
  name,
  workerId,
  addToCartSelector,
  addToCartMethod = "click",
  sku,
  quantity = 1,
  addToCartConfirmationText,
  manualCartUrl,
  refreshIntervalMs = 5000,
  cartDelayMs = 1000,
  addToCartConfirmationTimeoutMs = 10000,
  addToCartWaitTimeoutMs = 5000,
  navigationTimeoutMs = 30000,
  clickTimeoutMs = 5000,
}) {
  const page = await context.newPage();

  // Force hard refresh / bypass cache by enabling request routing
  await page.route("**/*", (route) => route.continue());

  let attemptCount = 0;

  while (true) {
    // Randomize timeouts and delays per loop iteration to avoid predictable pattern detection
    const currentRefreshInterval = getRandomizedValue(refreshIntervalMs, 0.25);
    const currentNavTimeout = getRandomizedValue(navigationTimeoutMs, 0.15);
    const currentWaitTimeout = getRandomizedValue(addToCartWaitTimeoutMs, 0.2);
    const currentClickTimeout = getRandomizedValue(clickTimeoutMs, 0.2);
    const currentConfirmTimeout = getRandomizedValue(
      addToCartConfirmationTimeoutMs,
      0.2,
    );
    const currentCartDelay = getRandomizedValue(cartDelayMs, 0.25);

    try {
      attemptCount++;

      // Navigate to Google first before going to the target page
      console.log(
        `[Worker #${workerId} (${name}) | Attempt #${attemptCount}] Navigating to Google first...`,
      );
      await page.goto("https://www.google.com", {
        waitUntil: "domcontentloaded",
        timeout: currentNavTimeout,
      });

      // Brief randomized pause on Google
      await page.waitForTimeout(getRandomizedValue(1000, 0.3));

      console.log(
        `[Worker #${workerId} (${name}) | Attempt #${attemptCount}] Checking: ${url}`,
      );
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: currentNavTimeout,
      });

      const addToCartBtn = page
        .locator(addToCartSelector)
        .filter({ visible: true })
        .first();
      let addToCartButtonFound = false;

      try {
        await addToCartBtn.waitFor({
          state: "visible",
          timeout: currentWaitTimeout,
        });
        addToCartButtonFound = true;
      } catch (err) {
        if (err.name !== "TimeoutError") {
          throw err;
        }
        console.log(
          `[Worker #${workerId} (${name})][NOT FOUND] Add-to-cart button is not visible.`,
        );
      }

      if (addToCartButtonFound) {
        const disabledAttribute = await addToCartBtn.getAttribute("disabled");
        const isDisabled =
          disabledAttribute !== null || !(await addToCartBtn.isEnabled());
        const buttonText = (await addToCartBtn.textContent())?.trim() ?? "";
        const className = (await addToCartBtn.getAttribute("class")) || "";

        if (
          !isDisabled &&
          !buttonText.toLowerCase().includes("sold out") &&
          !className.includes("disabled")
        ) {
          console.log(
            `[Worker #${workerId} (${name})][SUCCESS] Item available! ${
              addToCartMethod === "farmers-post"
                ? "Sending add-to-cart POST..."
                : "Clicking add to cart..."
            }`,
          );

          console.log(`\n========================================`);
          console.log(`🎉 SUCCESSFUL ITEM SECURED!`);
          console.log(`- Worker ID: #${workerId}`);
          console.log(`- Product Name: ${name}`);
          console.log(`- Product URL: ${url}`);
          console.log(`========================================\n`);

          if (addToCartMethod === "farmers-post") {
            if (!sku) {
              throw new Error("A SKU is required for the Farmers add-to-cart POST.");
            }

            const postStartedAt = Date.now();
            const result = await page.evaluate(async ({ sku, quantity }) => {
              const endpoint =
                "/INTERSHOP/web/WFS/Farmers-Shop-Site/en_NZ/-/NZD/ViewExpressShop-AddProduct";
              const body = new URLSearchParams({
                SKU: sku,
                [`Quantity_${sku}`]: String(quantity),
                addToCartBehavior: "expresscart",
              });
              const response = await fetch(endpoint, {
                method: "POST",
                credentials: "include",
                headers: {
                  accept: "*/*",
                  "content-type":
                    "application/x-www-form-urlencoded; charset=UTF-8",
                  "x-requested-with": "XMLHttpRequest",
                },
                body,
              });
              const text = await response.text();
              const doc = new DOMParser().parseFromString(text, "text/html");
              const modal = doc.querySelector(
                "#add-to-cart-confirmation .modal-body",
              );
              const successBox = modal?.querySelector(".alert-success-alt");
              const errorMessage =
                modal?.querySelector('p[style*="B90618"]') ||
                doc.querySelector("#miniCart .alert-danger li");
              const pushedSku = new RegExp(
                '"event":\\s*"addToCart"[\\s\\S]*?"id":\\s*"' + sku + '"',
              ).test(text);
              const count = doc.querySelector("#mini-cart-count");

              return {
                httpStatus: response.status,
                ok: response.ok,
                status:
                  successBox || pushedSku
                    ? "ADDED"
                    : errorMessage
                      ? "SOLD OUT"
                      : "UNKNOWN",
                message:
                  successBox?.textContent.trim() ||
                  errorMessage?.textContent.trim() ||
                  text.slice(0, 300),
                cartCount: count?.textContent.trim() || "?",
              };
            }, { sku, quantity });

            console.log(
              `[Worker #${workerId}] Farmers add-to-cart POST completed in ${Date.now() - postStartedAt}ms (HTTP ${result.httpStatus}).`,
            );
            if (!result.ok || result.status !== "ADDED") {
              throw new Error(
                `Farmers POST did not confirm add (${result.status}, HTTP ${result.httpStatus}): ${result.message}`,
              );
            }
            console.log(
              `[Worker #${workerId}] Farmers POST confirmed add; cart count: ${result.cartCount}.`,
            );
          } else {
            const clickStartedAt = Date.now();
            await addToCartBtn.click({ timeout: currentClickTimeout });
            console.log(
              `[Worker #${workerId}] Add-to-cart click completed in ${Date.now() - clickStartedAt}ms.`,
            );
          }

          if (addToCartMethod !== "farmers-post" && addToCartConfirmationText) {
            console.log(
              `[Worker #${workerId}] Waiting for add-to-cart confirmation: "${addToCartConfirmationText}"`,
            );
            await page
              .getByText(addToCartConfirmationText, { exact: false })
              .waitFor({
                state: "visible",
                timeout: currentConfirmTimeout,
              });
            console.log(
              `[Worker #${workerId}] Add-to-cart confirmation received.`,
            );
          } else if (currentCartDelay > 0) {
            console.log(
              `[Worker #${workerId}] Waiting ${currentCartDelay}ms before proceeding to cart...`,
            );
            await page.waitForTimeout(currentCartDelay);
          }

          logSuccessToFile(workerId, name, url);

          console.log(
            `[Worker #${workerId}] SUCCESS! Item added. Playing alarm...`,
          );

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
            } catch (e) {
              console.warn("Audio error:", e);
            }
          });

          console.log(
            `[Worker #${workerId}] Navigating directly to manual cart URL: ${manualCartUrl}`,
          );
          await page.goto(manualCartUrl, {
            waitUntil: "domcontentloaded",
            timeout: currentNavTimeout,
          });

          console.log(
            `[Worker #${workerId}] Item secured! Pausing this worker.`,
          );
          await new Promise(() => {});
        } else {
          console.log(
            `[Worker #${workerId} (${name})][NOT CLICKED] ` +
              `disabled attribute: ${disabledAttribute === null ? "absent" : JSON.stringify(disabledAttribute)}; ` +
              `enabled: ${!isDisabled}; text: "${buttonText}"`,
          );
        }
      }
    } catch (err) {
      console.error(`[Worker #${workerId} (${name})] Error:`, err.message);
    }

    console.log(
      `[Worker #${workerId}] Waiting ${(currentRefreshInterval / 1000).toFixed(1)}s before refresh...`,
    );
    await page.waitForTimeout(currentRefreshInterval);
  }
}

async function runAll() {
  console.log(`Connecting to existing Chrome via CDP (port 9222)...`);

  try {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const defaultContext = browser.contexts()[0];

    console.log(
      `Connected! Launching ${sites.length} monitoring workers across separate tabs...`,
    );

    await Promise.all(
      sites.map((site, index) =>
        monitorProduct({
          context: defaultContext,
          ...site,
          workerId: index + 1,
        }),
      ),
    );
  } catch (err) {
    console.error(
      "Connection failed. Make sure Chrome is running with remote debugging port 9222 enabled.",
      err.message,
    );
  }
}

runAll();
