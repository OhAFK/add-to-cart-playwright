// Paste into the DevTools console on any farmers.co.nz page (same-origin so cookies are sent).
// Stop early with: stopLoop()

(() => {
  const SKUS = ["7064593"]; // Add your multiple SKUs here
  const QTY = 1;

  // Randomization settings (in milliseconds)
  const MIN_INTERVAL = 200; // Minimum delay (0.2 seconds)
  const MAX_INTERVAL = 400; // Maximum delay (0.4 seconds)

  const MAX_TRIES = 200; // 0 = run until stopped
  const STOP_ON_ADD = true; // stop looping for a SKU once it's in the cart

  const URL =
    "https://www.farmers.co.nz/INTERSHOP/web/WFS/Farmers-Shop-Site/en_NZ/-/NZD/ViewExpressShop-AddProduct";

  let tries = 0;
  let timer = null;
  const ts = () => new Date().toLocaleTimeString();

  // Helper to get a random delay between MIN and MAX (Fixed operator)
  function getRandomInterval() {
    return (
      Math.floor(Math.random() * (MAX_INTERVAL - MIN_INTERVAL + 1)) +
      MIN_INTERVAL
    );
  }

  function classify(text, sku) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const modal = doc.querySelector("#add-to-cart-confirmation .modal-body");

    const successBox = modal ? modal.querySelector(".alert-success-alt") : null;
    const errorP = modal ? modal.querySelector('p[style*="B90618"]') : null;
    const dangerLi = doc.querySelector("#miniCart .alert-danger li");
    const pushedSku = new RegExp(
      '"event":\\s*"addToCart"[\\s\\S]*?"id":\\s*"' + sku + '"',
    ).test(text);
    const countEl = doc.querySelector("#mini-cart-count");
    const cartCount = countEl ? countEl.textContent.trim() : "?";

    if (successBox || pushedSku)
      return {
        status: "ADDED",
        msg: successBox ? successBox.textContent.trim() : "",
        cartCount: cartCount,
      };
    if (errorP || dangerLi)
      return {
        status: "SOLD OUT",
        msg: (errorP || dangerLi).textContent.trim(),
        cartCount: cartCount,
      };
    return { status: "UNKNOWN", msg: text.slice(0, 300), cartCount: cartCount };
  }

  async function attempt() {
    tries++;
    const startTime = performance.now();

    // Fire all SKU fetch requests in parallel using Promise.all
    const promises = SKUS.map(async (sku) => {
      const body =
        "SKU=" +
        sku +
        "&Quantity_" +
        sku +
        "=" +
        QTY +
        "&addToCartBehavior=expresscart";

      try {
        const res = await fetch(URL, {
          method: "POST",
          mode: "cors",
          credentials: "include",
          headers: {
            accept: "*/*",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
          },
          body: body,
        });

        const text = await res.text();
        const result = classify(text, sku);

        return { sku, resStatus: res.status, result };
      } catch (err) {
        return { sku, error: err.message };
      }
    });

    const outcomes = await Promise.all(promises);
    const networkDuration = ((performance.now() - startTime) / 1000).toFixed(2);

    // Process outcomes and manage successfully added SKUs
    for (const outcome of outcomes) {
      const { sku, resStatus, result, error } = outcome;
      const skuIndex = SKUS.indexOf(sku);

      if (error) {
        console.error(
          "[" + ts() + "] #" + tries + " SKU " + sku + " [REQUEST FAILED]",
          error,
        );
        continue;
      }

      if (result.status === "ADDED") {
        console.log(
          "%c[" +
            ts() +
            "] #" +
            tries +
            " SKU " +
            sku +
            " [ADDED TO CART] cart: " +
            result.cartCount,
          "color:#00b5b5;font-weight:bold",
        );
        if (STOP_ON_ADD && skuIndex > -1) {
          SKUS.splice(skuIndex, 1);
        }
      } else if (result.status === "SOLD OUT") {
        console.log(
          "[" +
            ts() +
            "] #" +
            tries +
            " SKU " +
            sku +
            " [SOLD OUT] (took " +
            networkDuration +
            "s) " +
            result.msg,
        );
      } else {
        console.warn(
          "[" +
            ts() +
            "] #" +
            tries +
            " SKU " +
            sku +
            " [UNKNOWN] (HTTP " +
            resStatus +
            ")",
          result.msg,
        );
      }
    }

    // If all SKUs have been added, stop loop
    if (SKUS.length === 0) {
      return stop("all SKUs added to cart");
    }

    if (MAX_TRIES && tries >= MAX_TRIES) return stop("max tries reached");

    // Schedule next attempt with a randomized interval
    const nextInterval = getRandomInterval();
    console.log(
      `%c[${ts()}] Next attempt in ${(nextInterval / 1000).toFixed(1)}s...`,
      "color:#888",
    );
    timer = setTimeout(attempt, nextInterval);
  }

  function stop(reason) {
    clearTimeout(timer);
    console.log(
      "[" + ts() + "] loop stopped - " + reason + " (" + tries + " attempts)",
    );
  }

  window.stopLoop = () => stop("manual stop");
  console.log(
    "Starting concurrent randomized loop for SKUs: " +
      SKUS.join(", ") +
      " (Interval: " +
      MIN_INTERVAL / 1000 +
      "s - " +
      MAX_INTERVAL / 1000 +
      "s). Call stopLoop() to cancel.",
  );
  attempt();
})();
