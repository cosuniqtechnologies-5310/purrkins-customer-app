import { fetch } from "undici";
import * as fs from "fs";

async function run() {
  const toml = fs.readFileSync("shopify.app.toml", "utf8");
  // Just use the store URL
  const shop = "purrkins-mhrlfymw.myshopify.com";
  const accessToken = process.env.SHOPIFY_API_KEY; // Wait, we need an access token!
}
run();
