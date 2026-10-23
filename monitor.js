// monitor.js
const { chromium } = require("playwright");
const fs = require("fs");
const sites = require("./sites");

const MONITOR_PERIOD_MS = 900000; // 15 minutes
const MONITOR_WINDOW_START_OFFSET_MS = 0; // Starts right on the mark (e.g., 9:00:00)
const MONITOR_WINDOW_END_MS = 20000; // Runs for exactly 20 seconds
const MONITOR_COUNTDOWN_INTERVAL_MS = 30000;

// Read port from command line arguments (default to 9222)
const CDP_PORT = process.argv[2] || 9222;
const WORKER_PREFIX = process.argv[3] || "Instance";

function getMonitorWindowWaitMs(now = Date.now()) {
  const phase = now % MONITOR_PERIOD_MS;

  // If we are currently inside the active window (from 0 to MONITOR_WINDOW_END_MS)
  if (phase < MONITOR_WINDOW_END_MS) {
    return 0;
  }

  // Otherwise, calculate how much time is left until the next period starts
  return MONITOR_PERIOD_MS - phase;
}

async function waitForMonitorWindow(page, workerId) {
  let waitMs = getMonitorWindowWaitMs();
  while (waitMs > 0) {
    console.log(
      `[${WORKER_PREFIX} | Worker #${workerId}] Next monitoring window in ${Math.ceil(waitMs / 1000)} seconds.`,
    );
    await page.waitForTimeout(Math.min(waitMs, MONITOR_COUNTDOWN_INTERVAL_MS));
    waitMs = getMonitorWindowWaitMs();
  }
}

function logSuccessToFile(workerId, name, url, sku) {
  const successRecord = {
    instance: WORKER_PREFIX,
    workerId,
    name,
    url,
    sku,
    timestamp: new Date().toISOString(),
  };

  const fileName = "success.json";
  let existingRecords = [];

  try {
    if (fs.existsSync(fileName)) {
      existingRecords = JSON.parse(fs.readFileSync(fileName, "utf8"));
    }
  } catch (err) {}

  existingRecords.push(successRecord);
  fs.writeFileSync(fileName, JSON.stringify(existingRecords, null, 2), "utf8");
  console.log(
    `[${WORKER_PREFIX} | Worker #${workerId}] Success record saved for SKU ${sku}`,
  );
}

