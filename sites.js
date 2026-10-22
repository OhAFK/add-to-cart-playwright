// sites.js
module.exports = [
  {
    name: "Farmers - 30th bundle",
    url: "https://www.farmers.co.nz/toys/games-cards-puzzles/pokemon-trading-card-30th-booster-bundle-7064593",
    addToCartSelector: 'button[data-testing-id="addToCartButton"]',
    checkoutSelector: 'a.btn.btn-primary[href*="/cart"]',
    manualCartUrl: "https://www.farmers.co.nz/cart"
  },
  {
    name: "Farmers - 30th tin",
    url: "https://www.farmers.co.nz/toys/games-cards-puzzles/pokemon-trading-card-30th-mini-tin-assorrted-7064592",
    addToCartSelector: 'button[data-testing-id="addToCartButton"]',
    checkoutSelector: 'a.btn.btn-primary[href*="/cart"]',
    manualCartUrl: "https://www.farmers.co.nz/cart"
  },
  // {
  //   name: "JB Hi-Fi - Apple TV 4K 64GB",
  //   url: "https://www.jbhifi.co.nz/products/apple-tv-4k-wi-fi-64gb-2022",
  //   addToCartSelector: 'button[data-testid="add-to-cart-button"]',
  //   checkoutSelector: null, // Leaves worker on page after adding to cart
  //   manualCartUrl: "https://www.jbhifi.co.nz/cart"
  // }
];