// monitor.js
const { chromium } = require('playwright');
const fs = require('fs');
const sites = require('./sites'); // Import your separate configuration file

// Refresh interval set to 1–3 seconds (1000ms - 3000ms)
const MIN_INTERVAL = 1000;
const MAX_INTERVAL = 3000;

// Configurable delay before navigating to cart/checkout after clicking "Add to Cart"
const CART_DELAY_MS = 2000;

// Corrected math calculation for interval range
const getRandomInterval = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Helper function to record success to a file
function logSuccessToFile(workerId, name, url) {
  const successRecord = {
    workerId,
    name,
    url,
    timestamp: new Date().toISOString()
  };

  const fileName = 'success.json';
  let existingRecords = [];

  try {
    if (fs.existsSync(fileName)) {
      const fileData = fs.readFileSync(fileName, 'utf8');
      existingRecords = JSON.parse(fileData);
    }
  } catch (err) {
    console.warn(`[Warning] Could not read existing ${fileName}, starting a fresh list.`);
  }

  existingRecords.push(successRecord);

  try {
    fs.writeFileSync(fileName, JSON.stringify(existingRecords, null, 2), 'utf8');
    console.log(`[Worker #${workerId}] Success record saved to ${fileName}`);
  } catch (err) {
    console.error(`[Worker #${workerId}] Failed to write success record to file:`, err.message);
  }
}

async function monitorProduct({
  context,
  url,
  name,
  workerId,
  addToCartSelector,
  checkoutSelector,
  manualCartUrl
}) {
  // Reuse the existing browser context to open a new tab for each worker
  const page = await context.newPage();

  let attemptCount = 0;

  while (true) {
    try {
      attemptCount++;
      console.log(`[Worker #${workerId} (${name}) | Attempt #${attemptCount}] Checking: ${url}`);
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      let addToCartBtn = await page.$(addToCartSelector);

      if (addToCartBtn) {
        const isDisabled = await addToCartBtn.isDisabled();
        const buttonText = await addToCartBtn.textContent();
        const className = (await addToCartBtn.getAttribute('class')) || '';

        if (!isDisabled && !buttonText.toLowerCase().includes('sold out') && !className.includes('disabled')) {
          console.log(`[Worker #${workerId} (${name})][SUCCESS] Item available! Clicking add to cart...`);
          
          // --- MESSAGING SUCCESS TO CONSOLE ---
          console.log(`\n========================================`);
          console.log(`🎉 SUCCESSFUL ITEM SECURED!`);
          console.log(`- Worker ID: #${workerId}`);
          console.log(`- Product Name: ${name}`);
          console.log(`- Product URL: ${url}`);
          console.log(`========================================\n`);

          // --- SAVE SUCCESS TO FILE ---
          logSuccessToFile(workerId, name, url);

          await addToCartBtn.click();
          
          // --- WAITING CONFIGURABLE TIME BEFORE CART NAVIGATION ---
          if (CART_DELAY_MS > 0) {
            console.log(`[Worker #${workerId}] Waiting ${CART_DELAY_MS}ms before proceeding to cart...`);
            await page.waitForTimeout(CART_DELAY_MS);
          }
          // --------------------------------------------------------

          // --- UPDATED CHECKOUT LOGIC ---
          if (manualCartUrl) {
            console.log(`[Worker #${workerId}] Navigating directly to manual cart URL: ${manualCartUrl}`);
            await page.goto(manualCartUrl, { waitUntil: 'domcontentloaded' });
          } else if (checkoutSelector) {
            try {
              console.log(`[Worker #${workerId}] Waiting for checkout button...`);
              const checkoutLink = await page.waitForSelector(checkoutSelector, { timeout: 5000 });
              if (checkoutLink) {
                console.log(`[Worker #${workerId}] Clicking checkout element...`);
                await checkoutLink.click();
              }
            } catch (checkoutErr) {
              console.log(`[Worker #${workerId}] Checkout element not found. Leaving on page.`);
            }
          }
          // ------------------------------

          console.log(`[Worker #${workerId}] SUCCESS! Item added. Playing alarm...`);

          // Fixed audio syntaxes (restored missing '*' arithmetic operators)
          await page.evaluate(() => {
            try {
              const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
              for (let i = 0; i < 3; i++) {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = "sine";
                osc.frequency.value = 880;
                gain.gain.setValueAtTime(0.5, audioCtx.currentTime + (i * 0.2));
                gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + (i * 0.2) + 0.15);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(audioCtx.currentTime + (i * 0.2));
                osc.stop(audioCtx.currentTime + (i * 0.2) + 0.15);
              }
            } catch (e) {
              console.warn("Audio error:", e);
            }
          });

          console.log(`[Worker #${workerId}] Item secured! Pausing this worker.`);
          await new Promise(() => {}); // Keep tab open
        } else {
          console.log(`[Worker #${workerId} (${name})][SOLD OUT / DISABLED]`);
        }
      } else {
        console.log(`[Worker #${workerId} (${name})][SOLD OUT] Add to cart button not found`);
      }

    } catch (err) {
      console.error(`[Worker #${workerId} (${name})] Error:`, err.message);
    }

    const delay = getRandomInterval(MIN_INTERVAL, MAX_INTERVAL);
    console.log(`[Worker #${workerId}] Waiting ${(delay / 1000).toFixed(1)}s before refresh...`);
    await page.waitForTimeout(delay);
  }
}

async function runAll() {
  console.log(`Connecting to remote Chrome via CDP...`);
  
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const defaultContext = browser.contexts()[0];

    console.log(`Connected! Launching ${sites.length} monitoring workers across separate tabs...`);

    await Promise.all(
      sites.map((site, index) => 
        monitorProduct({
          context: defaultContext,
          ...site,
          workerId: index + 1
        })
      )
    );
  } catch (err) {
    console.error("Connection failed. Make sure Chrome is running with remote debugging port 9222 enabled.", err.message);
  }
}

runAll();