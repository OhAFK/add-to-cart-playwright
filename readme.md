pkill -9 Google\ Chrome

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug

cd /path/to/your/project
npm init -y
npm install playwright

node monitor.js

farmers-console-script.js

- HNF script on console

For Farmers products, `monitor.js` checks that the add-to-cart button is available,
then sends the same express-cart POST used by `farmers-console-script.js` instead
of clicking the button. The monitor only supports this Farmers POST method and
requires each active product configuration to provide `addToCartMethod: "farmers-post"`
and a SKU; it will not click the button.
The monitor logs the button state for diagnostics but attempts the POST regardless
of whether the button is disabled or visible; the Farmers response determines
whether the item was added.
The monitor only starts checks during the 35-second window around each 15-minute
boundary: from 5 seconds before to 30 seconds after (for example, 11:59:55–12:00:30).
On startup, it opens the first product URL from `sites.js` in an existing Chrome
tab (or a new tab if needed). It then checks configured product URLs one at a time
and only checks availability or sends the POST during the scheduled windows.

To open the JB Hi-Fi cart URL in the Chrome session on debugging port 9222 and
retry every 14 seconds (with a small interval variation) until a checkout control
is visible, then play a three-tone alarm and show a browser alert, run:

```sh
npm run jbhifi-cart
```
