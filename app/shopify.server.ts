import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "c48f3f570d623330d23274556ccc823f",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "c48f3f570d623330d23274556ccc823f",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES
    ? process.env.SCOPES.split(",")
    : [
        "write_products",
        "write_customers",
        "write_metaobjects",
        "read_metaobject_definitions",
        "read_files",
        "write_files",
        "read_orders",
        "write_own_subscription_contracts",
        "read_own_subscription_contracts",
        "read_customer_payment_methods",
        "write_purchase_options",
        "read_purchase_options",
      ],
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
