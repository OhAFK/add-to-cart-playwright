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
of clicking the button. Other configured stores continue to use button clicks.

To open the JB Hi-Fi cart URL in the Chrome session on debugging port 9222 and
retry every 14 seconds (with a small interval variation) until a checkout control
is visible, then play a three-tone alarm and show a browser alert, run:

```sh
npm run jbhifi-cart
```
