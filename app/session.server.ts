import { createCookieSessionStorage } from "react-router";

type SessionData = {
  customerId: string;
  customerEmail: string;
};

type SessionFlashData = {
  error: string;
};

export const customerSessionStorage = createCookieSessionStorage<
  SessionData,
  SessionFlashData
>({
  cookie: {
    name: "__customer_session",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [process.env.SHOPIFY_API_SECRET || "s3cr3t"],
    secure: process.env.NODE_ENV === "production",
  },
});

export const { getSession, commitSession, destroySession } = customerSessionStorage;