async function monitorProduct({
  page,
  url,
  name,
  workerId,
  addToCartMethod,
  skus = [],
  sku,
  quantity = 1,
  targetIntervalMs = 1000, // 1000ms interval target for maximum burst speed
  cartDelayMs = 1000,
  navigationTimeoutMs = 30000,
}) {
  if (addToCartMethod !== "farmers-post") {
    throw new Error(`Only the Farmers add-to-cart POST method is supported.`);
  }

  let activeSkus = skus.length > 0 ? [...skus] : sku ? [sku] : [];

  console.log(
    `[${WORKER_PREFIX} | Worker #${workerId} (${name})] Navigating to target URL...`,
  );
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  });

  while (true) {
    await waitForMonitorWindow(page, workerId);

    if (getMonitorWindowWaitMs() > 0) {
      continue;
    }

    console.log(
      `[${WORKER_PREFIX} | Worker #${workerId} (${name})] 🚀 Starting 20s parallel burst loop for SKUs: [${activeSkus.join(", ")}]`,
    );

    try {
      const burstResult = await page.evaluate(
        async ({
          initialSkus,
          quantity,
          targetIntervalMs,
          MONITOR_WINDOW_END_MS,
        }) => {
          let SKUS = [...initialSkus];
          const QTY = quantity;
          const URL =
            "https://www.farmers.co.nz/INTERSHOP/web/WFS/Farmers-Shop-Site/en_NZ/-/NZD/ViewExpressShop-AddProduct";

          let tries = 0;
          const startTime = Date.now();
          const successfulAdditions = [];
          const requestLogs = [];
          let needsReload = false;

          function classify(text, sku) {
            const doc = new DOMParser().parseFromString(text, "text/html");
            const modal = doc.querySelector(
              "#add-to-cart-confirmation .modal-body",
            );
            const successBox = modal
              ? modal.querySelector(".alert-success-alt")
              : null;
            const errorP = modal
              ? modal.querySelector('p[style*="B90618"]')
              : null;
            const dangerLi = doc.querySelector("#miniCart .alert-danger li");
            const pushedSku = new RegExp(
              '"event":\\s*"addToCart"[\\s\\S]*?"id":\\s*"' + sku + '"',
            ).test(text);
            const countEl = doc.querySelector("#mini-cart-count");
            const cartCount = countEl ? countEl.textContent.trim() : "?";

            if (successBox || pushedSku) return { status: "ADDED", cartCount };
            if (errorP || dangerLi)
              return {
                status: "SOLD OUT",
                msg: (errorP || dangerLi).textContent.trim(),
              };
            return { status: "UNKNOWN", msg: text.slice(0, 300) };
          }

          while (
            Date.now() - startTime < MONITOR_WINDOW_END_MS &&
            SKUS.length > 0
          ) {
            tries++;
            const iterationStart = performance.now();

            const promises = SKUS.map(async (sku) => {
              const body = `SKU=${sku}&Quantity_${sku}=${QTY}&addToCartBehavior=expresscart`;
              const requestTimestamp = new Date().toISOString();
              const startTimePerf = performance.now();

              try {
                const res = await fetch(URL, {
                  method: "POST",
                  mode: "cors",
                  credentials: "include",
                  headers: {
                    accept: "*/*",
                    "content-type":
                      "application/x-www-form-urlencoded; charset=UTF-8",
                    "x-requested-with": "XMLHttpRequest",
                  },
                  body: body,
                });

                const durationMs = Math.round(
                  performance.now() - startTimePerf,
                );

                if (res.status === 403) {
                  requestLogs.push({
                    timestamp: requestTimestamp,
                    sku,
                    status: "HTTP 403 Forbidden",
                    durationMs,
                  });
                  return { sku, error: "HTTP 403 Forbidden" };
                }

                const text = await res.text();
                const classification = classify(text, sku);

                requestLogs.push({
                  timestamp: requestTimestamp,
                  sku,
                  httpStatus: res.status,
                  resultStatus: classification.status,
                  durationMs,
                });

                return { sku, result: classification };
              } catch (err) {
                const durationMs = Math.round(
                  performance.now() - startTimePerf,
                );
                requestLogs.push({
                  timestamp: requestTimestamp,
                  sku,
                  error: err.message,
                  durationMs,
                });
                return { sku, error: err.message };
              }
            });

            const outcomes = await Promise.all(promises);

            for (const outcome of outcomes) {
              const { sku, result, error } = outcome;
              const skuIndex = SKUS.indexOf(sku);

              if (error) {
                if (error.includes("403")) {
                  needsReload = true;
                }
                continue;
              }

              if (result.status === "ADDED") {
                successfulAdditions.push({ sku, cartCount: result.cartCount });
                if (skuIndex > -1) SKUS.splice(skuIndex, 1);
              }
            }

            if (needsReload || SKUS.length === 0) break;

            const elapsed = performance.now() - iterationStart;
            const remainingWait = Math.max(0, targetIntervalMs - elapsed);

            if (remainingWait > 0) {
              await new Promise((r) => setTimeout(r, remainingWait));
            }
          }

          if (needsReload) {
            window.location.reload();
          }

          return { successfulAdditions, tries, needsReload, requestLogs };
        },
        {
          initialSkus: activeSkus,
          quantity,
          targetIntervalMs,
          MONITOR_WINDOW_END_MS,
        },
      );

      console.log(
        `\n📋 [${WORKER_PREFIX} | Worker #${workerId}] POST Request Logs for this Burst:`,
      );
      console.table(burstResult.requestLogs);

      if (burstResult.needsReload) {
        console.log(
          `[${WORKER_PREFIX} | Worker #${workerId}] 🔄 HTTP 403 detected. Page reloaded. Waiting for network stability...`,
        );
        await page
          .waitForLoadState("domcontentloaded", {
            timeout: navigationTimeoutMs,
          })
          .catch(() => {});
        continue;
      }

      if (burstResult.successfulAdditions.length > 0) {
        // Trigger terminal alarm sound/bell
        process.stdout.write("\x07");
        console.log(
          `\n🚨 ALARM! [${WORKER_PREFIX}] SUCCESSFUL ITEM(S) SECURED! 🚨\x07`,
        );

        for (const item of burstResult.successfulAdditions) {
          logSuccessToFile(workerId, name, url, item.sku);
        }
        if (cartDelayMs > 0) await page.waitForTimeout(cartDelayMs);
        await new Promise(() => {}); // Hold execution indefinitely on success
      } else {
        console.log(
          `[${WORKER_PREFIX} | Worker #${workerId}] Burst window ended. Tries: ${burstResult.tries}`,
        );
      }
    } catch (err) {
      console.error(
        `[${WORKER_PREFIX} | Worker #${workerId}] Error:`,
        err.message,
      );
    }
  }
}

async function run() {
  console.log(
    `[${WORKER_PREFIX}] Connecting to Chrome via CDP on port ${CDP_PORT}...`,
  );
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const defaultContext = browser.contexts()[0];

  await Promise.all(
    sites.map(async (site, index) => {
      const workerId = index + 1;
      const page = await defaultContext.newPage();
      await page.route("**/*", (route) => route.continue());
      return monitorProduct({ page, ...site, workerId });
    }),
  );
}

run();
