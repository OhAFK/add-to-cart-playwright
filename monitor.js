// monitor.js
require("dotenv").config();

const { chromium } = require("playwright");
const fs = require("fs");
const sites = require("./sites");

const MONITOR_PERIOD_MS = 30000; // 2 minutes total period (including offset and burst duration)
const MONITOR_WINDOW_START_OFFSET_MS = 0; // Starts 5 seconds before every 15-minute mark
const MONITOR_WINDOW_END_MS = 28000; // Runs for 60 seconds total (covering offset + burst duration)
const MONITOR_COUNTDOWN_INTERVAL_MS = 30000;
const DEFAULT_TARGET_INTERVAL_MS = 3000; // Default interval between requests in milliseconds
const BROWSER_RESTART_ERROR_THRESHOLD = 5;
const BROWSER_RESTART_EXIT_CODE = 75;

// ===== DISCORD CONFIGURATION =====
const DISCORD_SUCCESS_WEBHOOK_URL =
  process.env.DISCORD_SUCCESS_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  "YOUR_DISCORD_SUCCESS_WEBHOOK_URL_HERE";
const DISCORD_ERROR_WEBHOOK_URL =
  process.env.DISCORD_ERROR_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  "YOUR_DISCORD_ERROR_WEBHOOK_URL_HERE";
const DISCORD_PING_TARGET = "@everyone"; // or leave empty "" if you don't want a ping for successes

// Read port from command line arguments (default to 9222)
const CDP_PORT = process.argv[2] || 9222;
const WORKER_PREFIX = process.argv[3] || "Instance";

/**
 * Applies a random jitter percentage to a base millisecond value.
 * @param {number} baseMs The base time in milliseconds.
 * @param {number} jitterPercent Fraction of jitter (e.g. 0.2 for +/- 20%).
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

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * Sends a notification message for successful cart additions to Discord.
 */
