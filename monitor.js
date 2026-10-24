// monitor.js
const { chromium } = require("playwright");
const fs = require("fs");
const sites = require("./sites");

const MONITOR_PERIOD_MS = 900000; // 15 minutes
const MONITOR_WINDOW_START_OFFSET_MS = 5000; // Starts 5 seconds before every 15-minute mark
const MONITOR_WINDOW_END_MS = 60000; // Runs for 60 seconds total (covering offset + burst duration)
const MONITOR_COUNTDOWN_INTERVAL_MS = 30000;

// Read port from command line arguments (default to 9222)
const CDP_PORT = process.argv[2] || 9222;
const WORKER_PREFIX = process.argv[3] || "Instance";

/**
 * Applies a random jitter percentage to a base millisecond value.
 * @param {number} baseMs - The base time in milliseconds.
 * @param {number} jitterPercent - Fraction of jitter (e.g. 0.2 for +/- 20%).
 * @returns {number} Jittered milliseconds value.
 */
function applyJitter(baseMs, jitterPercent = 0.2) {
  const range = baseMs * jitterPercent;
  return Math.max(0, Math.round(baseMs + (Math.random() * 2 - 1) * range));
}

function getNewZealandTimestamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-NZ", {
      timeZone: "Pacific/Auckland",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  const localTimeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((localTimeAsUtc - date.getTime()) / 60000);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(
    2,
    "0",
  );
  const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getMilliseconds()).padStart(3, "0")}${offsetSign}${offsetHours}:${offsetRemainder}`;
}

function getMonitorWindowWaitMs(now = Date.now()) {
  const period = MONITOR_PERIOD_MS;
  const offset = MONITOR_WINDOW_START_OFFSET_MS;
  const duration = MONITOR_WINDOW_END_MS;

  const phase = now % period;

  const windowStartPhase = (period - (offset % period)) % period;
  const windowEndPhase = (windowStartPhase + duration) % period;

  let isInside = false;
  if (windowStartPhase < windowEndPhase) {
    isInside = phase >= windowStartPhase && phase < windowEndPhase;
  } else {
    isInside = phase >= windowStartPhase || phase < windowEndPhase;
  }

  if (isInside) {
    return 0;
  }

  let waitMs = windowStartPhase - phase;
  if (waitMs <= 0) {
    waitMs += period;
  }
  return waitMs;
}

async function waitForMonitorWindow(page, workerId) {
  let waitMs = getMonitorWindowWaitMs();
  if (waitMs > 0) {
    const startTime = new Date(Date.now() + waitMs);
    console.log(
      `[${WORKER_PREFIX} | Worker #${workerId}] Next window starts at ${getNewZealandTimestamp(startTime)} (in ${Math.ceil(waitMs / 1000)}s).`,
    );
  }
  while (waitMs > 0) {
    // Apply jitter to the countdown polling interval (e.g. +/- 20%)
    const jitteredCountdownInterval = applyJitter(
      MONITOR_COUNTDOWN_INTERVAL_MS,
      0.2,
    );
    await page.waitForTimeout(Math.min(waitMs, jitteredCountdownInterval));
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
    timestamp: getNewZealandTimestamp(),
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
  targetIntervalMs = 1000,
  cartDelayMs = 1000,
  navigationTimeoutMs = 30000,
}) {
  if (
    addToCartMethod !== "farmers-post" &&
    addToCartMethod !== "refresh-only"
  ) {
    throw new Error(
      `Only the Farmers add-to-cart POST and refresh-only methods are supported.`,
    );
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
      `[${WORKER_PREFIX} | Worker #${workerId} (${name})] 🚀 Starting active burst window (${addToCartMethod})`,
    );

    try {
      if (addToCartMethod === "refresh-only") {
        const startTime = Date.now();
        let tries = 0;

        const cdpSession = await page.context().newCDPSession(page);
        console.log(
          `[${WORKER_PREFIX} | Worker #${workerId} (${name})] 🔄 Homepage Entered`,
        );

        while (Date.now() - startTime < MONITOR_WINDOW_END_MS) {
          tries++;
          const iterationStart = performance.now();
          try {
            await cdpSession.send("Page.reload", { ignoreCache: true });
            await page
              .waitForLoadState("domcontentloaded", {
                timeout: navigationTimeoutMs,
              })
              .catch(() => {});
          } catch (err) {
            console.error(
              `[${WORKER_PREFIX} | Worker #${workerId} (${name})] Hard refresh error:`,
              err.message,
            );
          }

          const elapsed = performance.now() - iterationStart;
          // Apply jitter to the refresh interval wait time (+/- 25%)
          const jitteredRefreshInterval = applyJitter(
            targetIntervalMs / 2,
            0.25,
          );
          const remainingWait = Math.max(0, jitteredRefreshInterval - elapsed);

          if (remainingWait > 0) {
            await page.waitForTimeout(remainingWait);
          }
        }

        console.log(
          `[${WORKER_PREFIX} | Worker #${workerId} (${name})] Burst window ended. Total refreshes: ${tries}`,
        );
      } else {
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

            // Helper function for jitter inside browser context
            function applyJitter(baseMs, jitterPercent = 0.2) {
              const range = baseMs * jitterPercent;
              return Math.max(
                0,
                Math.round(baseMs + (Math.random() * 2 - 1) * range),
              );
            }

            function getNZTimestamp(date = new Date()) {
              const parts = Object.fromEntries(
                new Intl.DateTimeFormat("en-NZ", {
                  timeZone: "Pacific/Auckland",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hourCycle: "h23",
                })
                  .formatToParts(date)
                  .map(({ type, value }) => [type, value]),
              );
              const localTimeAsUtc = Date.UTC(
                Number(parts.year),
                Number(parts.month) - 1,
                Number(parts.day),
                Number(parts.hour),
                Number(parts.minute),
                Number(parts.second),
              );
              const offsetMinutes = Math.round(
                (localTimeAsUtc - date.getTime()) / 60000,
              );
              const offsetSign = offsetMinutes >= 0 ? "+" : "-";
              const offsetHours = String(
                Math.floor(Math.abs(offsetMinutes) / 60),
              ).padStart(2, "0");
              const offsetRemainder = String(
                Math.abs(offsetMinutes) % 60,
              ).padStart(2, "0");

              return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getMilliseconds()).padStart(3, "0")}${offsetSign}${offsetHours}:${offsetRemainder}`;
            }

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

              if (successBox || pushedSku)
                return { status: "ADDED", cartCount };
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
                const requestTimestamp = getNZTimestamp();
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
                  successfulAdditions.push({
                    sku,
                    cartCount: result.cartCount,
                  });
                  if (skuIndex > -1) SKUS.splice(skuIndex, 1);
                }
              }

              if (needsReload || SKUS.length === 0) break;

              const elapsed = performance.now() - iterationStart;
              // Apply jitter to the target interval wait time (+/- 20%)
              const jitteredInterval = applyJitter(targetIntervalMs, 0.2);
              const remainingWait = Math.max(0, jitteredInterval - elapsed);

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
          process.stdout.write("\x07");
          console.log(
            `\n🚨 ALARM! [${WORKER_PREFIX}] SUCCESSFUL ITEM(S) SECURED! 🚨\x07`,
          );

          for (const item of burstResult.successfulAdditions) {
            logSuccessToFile(workerId, name, url, item.sku);
          }
          if (cartDelayMs > 0) {
            // Apply jitter to the cart delay timeout (+/- 20%)
            const jitteredCartDelay = applyJitter(cartDelayMs, 0.2);
            await page.waitForTimeout(jitteredCartDelay);
          }
          await new Promise(() => {});
        } else {
          console.log(
            `[${WORKER_PREFIX} | Worker #${workerId}] Burst window ended. Tries: ${burstResult.tries}`,
          );
        }
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
