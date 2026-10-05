import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  
  // Note: the shop is automatically appended to proxy requests by Shopify.
  const shop = url.searchParams.get("shop") || "purrkins.myshopify.com";

  try {
    const reviews = await prisma.review.findMany({
      where: {
        shop,
        ...(productId ? { productId } : {}),
        status: "published"
      },
      orderBy: { createdAt: "desc" }
    });

    // Calculate average rating for the whole shop or specific product
    const stats = await prisma.review.aggregate({
      where: { shop, ...(productId ? { productId } : {}), status: "published" },
      _avg: { rating: true },
      _count: { id: true }
    });

    return {
      reviews,
      averageRating: stats._avg.rating || 0,
      totalCount: stats._count.id || 0
    };
  } catch (err) {
    console.error("Failed to load reviews", err);
    return Response.json({ error: "Failed to load reviews", details: (err as Error).message }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const formData = await request.formData();
  const productId = formData.get("productId")?.toString();
  const rating = Number(formData.get("rating"));
  const title = formData.get("title")?.toString() || "";
  const body = formData.get("body")?.toString() || "";
  const author = formData.get("author")?.toString() || "Anonymous";
  const email = formData.get("email")?.toString() || "";
  
  // Parse images array if present
  const images = formData.getAll("images[]").map(img => img.toString());

  // App proxy adds shop query parameter automatically
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "purrkins.myshopify.com";

  if (!productId || !rating) {
    return Response.json({ error: "Product ID and rating are required" }, { status: 400 });
  }

  // Check auto-approve setting
  let settings = await prisma.storeSetting.findUnique({ where: { shop } });
  if (!settings) {
    settings = await prisma.storeSetting.create({ data: { shop, autoApproveReviews: true } });
  }

  try {
    const review = await prisma.review.create({
      data: {
        shop,
        productId,
        rating,
        title,
        body,
        author,
        email,
        images,
        status: "published" // Auto-approve all reviews as requested
      }
    });

    return { success: true, review };
  } catch (err) {
    console.error("Failed to create review", err);
    return Response.json({ error: "Failed to create review", details: (err as Error).message }, { status: 500 });
  }
}