async function sendDiscordAlert(workerId, name, url, sku, cartCount) {
  if (
    !DISCORD_SUCCESS_WEBHOOK_URL ||
    DISCORD_SUCCESS_WEBHOOK_URL.includes(
      "YOUR_DISCORD_SUCCESS_WEBHOOK_URL_HERE",
    )
  ) {
    return;
  }

  const payload = {
    content: DISCORD_PING_TARGET
      ? `${DISCORD_PING_TARGET} 🚨 **ITEM SECURED!**`
      : "🚨 **ITEM SECURED!**",
    embeds: [
      {
        title: "🛒 Successful Cart Addition!",
        color: 65280, // Green color
        fields: [
          {
            name: "Instance / Worker",
            value: `${WORKER_PREFIX} (#${workerId})`,
            inline: true,
          },
          {
            name: "Product Name",
            value: name || "Unknown Product",
            inline: true,
          },
          { name: "SKU", value: String(sku), inline: true },
          { name: "Cart Count", value: String(cartCount), inline: true },
          { name: "Time (NZ)", value: getNewZealandTimestamp(), inline: false },
          { name: "Product URL", value: url, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    await fetch(DISCORD_SUCCESS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(
      `[${WORKER_PREFIX} | Worker #${workerId}] Error sending Discord success alert:`,
      err.message,
    );
  }
}

/**
 * Sends a notification message for errors/warnings to Discord.
 */
async function sendErrorDiscordAlert(workerId, name, url, sku, errorMsg) {
  if (
    !DISCORD_ERROR_WEBHOOK_URL ||
    DISCORD_ERROR_WEBHOOK_URL.includes("YOUR_DISCORD_ERROR_WEBHOOK_URL_HERE")
  ) {
    return;
  }

  const payload = {
    content: `${DISCORD_PING_TARGET} ⚠️ **MONITOR BROKEN / BLOCKED!**`, // Pings you when it breaks
    embeds: [
      {
        title: "⚠️ Monitor Error / Blocked",
        color: 16711680, // Red color
        fields: [
          {
            name: "Instance / Worker",
            value: `${WORKER_PREFIX} (#${workerId})`,
            inline: true,
          },
          {
            name: "Product Name",
            value: name || "Unknown Product",
            inline: true,
          },
          { name: "SKU", value: String(sku || "N/A"), inline: true },
          { name: "Error / Status", value: String(errorMsg), inline: false },
          { name: "Time (NZ)", value: getNewZealandTimestamp(), inline: false },
          { name: "Product URL", value: url, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    await fetch(DISCORD_ERROR_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(
      `[${WORKER_PREFIX} | Worker #${workerId}] Error sending Discord error alert:`,
      err.message,
    );
  }
}

function getMonitorWindowWaitMs(now = Date.now()) {
  const period = MONITOR_PERIOD_MS;
  const offset = MONITOR_WINDOW_START_OFFSET_MS;
  const duration = MONITOR_WINDOW_END_MS;

  const phase = now % period;

  const windowStartPhase = (period + (offset % period)) % period;
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
    const jitteredCountdownInterval = applyJitter(
      MONITOR_COUNTDOWN_INTERVAL_MS,
      0.2,
    );
    await page.waitForTimeout(Math.min(waitMs, jitteredCountdownInterval));
    waitMs = getMonitorWindowWaitMs();
  }
}

async function logSuccessToFile(workerId, name, url, sku, cartCount) {
  const successRecord = {
    instance: WORKER_PREFIX,
    workerId,
    name,
    url,
    sku,
    cartCount,
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

  await sendDiscordAlert(workerId, name, url, sku, cartCount);
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
  targetIntervalMs = DEFAULT_TARGET_INTERVAL_MS,
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
  const consecutiveErrorsBySku = new Map();

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
            await sendErrorDiscordAlert(
              workerId,
              name,
              url,
              null,
              `Hard refresh error: ${err.message}`,
            );
          }

          const elapsed = performance.now() - iterationStart;
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

            function applyJitter(baseMs, jitterPercent = 0.2) {
              const range = baseMs * jitterPercent;
              return Math.max(
                0,
                Math.round(baseMs + (Math.random() * 2 - 1) * range),
              );
            }

            function ts() {
              const d = new Date();
              return (
                d.toTimeString().split(" ")[0] +
                "." +
                String(d.getMilliseconds()).padStart(3, "0")
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

              return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
            }

            function classify(text) {
              const doc = new DOMParser().parseFromString(text, "text/html");
              const modal = doc.querySelector(
                "#add-to-cart-confirmation .modal-body",
              );

              const errorP = modal
                ? modal.querySelector('p[style*="B90618"]')
                : null;
              const dangerLi = doc.querySelector("#miniCart .alert-danger li");

              if (errorP || dangerLi) {
                return {
                  status: "SOLD OUT",
                  msg: (errorP || dangerLi).textContent.trim(),
                };
              }

              const successBox = modal
                ? modal.querySelector(".alert-success-alt")
                : null;

              const countEl = doc.querySelector("#mini-cart-count");
              let cartCountNum = 0;
              let cartCountStr = "?";

              if (countEl) {
                cartCountStr = countEl.textContent.trim();
                const parsedVal = parseInt(cartCountStr, 10);
                if (!isNaN(parsedVal) && parsedVal >= 1) {
                  cartCountNum = parsedVal;
                }
              }

              if (cartCountNum > 0) {
                return { status: "ADDED", cartCount: cartCountStr };
              }

              return { status: "UNKNOWN", msg: text.slice(0, 300) };
            }

            while (
              Date.now() - startTime < MONITOR_WINDOW_END_MS &&
              SKUS.length > 0
            ) {
              tries++;
              const iterationStart = performance.now();

              const promises = SKUS.map(async (sku) => {
                const BODY = `SKU=${sku}&Quantity_${sku}=${QTY}&addToCartBehavior=expresscart`;
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
                    body: BODY,
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
                  const result = classify(text);

                  requestLogs.push({
                    timestamp: requestTimestamp,
                    sku,
                    httpStatus: res.status,
                    resultStatus: result.status,
                    durationMs,
                  });

                  return { sku, result };
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
                  console.log(
                    "%c[" +
                      ts() +
                      "] #" +
                      tries +
                      " [ADDED TO CART] cart: " +
                      result.cartCount,
                    "color:#00b5b5;font-weight:bold",
                  );
                  successfulAdditions.push({
                    sku,
                    cartCount: result.cartCount,
                  });
                  if (skuIndex > -1) SKUS.splice(skuIndex, 1);
                } else if (result.status === "SOLD OUT") {
                  console.log(
                    "[" + ts() + "] #" + tries + " [SOLD OUT] " + result.msg,
                  );
                } else {
                  console.warn(
                    "[" + ts() + "] #" + tries + " [UNKNOWN] ",
                    result.msg,
                  );
                }
              }

              if (needsReload || SKUS.length === 0) break;

              const elapsed = performance.now() - iterationStart;
              const jitteredInterval = applyJitter(targetIntervalMs, 0.2);
              const remainingWait = Math.max(0, jitteredInterval - elapsed);

              if (remainingWait > 0) {
                await new Promise((r) => setTimeout(r, remainingWait));
              }
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

        let browserRestartRequested = false;
        for (const log of burstResult.requestLogs) {
          const error = log.status === "HTTP 403 Forbidden" || log.error;
          const consecutiveErrors = error
            ? (consecutiveErrorsBySku.get(log.sku) || 0) + 1
            : 0;

          if (error) {
            consecutiveErrorsBySku.set(log.sku, consecutiveErrors);
          } else {
            consecutiveErrorsBySku.delete(log.sku);
          }
          log.consecutiveErrors = consecutiveErrors;

          if (error && consecutiveErrors === BROWSER_RESTART_ERROR_THRESHOLD) {
            const message =
              `SKU ${log.sku}: ${log.status || log.error} ` +
              `(${consecutiveErrors} consecutive errors). The browser will restart.`;
            console.warn(`[${WORKER_PREFIX} | Worker #${workerId}] ${message}`);
            browserRestartRequested = true;
            await sendErrorDiscordAlert(workerId, name, url, log.sku, message);
          }
        }

        console.log(
          `\n📋 [${WORKER_PREFIX} | Worker #${workerId}] POST Request Logs for this Burst:`,
        );
        console.table(burstResult.requestLogs);

        if (browserRestartRequested) {
          console.error(
            `[${WORKER_PREFIX} | Worker #${workerId}] Restarting browser after ${BROWSER_RESTART_ERROR_THRESHOLD} consecutive request errors.`,
          );
          process.stdout.write("", () =>
            process.exit(BROWSER_RESTART_EXIT_CODE),
          );
          return;
        }

        if (burstResult.needsReload) {
          console.log(
            `[${WORKER_PREFIX} | Worker #${workerId}] 🔄 HTTP 403 detected. Page reloaded. Waiting for network stability...`,
          );
          await page
            .reload({
              waitUntil: "domcontentloaded",
              timeout: navigationTimeoutMs,
            })
            .catch((err) => {
              sendErrorDiscordAlert(
                workerId,
                name,
                url,
                null,
                `Reload failure: ${err.message}`,
              );
            });
          continue;
        }

        if (burstResult.successfulAdditions.length > 0) {
          process.stdout.write("\x07");
          console.log(
            `\n🚨 ALARM! [${WORKER_PREFIX}] SUCCESSFUL ITEM(S) SECURED! 🚨\x07`,
          );

          for (const item of burstResult.successfulAdditions) {
            await logSuccessToFile(
              workerId,
              name,
              url,
              item.sku,
              item.cartCount,
            );
          }
          if (cartDelayMs > 0) {
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
      await sendErrorDiscordAlert(
        workerId,
        name,
        url,
        null,
        `Runtime Error: ${err.message}`,
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
