// Paste into the DevTools console on any farmers.co.nz page (same-origin so cookies are sent).
// Stop early with: stopLoop()

(() => {
  const SKUS = ["7064593", "7064592"]; // Add your multiple SKUs here
  const QTY = 1;
  const INTERVAL = 2000; // 2000ms = 2 seconds between attempts
  const MAX_TRIES = 200; // 0 = run until stopped
  const STOP_ON_ADD = true; // stop looping for a SKU once it's in the cart

  const URL =
    "https://www.farmers.co.nz/INTERSHOP/web/WFS/Farmers-Shop-Site/en_NZ/-/NZD/ViewExpressShop-AddProduct";

  let tries = 0;
  let timer = null;
  const ts = () => new Date().toLocaleTimeString();

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
    let allAdded = true;

    for (let i = 0; i < SKUS.length; i++) {
      const sku = SKUS[i];
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
          if (STOP_ON_ADD) {
            // Remove successfully added SKU from the array so we don't keep requesting it
            SKUS.splice(i, 1);
            i--;
          }
        } else if (result.status === "SOLD OUT") {
          allAdded = false;
          console.log(
            "[" +
              ts() +
              "] #" +
              tries +
              " SKU " +
              sku +
              " [SOLD OUT] " +
              result.msg,
          );
        } else {
          allAdded = false;
          console.warn(
            "[" +
              ts() +
              "] #" +
              tries +
              " SKU " +
              sku +
              " [UNKNOWN] (HTTP " +
              res.status +
              ")",
            result.msg,
          );
        }
      } catch (err) {
        allAdded = false;
        console.error(
          "[" + ts() + "] #" + tries + " SKU " + sku + " [REQUEST FAILED]",
          err.message,
        );
      }
    }

    // If all SKUs have been successfully added and removed from the list, stop the loop
    if (SKUS.length === 0) {
      return stop("all SKUs added to cart");
    }

    if (MAX_TRIES && tries >= MAX_TRIES) return stop("max tries reached");
    timer = setTimeout(attempt, INTERVAL);
  }

  function stop(reason) {
    clearTimeout(timer);
    console.log(
      "[" + ts() + "] loop stopped - " + reason + " (" + tries + " attempts)",
    );
  }

  window.stopLoop = () => stop("manual stop");
  console.log(
    "Starting add-to-cart loop for SKUs: " +
      SKUS.join(", ") +
      " every " +
      INTERVAL / 1000 +
      "s. Call stopLoop() to cancel.",
  );
  attempt();
})();
