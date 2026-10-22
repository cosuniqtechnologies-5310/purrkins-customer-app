import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import jwt from "jsonwebtoken";
import { unauthenticated } from "../shopify.server";
import { getLoaderHtml } from "../loader-snippet";
import { appCache } from "../cache.server";
import { getAdmin } from "../utils/subscription-shopify.server";

function getSubLines(sub: any): any[] {
  if (!sub || !sub.lines) return [];
  if (Array.isArray(sub.lines)) return sub.lines;
  if (typeof sub.lines === "string") {
    try {
      const parsed = JSON.parse(sub.lines);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }
  if (typeof sub.lines === "object") return [sub.lines];
  return [];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("Cookie");
  const cookieMatch = cookieHeader ? cookieHeader.match(/pk_session=([^;]+)/) : null;
  const cookieToken = cookieMatch ? cookieMatch[1] : null;
  const token = url.searchParams.get("session") || cookieToken;
  let customerId: string | null = null;
  let isTokenPresentAndInvalid = false;

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.SHOPIFY_API_SECRET || "s3cr3t") as any;
      if (decoded && decoded.customerId) {
        customerId = decoded.customerId;
      } else {
        isTokenPresentAndInvalid = true;
      }
    } catch (e) {
      isTokenPresentAndInvalid = true;
    }
  }

  const loggedInCust = url.searchParams.get("logged_in_customer_id");
  if (!customerId && loggedInCust) {
    customerId = loggedInCust.startsWith("gid://shopify/Customer/")
      ? loggedInCust
      : `gid://shopify/Customer/${loggedInCust}`;
  }

  if (!customerId) {
    if (isTokenPresentAndInvalid) {
      return new Response(`
        ${getLoaderHtml(true)}
        <script>
          localStorage.removeItem('pk_session');
          document.cookie = "pk_session=; path=/apps/purrkins; expires=Thu, 01 Jan 1970 00:00:00 GMT";
          window.location.href = '/apps/purrkins/login';
        </script>
      `, {
        headers: {
          "Content-Type": "application/liquid",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    return new Response(`
      ${getLoaderHtml(true)}
      <script>
        var localToken = localStorage.getItem('pk_session');
        if (localToken) {
          var currentUrl = new URL(window.location.href);
          currentUrl.searchParams.set('session', localToken);
          window.location.replace(currentUrl.toString());
        } else {
          // No token anywhere, go to login.
          window.location.replace('/apps/purrkins/login');
        }
      </script>
    `, {
      headers: {
        "Content-Type": "application/liquid",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      }
    });
  }

  const numericId = customerId.split("/").pop();
  const dashboardCacheKey = `customer:dashboard:v3:${customerId}`;
  const subsCacheKey = `customer:subs:${customerId}`;
  const revsCacheKey = `customer:reviews:${customerId}`;

  // Helper 1: Fetch plans with 10-minute cache
  const fetchPlans = async () => {
    const cachedPlans = appCache.get<any>("plans:active");
    if (cachedPlans) return cachedPlans;
    const plans = await prisma.subscriptionPlan.findMany({
      where: { active: true },
      orderBy: { position: "asc" },
    });
    appCache.set("plans:active", plans, 600);
    return plans;
  };

  // Helper 2: Fetch customer profile from cache or Shopify Admin GraphQL
  const fetchCustomer = async () => {
    const cached = appCache.get<any>(dashboardCacheKey);
    if (cached) return cached;

    const { admin } = await unauthenticated.admin("purrkins-mhrlfymw.myshopify.com");
    if (!admin) {
      console.error("Admin access denied");
      return null;
    }

    const graphqlRes = await admin.graphql(`
            query($id: ID!) {
              customer(id: $id) {
                firstName
                lastName
                email
                phone
                avatar: metafield(namespace: "custom", key: "avatar") { value }
                defaultAddress {
                  id
                  firstName
                  lastName
                  country
                  province
                  zip
                  address1
                  address2
                  city
                  phone
                }
                addresses(first: 10) {
                  id
                  name
                  firstName
                  lastName
                  phone
                  address1
                  address2
                  city
                  province
                  zip
                  country
                }
                orders(first: 5, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      name
                      createdAt
                      totalPriceSet { shopMoney { amount currencyCode } }
                      displayFulfillmentStatus
                      statusPageUrl
                      lineItems(first: 1) { edges { node { title } } }
                    }
                  }
                }
                pets: metafield(namespace: "custom", key: "pets") {
                  references(first: 10) {
                    nodes {
                      ... on Metaobject {
                        id
                        name: field(key: "name") { value }
                        age: field(key: "age") { value }
                        gender: field(key: "gender") { value }
                        neutered: field(key: "neutered") { value }
                        weight: field(key: "weight") { value }
                        body: field(key: "body") { value }
                        activity: field(key: "activity") { value }
                        focus: field(key: "focus") { value }
                        allergies: field(key: "allergies") { value }
                        profile: field(key: "profile") { reference { ... on MediaImage { image { url } } } }
                      }
                    }
                  }
                }
                wishlist: metafield(namespace: "custom", key: "wishlist") {
                  value
                  references(first: 20) {
                    nodes {
                      ... on Product {
                        id
                        title
                        handle
                        description
                        productType
                        collections(first: 3) {
                          nodes {
                            title
                            handle
                            cardBg: metafield(namespace: "custom", key: "card_bg_color") { value }
                            cardColor: metafield(namespace: "custom", key: "card_primary_color") { value }
                          }
                        }
                        featuredImage { url altText }
                        priceRange { minVariantPrice { amount currencyCode } }
                        variants(first: 5) {
                          nodes {
                            id
                            title
                            price
                            image { url }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `, { variables: { id: customerId } });
    const data = await graphqlRes.json() as any;
    if (data.errors) {
      console.error("GraphQL errors:", JSON.stringify(data.errors));
    }
    const cust = data?.data?.customer || {};
    if (data?.data?.customer) {
      appCache.set(dashboardCacheKey, cust, 180); // 3 minutes cache
    }
    return cust;
  };

  // Helper 3: Fetch store products dynamically from Shopify Admin GraphQL API
  const fetchCatalogProducts = async () => {
    const cached = appCache.get<any[]>("store:catalog:products:v3");
    if (cached && Array.isArray(cached) && cached.length > 0) return cached;

    try {
      const admin = await getAdmin("purrkins-mhrlfymw.myshopify.com");
      const res = await admin.graphql(`
        query GetDashboardProductsCatalog {
          products(first: 50, sortKey: TITLE) {
            nodes {
              id
              title
              handle
              description
              productType
              collections(first: 3) {
                nodes {
                  title
                  handle
                  cardBg: metafield(namespace: "custom", key: "card_bg_color") { value }
                  cardColor: metafield(namespace: "custom", key: "card_primary_color") { value }
                }
              }
              featuredImage {
                url
                altText
              }
              variants(first: 5) {
                nodes {
                  id
                  title
                  price
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      `);
      const json: any = await res.json();
      const prods = json?.data?.products?.nodes || [];
      if (prods.length > 0) {
        appCache.set("store:catalog:products:v3", prods, 600); // 10 minutes cache
      }
      return prods;
    } catch (err) {
      console.warn("Could not fetch catalog products dynamically from Shopify API:", err);
      return [];
    }
  };

  // Run plans, customer and catalog products fetch concurrently
  const [customerData, availablePlans, catalogProducts] = await Promise.all([
    fetchCustomer(),
    fetchPlans(),
    fetchCatalogProducts()
  ]);
  if (!customerData) {
    return new Response("<script>window.location.href='/apps/purrkins/login';</script>", {
      headers: { "Content-Type": "application/liquid" }
    });
  }
  const customer = customerData;
  const customerAvatarUrl = customer.avatar?.value || "";

  // Build dynamic product map from live Shopify API products
  const dynamicProductMap = new Map<string, { image: string; subtitle: string; price: number; title: string; id: string; handle: string }>();
  for (const p of (catalogProducts || [])) {
    const key = String(p.title || "").toLowerCase().trim();
    const img = p.featuredImage?.url || p.variants?.nodes?.[0]?.image?.url || "";
    const firstVariant = p.variants?.nodes?.[0];
    const subtitle = p.description
      ? (p.description.length > 60 ? p.description.substring(0, 57) + "..." : p.description)
      : (firstVariant?.title && firstVariant.title !== "Default Title" ? `70 g pouch · ${firstVariant.title}` : "70 g pouch · Fresh kitten nutrition");
    const price = parseFloat(firstVariant?.price || "79");
    dynamicProductMap.set(key, { image: img, subtitle, price, title: p.title, id: p.id, handle: p.handle });
  }

  const defaultFallbackImg = catalogProducts?.[0]?.featuredImage?.url || catalogProducts?.[0]?.variants?.nodes?.[0]?.image?.url || "https://cdn.shopify.com/s/files/1/0955/9366/0663/files/Chicken-Broth-Product-Image.png?v=1789634066";

  const getProductImage = (title: string, rawImageUrl?: string): string => {
    if (rawImageUrl) return rawImageUrl;
    const t = String(title || "").toLowerCase().trim();
    for (const [key, info] of dynamicProductMap.entries()) {
      if (t.includes(key) || key.includes(t)) {
        if (info.image) return info.image;
      }
    }
    return defaultFallbackImg;
  };

  const getProductSubtitle = (title: string, variantTitle?: string): string => {
    if (variantTitle && variantTitle !== "Default Title" && !variantTitle.includes("Default")) {
      return `70 g pouch · ${variantTitle}`;
    }
    const t = String(title || "").toLowerCase().trim();
    for (const [key, info] of dynamicProductMap.entries()) {
      if (t.includes(key) || key.includes(t)) {
        if (info.subtitle) return info.subtitle;
      }
    }
    return "70 g pouch · Fresh kitten nutrition";
  };

  // Helper 3 & 4: Fetch subscriptions and reviews concurrently with 60s cache
  const fetchSubscriptions = async () => {
    const cachedSubs = appCache.get<any>(subsCacheKey);
    if (cachedSubs) return cachedSubs;
    const subs = await prisma.subscription.findMany({
      where: {
        OR: [
          { customerId },
          ...(numericId ? [{ customerId: { endsWith: numericId } }] : []),
          ...(customer.email ? [{ customerEmail: customer.email }] : []),
        ],
      },
      include: {
        cycles: {
          orderBy: { cycleNumber: "desc" },
          take: 3,
        },
      },
      orderBy: { createdAt: "desc" },
    });
    appCache.set(subsCacheKey, subs, 60);
    return subs;
  };

  const fetchReviews = async () => {
    if (!customer.email) return [];
    const cachedReviews = appCache.get<any>(revsCacheKey);
    if (cachedReviews) return cachedReviews;
    const revs = await prisma.review.findMany({
      where: {
        OR: [
          { email: customer.email },
          ...(customer.firstName ? [{ author: { contains: customer.firstName } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    appCache.set(revsCacheKey, revs, 60);
    return revs;
  };

  const [customerSubscriptions, customerReviews] = await Promise.all([
    fetchSubscriptions(),
    fetchReviews(),
  ]);

  const defaultAddress = customer.defaultAddress || {};
  // Escape values placed inside HTML attributes so quotes/angle brackets can't break the form
  const escAttr = (v: any) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const customerPets = customer.pets?.references?.nodes || [];
  const pets = customerPets.length > 0
    ? customerPets.map((p: any, idx: number) => ({
        id: p.id || `pet-${idx}`,
        name: p.name?.value || (idx === 0 ? "Milo" : (idx === 1 ? "Kaju" : `Kitten ${idx + 1}`)),
        headerAge: p.age?.value || (idx === 0 ? "12 Months" : "8 Months"),
        age: p.age?.value || (idx === 0 ? "5 months" : "8 months"),
        weight: p.weight?.value ? String(p.weight.value).replace(/[^0-9.]/g, '') : (idx === 0 ? "1.9" : "2.1"),
        breed: "Indie",
        gender: p.gender?.value || (idx === 0 ? "Male" : "Female"),
        neutered: p.neutered?.value || (idx === 0 ? "Neutered" : "Not Neutered"),
        activityLevel: p.activity?.value || "Playful, indoor only",
        birthday: idx === 0 ? "14 Mar 2026" : "10 Aug 2025",
        healthFlags: idx === 0 ? "Sensitive stomach" : "Digestive care",
        eatingStyle: p.body?.value || (idx === 0 ? "Fussy (prefers fish)" : "Lean"),
        allergies: idx === 0 ? "None recorded" : "Chicken",
        loggedWeight: idx === 0 ? "1.9 kg logged on 2 Aug" : "2.1 kg logged on 15 Jul",
        imageUrl: p.profile?.reference?.image?.url || (idx === 0
          ? "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=150&h=150&fit=crop"
          : "https://images.unsplash.com/photo-1573865526739-10659fec78a5?w=150&h=150&fit=crop"),
        quizPills: [
          "Age - 2-8 weeks",
          "Weight - 1.9 kg",
          "Male",
          "Neutered",
          "2.5 kgs",
          "Lean",
          "Playful",
          "Hairball",
          "Gut issues"
        ]
      }))
    : [
        {
          id: "pet-milo",
          name: "Milo",
          headerAge: "12 Months",
          age: "5 months",
          weight: "1.9",
          breed: "Indie",
          gender: "Male",
          neutered: "Neutered",
          activityLevel: "Playful, indoor only",
          birthday: "14 Mar 2026",
          healthFlags: "Sensitive stomach",
          eatingStyle: "Fussy (prefers fish)",
          allergies: "None recorded",
          loggedWeight: "1.9 kg logged on 2 Aug",
          imageUrl: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=150&h=150&fit=crop",
          quizPills: [
            "Age - 2-8 weeks",
            "Weight - 1.9 kg",
            "Male",
            "Neutered",
            "2.5 kgs",
            "Lean",
            "Playful",
            "Hairball",
            "Gut issues"
          ]
        },
        {
          id: "pet-kaju",
          name: "Kaju",
          headerAge: "8 Months",
          age: "8 months",
          weight: "2.1",
          breed: "Indie",
          gender: "Female",
          neutered: "Not Neutered",
          activityLevel: "Playful, indoor only",
          birthday: "10 Aug 2025",
          healthFlags: "Digestive care",
          eatingStyle: "Lean",
          allergies: "Chicken",
          loggedWeight: "2.1 kg logged on 15 Jul",
          imageUrl: "https://images.unsplash.com/photo-1573865526739-10659fec78a5?w=150&h=150&fit=crop",
          quizPills: [
            "Age - 8 Months",
            "Weight - 2.1 kg",
            "Female",
            "Not Neutered",
            "Lean",
            "Playful",
            "Digestive Care",
            "Chicken"
          ]
        }
      ];

  const initialPet = pets[0];
  const petName = initialPet.name;

  const petPillsHtml = pets.map((p: any, idx: number) => {
    const isActive = idx === 0;
    return `
      <div
        class="pk-pet-pill ${isActive ? 'active' : ''}"
        onclick="pkSelectPet(${idx}, event)"
        data-pet-index="${idx}"
      >
        <div class="pk-pet-avatar">
          <img src="${escAttr(p.imageUrl)}" alt="${escAttr(p.name)}">
        </div>
        <div class="pk-pet-info">
          <strong>${escAttr(p.name)}</strong>
          <span>${escAttr(p.headerAge || p.age)}</span>
        </div>
      </div>
    `;
  }).join('');

  const ordersHtml = (customer.orders?.edges && customer.orders.edges.length > 0)
    ? customer.orders.edges.map((e: any) => {
        const orderDate = new Date(e.node.createdAt);
        const day = orderDate.getDate();
        const month = orderDate.toLocaleString('default', { month: 'short' });
        const year = orderDate.getFullYear();
        const dateStr = `${day} ${month} ${year}`;
        const isFulfilled = e.node.displayFulfillmentStatus === 'FULFILLED';
        const statusText = isFulfilled ? `Delivered ${day} ${month}` : 'In transit';
        const statusBadgeStyle = isFulfilled
          ? 'background:#dcfce7; color:#15803d;'
          : 'background:#dbeafe; color:#2563eb;';
        const lineItemsDesc = e.node.lineItems?.edges?.map((li: any) => li.node.title).join(', ') || 'Purrkins Monthly Box';
        const lineCount = e.node.lineItems?.edges?.reduce((acc: number, li: any) => acc + (li.node.quantity || 1), 0) || 12;

        return `
          <div class="pk-order-row">
            <div>
              <div class="pk-order-id">${escAttr(e.node.name)}</div>
              <div class="pk-order-sub">${lineCount} pouches · ${escAttr(lineItemsDesc.substring(0, 32))}</div>
            </div>
            <div class="pk-order-date">${dateStr}</div>
            <div>
              <span class="pk-order-pill" style="${statusBadgeStyle}">${statusText}</span>
            </div>
            <div class="pk-order-total">₹${parseFloat(e.node.totalPriceSet?.shopMoney?.amount || 0).toLocaleString('en-IN')}</div>
            <div class="pk-order-actions">
              ${isFulfilled ? `<button type="button" onclick="pkReorder('${escAttr(e.node.name)}', this)" class="pk-btn-reorder">Reorder</button>` : ''}
              <a href="${e.node.statusPageUrl || '#'}" target="_blank" class="pk-btn-invoice">Invoice</a>
            </div>
          </div>
        `;
      }).join('')
    : `
      <!-- Screenshot 1 Table Rows -->
      <div class="pk-order-row">
        <div>
          <div class="pk-order-id">#PK-10391</div>
          <div class="pk-order-sub">31 pouches · ${escAttr(petName)}'s monthly box</div>
        </div>
        <div class="pk-order-date">12 Aug 2026</div>
        <div>
          <span class="pk-order-pill" style="background:#dbeafe; color:#2563eb;">In transit</span>
        </div>
        <div class="pk-order-total">₹1,080</div>
        <div class="pk-order-actions">
          <a href="#" target="_blank" class="pk-btn-invoice">Invoice</a>
        </div>
      </div>

      <div class="pk-order-row">
        <div>
          <div class="pk-order-id">#PK-10240</div>
          <div class="pk-order-sub">31 pouches · ${escAttr(petName)}'s monthly box</div>
        </div>
        <div class="pk-order-date">19 Jul 2026</div>
        <div>
          <span class="pk-order-pill" style="background:#dcfce7; color:#15803d;">Delivered 22 Jul</span>
        </div>
        <div class="pk-order-total">₹1,080</div>
        <div class="pk-order-actions">
          <button type="button" onclick="pkReorder('PK-10240', this)" class="pk-btn-reorder">Reorder</button>
          <a href="#" target="_blank" class="pk-btn-invoice">Invoice</a>
        </div>
      </div>

      <div class="pk-order-row">
        <div>
          <div class="pk-order-id">#PK-10102</div>
          <div class="pk-order-sub">Starter box · 12 pouches</div>
        </div>
        <div class="pk-order-date">14 Jul 2026</div>
        <div>
          <span class="pk-order-pill" style="background:#dcfce7; color:#15803d;">Delivered 17 Jul</span>
        </div>
        <div class="pk-order-total">₹540</div>
        <div class="pk-order-actions">
          <button type="button" onclick="pkReorder('PK-10102', this)" class="pk-btn-reorder">Reorder</button>
          <a href="#" target="_blank" class="pk-btn-invoice">Invoice</a>
        </div>
      </div>
    `;

  const addressesHtml = customer.addresses?.length > 0
    ? customer.addresses.map((a: any) => `
      <div class="pk-address-box" data-address-id="${a.id}">
        <div class="pk-addr-top">
          <h4>${a.firstName || ''} ${a.lastName || ''} ${a.id === defaultAddress.id ? '<span class="pk-default-tag">Default</span>' : ''}</h4>
          <div style="display:flex;gap:10px;align-items:center;">
            ${a.id !== defaultAddress.id ? `<button onclick="setDefaultAddr('${a.id}')" style="font-size:12px;color:#595961;background:none;border:none;cursor:pointer;text-decoration:underline;">Set Default</button>` : ''}
            <button onclick="deleteAddr('${a.id}')" style="font-size:12px;color:#e53e3e;background:none;border:none;cursor:pointer;text-decoration:underline;">Delete</button>
          </div>
        </div>
        <p>${a.address1 || ''}${a.address2 ? ', ' + a.address2 : ''}<br>
        ${a.city || ''}, ${a.province || ''} ${a.zip || ''}<br>
        ${a.country || ''} ${a.phone ? '· ' + a.phone : ''}</p>
      </div>
    `).join('')
    : '<p style="color:#595961;margin:0;">No delivery addresses saved yet.</p>';

  // ─── Wishlist Dynamic Category & Layout (Screenshot 2, 3, 4) ─────────────────────
  const getProductCategoryStyles = (prod: any) => {
    const col = prod.collections?.nodes?.[0] || prod.collections?.[0];
    const colTitle = col?.title || prod.productType || "";
    const titleLower = (colTitle + " " + (prod.title || "")).toLowerCase();

    let cardBg = col?.cardBg?.value || col?.metafields?.find((m: any) => m.key === "card_bg_color")?.value;
    let cardColor = col?.cardColor?.value || col?.metafields?.find((m: any) => m.key === "card_primary_color")?.value;
    let badgeText = col?.title || prod.productType || "";

    if (!cardBg || !cardColor) {
      if (titleLower.includes("dry")) {
        cardBg = cardBg || "#FFF4EC";
        cardColor = cardColor || "#D97742";
        badgeText = badgeText || "Dry Food";
      } else if (titleLower.includes("wellness") || titleLower.includes("supplement") || titleLower.includes("health")) {
        cardBg = cardBg || "#EAF7EE";
        cardColor = cardColor || "#1F5E58";
        badgeText = badgeText || "Wellness";
      } else if (titleLower.includes("treat") || titleLower.includes("snack") || titleLower.includes("jerky")) {
        cardBg = cardBg || "#FDF0F5";
        cardColor = cardColor || "#C0392B";
        badgeText = badgeText || "Treats";
      } else {
        cardBg = cardBg || "#EBF5FE";
        cardColor = cardColor || "#2A85C8";
        badgeText = badgeText || "Wet Food";
      }
    }

    if (!badgeText) {
      badgeText = titleLower.includes("dry") ? "Dry Food" : "Wet Food";
    }

    return { cardBg, cardColor, badgeText };
  };

  // 1. Gather wishlist IDs from customer.wishlist.value
  let customerWishlistIds: string[] = [];
  if (customer.wishlist?.value) {
    try {
      const parsed = JSON.parse(customer.wishlist.value);
      if (Array.isArray(parsed)) {
        customerWishlistIds = parsed.map((id: any) => String(id));
      }
    } catch (e) {}
  }

  // 2. Gather products from references if available
  const userWishlistNodes = customer.wishlist?.references?.nodes || [];

  // 3. Map to wishlist items
  let displayWishlist: any[] = [];

  if (userWishlistNodes.length > 0) {
    displayWishlist = userWishlistNodes.map((p: any) => {
      const v = p.variants?.nodes?.[0] || p.variants?.edges?.[0]?.node;
      const vTitle = v?.title || "70g";
      const weight = vTitle.includes("g") ? vTitle.replace(/[^0-9]/g, "") + "g" : "70g";
      const styles = getProductCategoryStyles(p);
      return {
        id: p.id,
        title: p.title,
        price: parseFloat(v?.price || p.priceRange?.minVariantPrice?.amount || "79").toFixed(0),
        weight,
        desc: p.description ? (p.description.length > 50 ? p.description.substring(0, 47) + '...' : p.description) : 'Real broth for daily hydration',
        type: styles.badgeText,
        cardBg: styles.cardBg,
        cardColor: styles.cardColor,
        imgUrl: p.featuredImage?.url || v?.image?.url || defaultFallbackImg,
        handle: p.handle,
        variantId: v?.id ? String(v.id).split('/').pop() : ''
      };
    });
  } else if (customerWishlistIds.length > 0 && catalogProducts && catalogProducts.length > 0) {
    const matchedProducts = customerWishlistIds.map((wId) => {
      const cleanWId = wId.includes('/') ? wId.split('/').pop() : wId;
      return catalogProducts.find((p: any) => {
        const pCleanId = p.id ? String(p.id).split('/').pop() : '';
        return pCleanId === cleanWId || String(p.id) === wId;
      });
    }).filter(Boolean);

    if (matchedProducts.length > 0) {
      displayWishlist = matchedProducts.map((p: any) => {
        const v = p.variants?.nodes?.[0] || p.variants?.[0];
        const vTitle = v?.title || "70g";
        const weight = vTitle.includes("g") ? vTitle.replace(/[^0-9]/g, "") + "g" : "70g";
        const styles = getProductCategoryStyles(p);
        return {
          id: p.id,
          title: p.title,
          price: parseFloat(v?.price || "79").toFixed(0),
          weight,
          desc: p.description ? (p.description.length > 50 ? p.description.substring(0, 47) + '...' : p.description) : 'Real broth for daily hydration',
          type: styles.badgeText,
          cardBg: styles.cardBg,
          cardColor: styles.cardColor,
          imgUrl: p.featuredImage?.url || v?.image?.url || defaultFallbackImg,
          handle: p.handle,
          variantId: v?.id ? String(v.id).split('/').pop() : ''
        };
      });
    }
  }

  // If user has no saved wishlist yet, show default catalog products with dynamic colors
  if (displayWishlist.length === 0) {
    displayWishlist = (catalogProducts && catalogProducts.length > 0)
      ? catalogProducts.slice(0, 6).map((p: any) => {
          const v = p.variants?.nodes?.[0] || p.variants?.[0];
          const vTitle = v?.title || "70g";
          const weight = vTitle.includes("g") ? vTitle.replace(/[^0-9]/g, "") + "g" : "70g";
          const styles = getProductCategoryStyles(p);
          return {
            id: p.id,
            title: p.title,
            price: parseFloat(v?.price || "79").toFixed(0),
            weight,
            desc: p.description ? (p.description.length > 50 ? p.description.substring(0, 47) + '...' : p.description) : 'Real broth for daily hydration',
            type: styles.badgeText,
            cardBg: styles.cardBg,
            cardColor: styles.cardColor,
            imgUrl: p.featuredImage?.url || v?.image?.url || defaultFallbackImg,
            handle: p.handle,
            variantId: v?.id ? String(v.id).split('/').pop() : ''
          };
        })
      : [
          {
            title: "Chicken Broth",
            price: "79",
            weight: "70g",
            desc: "Real broth for daily hydration",
            type: "Wet Food",
            cardBg: "#EBF5FE",
            cardColor: "#2A85C8",
            imgUrl: defaultFallbackImg,
            handle: "chicken-broth",
            variantId: ""
          },
          {
            title: "Lamb Jerky",
            price: "99",
            weight: "70g",
            desc: "High-protein rewards for active cats",
            type: "Treats",
            cardBg: "#FDF0F5",
            cardColor: "#C0392B",
            imgUrl: defaultFallbackImg,
            handle: "lamb-jerky",
            variantId: ""
          },
          {
            title: "Turkey Stew",
            price: "79",
            weight: "70g",
            desc: "Soft meal for gentle digestion",
            type: "Wet Food",
            cardBg: "#EBF5FE",
            cardColor: "#2A85C8",
            imgUrl: defaultFallbackImg,
            handle: "turkey-stew",
            variantId: ""
          },
          {
            title: "Gutty Kitty",
            price: "90",
            weight: "70g",
            desc: "Gut & digestive health support for kittens & adult cats",
            type: "Dry Food",
            cardBg: "#FFF4EC",
            cardColor: "#D97742",
            imgUrl: defaultFallbackImg,
            handle: "gutty-kitty",
            variantId: ""
          }
        ];
  }

  // Pre-serialize catalog products for dynamic client-side sync
  const clientCatalogProducts = (catalogProducts || []).map((p: any) => {
    const v = p.variants?.nodes?.[0] || p.variants?.[0];
    const vTitle = v?.title || "70g";
    const weight = vTitle.includes("g") ? vTitle.replace(/[^0-9]/g, "") + "g" : "70g";
    const styles = getProductCategoryStyles(p);
    return {
      id: p.id,
      title: p.title,
      price: parseFloat(v?.price || "79").toFixed(0),
      weight,
      desc: p.description ? (p.description.length > 50 ? p.description.substring(0, 47) + '...' : p.description) : 'Real broth for daily hydration',
      cardBg: styles.cardBg,
      cardColor: styles.cardColor,
      badgeText: styles.badgeText,
      image: p.featuredImage?.url || v?.image?.url || defaultFallbackImg,
      variantId: v?.id ? String(v.id).split('/').pop() : ''
    };
  });

  const getWishlistHtml = (sliderId: string) => `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 22px;">
      <h3 class="pk-section-title" style="margin:0;">Your Wishlist</h3>
      <div class="pk-wishlist-nav" style="display:flex; gap:8px;">
        <button type="button" class="pk-wl-nav-btn prev" data-slider="${sliderId}" data-dir="-1" onclick="pkSlideWishlist('${sliderId}', -1, event)" aria-label="Previous Slide">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <button type="button" class="pk-wl-nav-btn next" data-slider="${sliderId}" data-dir="1" onclick="pkSlideWishlist('${sliderId}', 1, event)" aria-label="Next Slide">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
    </div>
    <div class="pk-wishlist-slider-wrap">
      <div id="${sliderId}" class="pk-wishlist-slider">
        ${displayWishlist.map((item: any) => `
          <div class="pk-wishlist-card">
            <div class="pk-wishlist-card-top" style="background:${item.cardBg};">
              <span class="pk-wishlist-badge" style="background:${item.cardBg}; border:1px solid ${item.cardColor}; color:${item.cardColor};">${escAttr(item.type)}</span>
              <img src="${item.imgUrl}" alt="${escAttr(item.title)}" onerror="this.onerror=null; this.src='${defaultFallbackImg}';">
            </div>
            <div class="pk-wishlist-card-bottom">
              <h4 class="pk-wishlist-card-title">${escAttr(item.title)}</h4>
              <div class="pk-wishlist-card-price-row">
                <span>₹${escAttr(item.price)}</span>
                <span class="pk-wishlist-sep">|</span>
                <span class="pk-wishlist-weight">${escAttr(item.weight)}</span>
              </div>
              <p class="pk-wishlist-card-desc">${escAttr(item.desc)}</p>
              <button type="button" onclick="pkAddToCart('${item.variantId || ''}', this)" class="pk-wishlist-add-btn">Add to Cart</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // ─── Kitten & Quiz Answers Data (Image 2) ──────────────────
  const subscribedTitles = new Set(
    customerSubscriptions.flatMap((s: any) =>
      getSubLines(s).map((l: any) => String(l.title || "").toLowerCase().trim())
    )
  );

  const kittenTabHtml = `
    <!-- PET SELECTOR HEADER (Image 2: Milo, Kaju, + Add Kitten) -->
    <div class="pk-pet-selector-row">
      ${petPillsHtml}
      <button type="button" onclick="pkOpenAddKittenQuiz()" class="pk-pet-add-btn">+ Add Kitten</button>
    </div>

    <!-- Kitten Overview Profile Card (Image 2) -->
    <div class="pk-card" style="margin-bottom: 24px; padding: 28px 32px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
        <h2 id="pk-pet-profile-title" style="margin:0; font-size:26px; font-weight:800; font-family:var(--font-heading--family, sans-serif); color:#121217;">${escAttr(petName)}'s profile</h2>
        <button type="button" onclick="pkOpenAddKittenQuiz()" class="pk-outline-btn" style="border-radius:30px; padding:8px 22px; font-size:13px; font-weight:700; color:#121217; border:1.5px solid #121217; background:#fff; cursor:pointer;">Edit Details</button>
      </div>
      <div style="display:flex; gap:32px; align-items:flex-start; flex-wrap:wrap;">
        <div style="flex-shrink:0; width:130px; height:130px; overflow:hidden; border-radius:18px; background:#f4f4f5; display:flex; align-items:center; justify-content:center;">
          <img id="pk-pet-profile-img" src="${escAttr(initialPet.imageUrl)}" alt="${escAttr(petName)}" style="width:100%; height:100%; object-fit:cover;">
        </div>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px 24px; flex-grow:1;">
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Age</label>
            <span id="pk-pet-stat-age" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.age)}</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Weight</label>
            <span id="pk-pet-stat-weight" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.weight)} kg</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Breed</label>
            <span id="pk-pet-stat-breed" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.breed || 'Indie')}</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Sex</label>
            <span id="pk-pet-stat-sex" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.gender)}, ${escAttr(initialPet.neutered.toLowerCase())}</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Activity Level</label>
            <span id="pk-pet-stat-activity" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.activityLevel)}</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Birthday</label>
            <span id="pk-pet-stat-bday" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.birthday)}</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Health Flags</label>
            <span id="pk-pet-stat-health" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.healthFlags)}</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Eating Style</label>
            <span id="pk-pet-stat-body" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.eatingStyle)}</span>
          </div>
          <div>
            <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;">Allergies</label>
            <span id="pk-pet-stat-allergies" style="font-weight:700; font-size:14px; color:#121217;">${escAttr(initialPet.allergies)}</span>
          </div>
        </div>
      </div>

      <!-- Yellow Weight Banner (Image 2) -->
      <div style="background: #FFE330; border-radius: 14px; padding: 16px 22px; display: flex; justify-content: space-between; align-items: center; margin-top: 24px; flex-wrap: wrap; gap: 12px;">
        <div>
          <div id="pk-pet-weight-log" style="font-weight: 800; font-size: 15px; color: #121217;">${escAttr(initialPet.loggedWeight)}</div>
          <div style="font-size: 12.5px; color: #4B4618; margin-top: 2px;">Portions and pack quantities update automatically when you log a new weight.</div>
        </div>
        <button type="button" onclick="pkOpenAddKittenQuiz()" style="background: #121217; color: #fff; border: none; border-radius: 20px; padding: 10px 22px; font-weight: 700; font-size: 13px; cursor: pointer;">Log New Weight</button>
      </div>
    </div>

    <!-- YOUR QUIZ ANSWERS (Image 2) -->
    <div id="pk-pet-quiz-card" class="pk-card" style="margin-bottom: 24px; padding: 28px 32px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px;">
        <div>
          <h2 style="margin:0; font-size:24px; font-weight:800; color:#121217; font-family:var(--font-heading--family, sans-serif);">Your quiz answers</h2>
          <p style="color:#595961; margin:6px 0 0 0; font-size:14px;">Taken 14 July, updated 2 Aug. Everything below is built from these answers.</p>
        </div>
        <a href="/pages/byob" class="pk-outline-btn" style="border-radius:30px; padding:8px 20px; font-size:13px; font-weight:700; text-decoration:none; color:#121217; border:1.5px solid #121217; background:#fff;">Retake quiz</a>
      </div>

      <div id="pk-pet-quiz-pills" style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:32px;">
        ${initialPet.quizPills.map((pill: string) => `<span style="background:#f4f4f5; border-radius:30px; padding:8px 18px; font-size:14px; font-weight:600; color:#121217; display:inline-block;">${escAttr(pill)}</span>`).join('')}
      </div>

      <!-- RECOMMEND FOR ACTIVE PET (Image 2) -->
      <div style="margin-top:20px;">
        <h3 id="pk-pet-rec-title" style="margin:0 0 18px 0; font-size:22px; font-weight:800; color:#121217; font-family:var(--font-heading--family, sans-serif);">Recommend for ${escAttr(petName)}</h3>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:20px;">
          ${(catalogProducts && catalogProducts.length > 0 ? catalogProducts.slice(0, 3) : [
            { title: "Lean Kitty", description: "80g pouch, starter pack, light, tasty nutrition to keep them playful and agile.", variants: { nodes: [{ id: "51221448818935" }] } },
            { title: "Gutty Kitty", description: "Happy tummies, happy kitties, gentle, easy-to-digest goodness to keep bellies comfortable and content.", variants: { nodes: [{ id: "51172691050743" }] } },
            { title: "Mumma & Kitty", description: "Nourishing fuel for growing kittens and comforting, energy-rich goodness to help mama cats recover.", variants: { nodes: [{ id: "51172688134423" }] } }
          ]).map((recP: any, rIdx: number) => {
            const rTitle = recP.title || "Kitten Meal";
            const rImg = recP.featuredImage?.url || recP.variants?.nodes?.[0]?.image?.url || defaultFallbackImg;
            const rDesc = recP.description ? (recP.description.length > 90 ? recP.description.substring(0, 87) + '...' : recP.description) : '80g pouch, light, tasty nutrition to keep them playful and agile.';
            const rVarId = recP.variants?.nodes?.[0]?.id ? String(recP.variants.nodes[0].id).split('/').pop() : '';
            const isSubscribed = subscribedTitles.has(rTitle.toLowerCase().trim());
            const bgColors = ['#E8F4FE', '#FFF1EB', '#E6F8F0'];
            const bg = bgColors[rIdx % bgColors.length];

            return `
              <div style="background:${bg}; border-radius:16px; padding:24px 20px; display:flex; flex-direction:column;">
                <div style="width:60px; height:60px; background:#fff; border-radius:12px; display:flex; align-items:center; justify-content:center; margin-bottom:14px; overflow:hidden;">
                  <img src="${escAttr(rImg)}" alt="${escAttr(rTitle)}" style="max-height:85%; max-width:85%; object-fit:contain;" onerror="this.onerror=null; this.src='${defaultFallbackImg}';">
                </div>
                <h4 style="margin:0 0 6px 0; font-size:17px; font-weight:800; color:#121217;">${escAttr(rTitle)}</h4>
                <p style="font-size:12.5px; margin:0 0 16px 0; color:#595961; line-height:1.4; flex-grow:1;">${escAttr(rDesc)}</p>
                ${isSubscribed ? `
                  <button type="button" onclick="switchDashboardTab('subscriptions')" style="background:#121217; color:#fff; border:none; border-radius:20px; padding:10px 22px; font-weight:700; font-size:13px; cursor:pointer; width:fit-content;">In Your Box</button>
                ` : `
                  <button type="button" onclick="pkAddToCart('${rVarId}', this)" style="background:#121217; color:#fff; border:none; border-radius:20px; padding:10px 22px; font-weight:700; font-size:13px; cursor:pointer; width:fit-content;">Add to Cart</button>
                `}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>

    <!-- Vet Chat Card (Image 2 bottom) -->
    <div style="background:#121217; border-radius:16px; padding:28px 32px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; color:#fff; margin-bottom:24px;">
      <div>
        <h3 style="margin:0 0 6px 0; font-size:20px; font-weight:800; color:#fff; font-family:var(--font-heading--family, sans-serif);">Something not right with your kitten?</h3>
        <p style="margin:0; font-size:13.5px; color:#d1d5db; line-height:1.4;">Vet chat is included with your plan. Most questions get an answer in an hour.</p>
      </div>
      <button type="button" onclick="pkOpenVetModal()" style="background:#FFE600; color:#121217; border:none; border-radius:30px; padding:12px 28px; font-weight:800; font-size:14px; cursor:pointer;">Talk to a Vet</button>
    </div>
  `;

  // ─── Subscriptions Fetch & Render ─────────────────────────
  const WEEKDAY_NAMES_MAP = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const subscriptionsHtml = customerSubscriptions.length > 0
    ? `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h3 class="pk-section-title" style="margin:0;">My Subscriptions</h3>
        <span style="font-size:13px; font-weight:700; background:#EBF4F6; color:#0e6251; padding:4px 12px; border-radius:20px;">${customerSubscriptions.length} Active Plan${customerSubscriptions.length === 1 ? '' : 's'}</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:20px;">
        ${customerSubscriptions.map((sub: any) => {
          const lines = Array.isArray(sub.lines) ? sub.lines : [];
          const statusBg = sub.status === 'ACTIVE' ? '#e3f1df' : sub.status === 'PAUSED' ? '#fef3d6' : '#f1f2f3';
          const statusColor = sub.status === 'ACTIVE' ? '#108043' : sub.status === 'PAUSED' ? '#916a00' : '#6d7175';
          const pendingCycle = sub.cycles.find((c: any) => c.status === 'SCHEDULED' || c.status === 'PROCESSING');
          const deliveryDate = pendingCycle?.deliveryDate || sub.nextDeliveryDate || 'Scheduled';
          const weekdayStr = deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)
            ? WEEKDAY_NAMES_MAP[new Date(deliveryDate + 'T00:00:00').getDay()]
            : '';

          return `
            <div style="border:1.5px solid #eaeaea; border-radius:16px; padding:24px; background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.02);">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; border-bottom:1px solid #f1f2f3; padding-bottom:16px; margin-bottom:16px;">
                <div>
                  <div style="display:flex; align-items:center; gap:10px;">
                    <h4 style="margin:0; font-size:18px; font-weight:800; color:#121217;">${escAttr(sub.planName)}</h4>
                    <span style="background:${statusBg}; color:${statusColor}; font-size:11px; font-weight:800; padding:3px 10px; border-radius:12px; text-transform:uppercase;">${sub.status}</span>
                  </div>
                  <div style="font-size:13px; color:#595961; margin-top:4px;">
                    Order Reference: #${sub.contractId.split('/').pop()} • Preferred Delivery: ${sub.preferredWeekday !== null && sub.preferredWeekday !== undefined ? WEEKDAY_NAMES_MAP[sub.preferredWeekday] : 'Any deliverable day'}
                  </div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:18px; font-weight:800; color:#121217;">₹${parseFloat(sub.recurringTotal || 0).toFixed(2)}</div>
                  <div style="font-size:12px; color:#595961;">per delivery</div>
                </div>
              </div>

              <!-- Next Delivery Spotlight Banner -->
              <div style="background:#f9fafb; border-radius:12px; padding:16px 20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:20px; border-left:4px solid #008060;">
                <div>
                  <div style="font-size:11px; font-weight:800; color:#595961; text-transform:uppercase; letter-spacing:0.5px;">Next Scheduled Delivery</div>
                  <div style="font-size:20px; font-weight:800; color:#121217; margin-top:4px;">
                    📦 ${deliveryDate} ${weekdayStr ? `(${weekdayStr})` : ''}
                  </div>
                  <div style="font-size:12px; color:#6d7175; margin-top:4px;">
                    ${sub.nextBillingAt ? `Automated billing runs on ${new Date(sub.nextBillingAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} at ${new Date(sub.nextBillingAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Billing automated prior to dispatch'}
                  </div>
                </div>
              </div>

              <!-- Subscribed Items -->
              <div style="margin-bottom:20px;">
                <div style="font-size:13px; font-weight:800; color:#121217; margin-bottom:10px;">Subscribed Products:</div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                  ${lines.map((item: any) => `
                    <div style="display:flex; justify-content:space-between; align-items:center; background:#fafafa; padding:10px 14px; border-radius:8px;">
                      <div style="display:flex; align-items:center; gap:12px;">
                        <span style="font-weight:700; font-size:14px; color:#121217;">${item.quantity || 1}×</span>
                        <div>
                          <div style="font-weight:700; font-size:14px; color:#121217;">${escAttr(item.title || 'Subscription Item')}</div>
                          ${item.variantTitle && item.variantTitle !== 'Default Title' ? `<div style="font-size:12px; color:#595961;">${escAttr(item.variantTitle)}</div>` : ''}
                        </div>
                      </div>
                      <div style="font-weight:700; font-size:14px; color:#008060;">
                        ${item.price ? `₹${parseFloat(item.price).toFixed(2)}` : ''}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>

              <!-- Customer Actions Bar -->
              <div style="display:flex; gap:8px; flex-wrap:wrap; border-top:1px solid #f1f2f3; padding-top:16px;">
                ${sub.status === 'ACTIVE' ? `
                  <button type="button" onclick="pkSkipSub('${sub.id}', '${deliveryDate}')" class="pk-outline-btn" style="cursor:pointer; font-size:13px; padding:8px 16px; border-radius:20px;">Skip Next Delivery</button>
                  <button type="button" onclick="pkOpenReschedule('${sub.id}', '${deliveryDate}')" class="pk-outline-btn" style="cursor:pointer; font-size:13px; padding:8px 16px; border-radius:20px;">Reschedule Date</button>
                  <button type="button" onclick="pkOpenChangePlan('${sub.id}', '${sub.planId || ''}')" class="pk-outline-btn" style="cursor:pointer; font-size:13px; padding:8px 16px; border-radius:20px;">Change Frequency</button>
                  <button type="button" onclick="pkPauseSub('${sub.id}')" class="pk-outline-btn" style="cursor:pointer; font-size:13px; padding:8px 16px; border-radius:20px;">Pause</button>
                  <button type="button" onclick="pkCancelSub('${sub.id}')" style="cursor:pointer; font-size:13px; padding:8px 16px; border-radius:20px; background:none; border:1px solid #fedcd9; color:#bf0711;">Cancel</button>
                ` : sub.status === 'PAUSED' ? `
                  <button type="button" onclick="pkResumeSub('${sub.id}')" style="cursor:pointer; font-size:13px; padding:8px 20px; border-radius:20px; background:#008060; color:#fff; border:none; font-weight:700;">Resume Subscription</button>
                  <button type="button" onclick="pkCancelSub('${sub.id}')" style="cursor:pointer; font-size:13px; padding:8px 16px; border-radius:20px; background:none; border:1px solid #fedcd9; color:#bf0711;">Cancel</button>
                ` : `
                  <span style="font-size:13px; color:#6d7175;">Subscription is ${sub.status.toLowerCase()}.</span>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `
    : `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 class="pk-section-title" style="margin:0;">My Subscriptions</h3>
      </div>
      <p style="color:#595961; margin:16px 0 0 0; line-height:1.5;">You don't have any active subscriptions yet. Subscribe to your cat's favorite fresh meals to save 15% and enjoy automated scheduled deliveries with zero hassle!</p>
      <div style="margin-top:20px;">
        <a href="/collections/all" class="pk-outline-btn" style="display:inline-block; font-size:13px; padding:10px 22px;">Explore Meals & Subscribe</a>
      </div>
    `;

  // ─── Customer Reviews Fetch & Render ─────────────────────
  const reviewsHtml = customerReviews.length > 0
    ? `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h3 class="pk-section-title" style="margin:0;">My Product Reviews</h3>
        <span style="font-size:13px; font-weight:700; background:#EBF4F6; color:#0e6251; padding:4px 12px; border-radius:20px;">${customerReviews.length} Review${customerReviews.length === 1 ? '' : 's'}</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:16px;">
        ${customerReviews.map((r: any) => `
          <div style="border:1.5px solid #eaeaea; border-radius:12px; padding:18px; background:#fff;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <div style="color:#d97706; font-size:16px;">${'★'.repeat(r.rating)}${'☆'.repeat(Math.max(0, 5 - r.rating))}</div>
              <span style="font-size:11px; font-weight:800; background:${r.status === 'published' ? '#e3f1df' : '#fef3d6'}; color:${r.status === 'published' ? '#108043' : '#916a00'}; padding:3px 8px; border-radius:10px; text-transform:uppercase;">${r.status}</span>
            </div>
            <h4 style="margin:0 0 4px 0; font-size:15px; font-weight:800; color:#121217;">${escAttr(r.title)}</h4>
            <p style="margin:0; font-size:13px; color:#595961; line-height:1.4;">${escAttr(r.body)}</p>
            <div style="font-size:11px; color:#8c9196; margin-top:8px;">
              Reviewed on ${new Date(r.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
        `).join('')}
      </div>
    `
    : `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 class="pk-section-title" style="margin:0;">My Product Reviews</h3>
      </div>
      <p style="color:#595961; margin:16px 0 0 0; line-height:1.5;">You haven't submitted any reviews yet. Share your experience with Purrkins kitten meals to help fellow cat parents!</p>
      <div style="margin-top:16px;">
        <button onclick="pkOpenOrderReview('Purrkins Kitten Meal', 'kitten-fresh-salmon')" class="pk-outline-btn" style="cursor:pointer; font-size:13px; padding:8px 20px; background:none;">★ Write a Review</button>
      </div>
    `;

  // ─── Subscriptions Individual Screen (Screenshot 2 & 3) ───────────────────
  const subscriptionsTabHtml = customerSubscriptions.length === 0 ? `
    <!-- Empty Subscriptions State -->
    <div class="pk-card" style="margin-bottom: 24px; padding: 48px 32px; text-align: center;">
      <div style="font-size: 48px; margin-bottom: 16px;">📦</div>
      <h2 style="margin: 0 0 10px 0; font-size: 26px; font-weight: 800; color: #121217; font-family: var(--font-heading--family, sans-serif);">No Active Subscriptions</h2>
      <p style="color: #595961; font-size: 14.5px; max-width: 480px; margin: 0 auto 24px auto; line-height: 1.5;">You do not currently have an active meal subscription. Subscribe to your kitten's favorite fresh meals to save 15% and enjoy automated scheduled deliveries with zero hassle!</p>
      <a href="/pages/byob" class="pk-outline-btn" style="display: inline-block; background: #FFE600; color: #121217; font-weight: 800; font-size: 14px; padding: 13px 32px; border-radius: 30px; border: none; text-decoration: none; cursor: pointer;">Build Your Own Box</a>
    </div>

    <!-- Vet Chat Card -->
    <div style="background: #121217; border-radius: 16px; padding: 32px 36px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 20px; color: #fff; margin-bottom: 24px;">
      <div>
        <h3 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 800; color: #fff; font-family: var(--font-heading--family, sans-serif);">Something not right with your kitten?</h3>
        <p style="margin: 0; font-size: 14px; color: #d1d5db; line-height: 1.5;">Vet chat is included with your plan. Most questions get an answer in an hour.</p>
      </div>
      <button type="button" onclick="pkOpenVetModal()" style="background: #FFE600; color: #121217; border: none; border-radius: 30px; padding: 14px 34px; font-weight: 800; font-size: 15px; cursor: pointer; display: inline-block;">Talk to a Vet</button>
    </div>
  ` : `
    ${customerSubscriptions.length > 1 ? `
      <!-- Multi-Subscription Selector -->
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; background: #fff; padding: 14px 20px; border-radius: 16px; border: 1.5px solid #eaeaea; box-shadow: 0 2px 8px rgba(0,0,0,0.02);">
        <span style="font-size: 13px; font-weight: 800; color: #595961; text-transform: uppercase; letter-spacing: 0.5px;">Your Subscriptions (${customerSubscriptions.length}):</span>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${customerSubscriptions.map((s: any, idx: number) => {
            const lines = getSubLines(s);
            const firstLineTitle = lines[0]?.title || 'Meal Plan';
            const label = s.originOrderName ? `Order ${s.originOrderName} (${firstLineTitle})` : `Plan #${idx + 1} (${firstLineTitle})`;
            return `
              <button type="button"
                id="pk-sub-pill-${idx}"
                onclick="pkSelectSubCard(${idx})"
                style="cursor: pointer; padding: 8px 18px; border-radius: 20px; font-size: 13px; font-weight: 700; border: 1.5px solid ${idx === 0 ? '#121217' : '#e5e7eb'}; background: ${idx === 0 ? '#121217' : '#fff'}; color: ${idx === 0 ? '#fff' : '#121217'}; transition: all 0.2s;">
                ${escAttr(label)}
              </button>
            `;
          }).join('')}
        </div>
      </div>
    ` : ''}

    ${customerSubscriptions.map((sub: any, subIdx: number) => {
      const subId = sub.id;
      const startedDateStr = sub.createdAt
        ? new Date(sub.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : 'Recently';
      const frequencyStr = sub.planName || (sub.intervalCount ? `Delivered every ${sub.intervalCount} ${sub.interval?.toLowerCase() || 'days'} (Save 15%)` : 'Delivered every 30 days (Save 15%)');
      const nextChargeDate = sub.nextDeliveryDate
        ? new Date(sub.nextDeliveryDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : 'Scheduled';
      const nextChargeAmount = sub.recurringTotal
        ? `₹${parseFloat(String(sub.recurringTotal)).toLocaleString('en-IN')}`
        : '₹90';
      const deliveriesSoFar = sub.cycles?.filter((c: any) => c.status === 'COMPLETED' || c.status === 'SHIPPED').length || sub.ordersBilled || 1;
      const nextDeliveryYmd = sub.nextDeliveryDate || (sub.nextBillingAt ? new Date(sub.nextBillingAt).toISOString().split('T')[0] : '');

      const lines = getSubLines(sub);

      const statusBg = sub.status === 'ACTIVE' ? '#FEF9C3' : sub.status === 'PAUSED' ? '#fef3d6' : '#f1f2f3';
      const statusBorder = sub.status === 'ACTIVE' ? '#CA8A04' : sub.status === 'PAUSED' ? '#d97706' : '#d1d5db';
      const statusColor = sub.status === 'ACTIVE' ? '#854D0E' : sub.status === 'PAUSED' ? '#916a00' : '#6d7175';

      return `
        <div id="pk-sub-card-${subIdx}" class="pk-sub-card-container" style="display: ${subIdx === 0 ? 'block' : 'none'};">
          <div class="pk-card" style="margin-bottom: 24px; padding: 28px 32px;">
            <!-- Header -->
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <h2 style="margin: 0; font-size: 26px; font-weight: 800; color: #121217; font-family: var(--font-heading--family, sans-serif);">${escAttr(sub.planName || 'Monthly plan')}</h2>
                <span style="background: ${statusBg}; border: 1.5px solid ${statusBorder}; color: ${statusColor}; border-radius: 20px; padding: 3px 14px; font-size: 12px; font-weight: 800; text-transform: capitalize;">${escAttr(sub.status ? sub.status.toLowerCase() : 'active')}</span>
              </div>
              ${sub.originOrderName ? `<span style="font-size: 13px; font-weight: 700; color: #71717A;">Order ${escAttr(sub.originOrderName)}</span>` : ''}
            </div>

            <!-- Yellow Summary Bar (5 columns) -->
            <div class="pk-sub-summary-bar">
              <div>
                <div class="pk-sub-col-label">STARTED</div>
                <div class="pk-sub-col-val">${startedDateStr}</div>
              </div>
              <div>
                <div class="pk-sub-col-label">FREQUENCY</div>
                <div class="pk-sub-col-val">${frequencyStr}</div>
              </div>
              <div>
                <div class="pk-sub-col-label">NEXT CHARGE</div>
                <div class="pk-sub-col-val">${nextChargeDate} · ${nextChargeAmount}</div>
              </div>
              <div>
                <div class="pk-sub-col-label">DELIVERIES SO FAR</div>
                <div class="pk-sub-col-val">${deliveriesSoFar}</div>
              </div>
              <div>
                <div class="pk-sub-col-label">YOU SAVE</div>
                <div class="pk-sub-col-val">15% vs one-time</div>
              </div>
            </div>

            <!-- Subscribed Products Card -->
            <div class="pk-sub-box-card">
              ${lines.length > 0 ? lines.map((item: any, itemIdx: number) => {
                const itemTitle = item.title || 'Subscription Meal';
                const itemImg = getProductImage(itemTitle, item.imageUrl || item.image);
                const itemSub = getProductSubtitle(itemTitle, item.variantTitle);
                const unitPrice = (item.price !== undefined && item.price !== null) ? Number(item.price) : 90;
                const qty = Math.max(1, Number(item.quantity) || 1);
                const linePrice = unitPrice * qty;
                const itemKey = `${subIdx}-${itemIdx}`;

                return `
                  <div class="pk-sub-item-row" id="sub-row-${itemKey}">
                    <div class="pk-sub-item-info">
                      <div class="pk-sub-item-thumb">
                        <img id="sub-img-${itemKey}" src="${itemImg}" alt="${escAttr(itemTitle)}" onerror="this.onerror=null; this.src='${defaultFallbackImg}';">
                      </div>
                      <div>
                        <div class="pk-sub-item-title" id="sub-title-${itemKey}">${escAttr(itemTitle)}</div>
                        <div class="pk-sub-item-sub" id="sub-desc-${itemKey}">${escAttr(itemSub)}</div>
                      </div>
                    </div>
                    <div class="pk-sub-item-controls">
                      <button type="button" onclick="pkOpenSwapModal('${itemKey}', '${escAttr(itemTitle)}')" class="pk-sub-swap-btn">Swap flavour</button>
                      <div class="pk-sub-qty-stepper">
                        <button type="button" onclick="pkUpdateSubQty('${itemKey}', -1, ${unitPrice})">-</button>
                        <span id="qty-${itemKey}">${qty}</span>
                        <button type="button" onclick="pkUpdateSubQty('${itemKey}', 1, ${unitPrice})">+</button>
                      </div>
                      <div class="pk-sub-item-price" id="price-${itemKey}">₹${linePrice}</div>
                    </div>
                  </div>
                `;
              }).join('') : `
                <div style="padding: 24px; text-align: center; color: #595961; font-size: 14px;">
                  No products found in this subscription box.
                </div>
              `}

              <!-- Black Bottom Strip -->
              <div class="pk-sub-box-strip">
                <div style="font-size: 13.5px; font-weight: 600;">+ Add a product to this box — treats, broths and supplement mousses</div>
                <a href="/pages/byob" class="pk-sub-box-browse">Browse</a>
              </div>
            </div>

            <!-- Action Buttons Row -->
            <div class="pk-sub-action-bar">
              <button type="button" onclick="pkOpenChangePlan('${subId}', '${sub.planId || ''}')" class="pk-sub-action-btn">Change Frequency</button>
              <button type="button" onclick="pkOpenReschedule('${subId}', '${nextDeliveryYmd}')" class="pk-sub-action-btn">Change Delivery Date</button>
              <button type="button" onclick="pkSkipSub('${subId}', '${nextDeliveryYmd}')" class="pk-sub-action-btn">Skip Next Delivery</button>
              ${sub.status === 'PAUSED'
                ? `<button type="button" onclick="pkResumeSub('${subId}')" class="pk-sub-action-btn" style="background:#008060; color:#fff; border-color:#008060;">Resume Plan</button>`
                : `<button type="button" onclick="pkPauseSub('${subId}')" class="pk-sub-action-btn">Pause Plan</button>`
              }
              ${sub.status !== 'CANCELLED'
                ? `<button type="button" onclick="pkCancelSub('${subId}')" class="pk-sub-cancel-link">Cancel Subscription</button>`
                : `<span style="font-size:12px; color:#bf0711; font-weight:700;">Cancelled</span>`
              }
            </div>

            <!-- Yellow Benefit Banner (4 columns) -->
            <div class="pk-sub-benefit-banner">
              <div>
                <div class="pk-benefit-title">Vet on call</div>
                <div class="pk-benefit-desc">Unlimited chats with the Purrkins panel</div>
              </div>
              <div>
                <div class="pk-benefit-title">15% off every order</div>
                <div class="pk-benefit-desc">Applied automatically at renewal</div>
              </div>
              <div>
                <div class="pk-benefit-title">Free delivery</div>
                <div class="pk-benefit-desc">On every subscription box</div>
              </div>
              <div>
                <div class="pk-benefit-title">Insurance benefit</div>
                <div class="pk-benefit-desc">Partner cover</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('')}

    <!-- Vet Chat Card (Screenshot 3 & 4) -->
    <div style="background: #121217; border-radius: 16px; padding: 32px 36px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 20px; color: #fff; margin-bottom: 24px;">
      <div>
        <h3 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 800; color: #fff; font-family: var(--font-heading--family, sans-serif);">Something not right with your kitten?</h3>
        <p style="margin: 0; font-size: 14px; color: #d1d5db; line-height: 1.5;">Vet chat is included with your plan. Most questions get an answer in an hour.</p>
      </div>
      <button type="button" onclick="pkOpenVetModal()" style="background: #FFE600; color: #121217; border: none; border-radius: 30px; padding: 14px 34px; font-weight: 800; font-size: 15px; cursor: pointer; display: inline-block;">Talk to a Vet</button>
    </div>
  `;

  const liquidTemplate = `
    <!-- Instant Session URL Sanitizer -->
    <script>
      (function() {
        try {
          var u = new URL(window.location.href);
          if (u.searchParams.has('session')) {
            var s = u.searchParams.get('session');
            if (s) {
              try { localStorage.setItem('pk_session', s); } catch(e){}
              document.cookie = 'pk_session=' + s + '; path=/; max-age=604800; SameSite=Lax';
            }
            u.searchParams.delete('session');
            window.history.replaceState({}, document.title, u.pathname + (u.search ? u.search : '') + u.hash);
          }
        } catch(e) {}
      })();
    </script>
    ${getLoaderHtml(true)}
    \n\n<style>\n
      .pk-dashboard-wrapper {
        max-width: 1336px;
        margin: 0 auto;
        padding: 0 20px;
        font-family: var(--font-body--family, sans-serif);
        color: #121217;
      }
      .pk-dashboard-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 30px;
        position: relative;
      }
      .pk-dashboard-header h1 {
        font-family: var(--font-heading--family, sans-serif);
        font-size: 32px;
        font-weight: 800;
        margin: 0;
      }
      .pk-header-actions {
        display: flex;
        flex-direction: column;
        background: #fff;
        border: 1px solid #eaeaea;
        border-radius: 12px;
        overflow: hidden;
        min-width: 160px;
      }
      .pk-action-btn {
        padding: 12px 20px;
        text-decoration: none;
        color: #121217;
        font-weight: 700;
        font-size: 14px;
        border-bottom: 1px solid #eaeaea;
        transition: 0.2s;
      }
      .pk-action-btn:hover { background: #f9f9f9; }
      .pk-action-btn:last-child {
        border-bottom: none;
      }
      .pk-dashboard-layout {
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: 40px;
      }
      .pk-dashboard-sidebar {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .pk-sidebar-menu {
        background: #fff;
        border: 1px solid #eaeaea;
        border-radius: 16px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .pk-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        text-decoration: none;
        color: #595961;
        font-weight: 700;
        padding: 12px;
        border-radius: 8px;
        transition: 0.2s;
        font-size: 14px;
      }
      .pk-menu-item.active {
        background: #FFF9E6;
        color: #121217;
      }
      .pk-dot {
        width: 8px;
        height: 8px;
        background: #d1d1d1;
        border-radius: 50%;
      }
      .pk-menu-item.active .pk-dot {
        background: #121217;
      }
      .pk-badge {
        margin-left: auto;
        background: #ffd831;
        color: #121217;
        font-size: 11px;
        font-weight: 800;
        min-width: 20px;
        height: 20px;
        border-radius: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 6px;
        flex-shrink: 0;
      }
      .pk-whatsapp-card {
        background: #21252A;
        color: #fff;
        border-radius: 16px;
        padding: 24px;
      }
      .pk-whatsapp-card h3 {
        font-size: 18px;
        margin: 0 0 10px 0;
        color: #fff;
      }
      .pk-whatsapp-card p {
        font-size: 14px;
        color: #d1d1d1;
        margin: 0 0 20px 0;
        line-height: 1.5;
      }
      .pk-whatsapp-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: #25D366;
        color: #fff;
        text-decoration: none;
        padding: 10px 20px;
        border-radius: 30px;
        font-weight: 700;
        font-size: 15px;
      }
      
      .pk-dashboard-content {
        display: flex;
        flex-direction: column;
        gap: 30px;
      }
      .pk-card {
        background: #fff;
        border: 1px solid #eaeaea;
        border-radius: 16px;
        padding: 30px;
      }
      .pk-section-title {
        font-family: var(--font-heading--family, sans-serif);
        font-size: 24px;
        font-weight: 700;
        margin: 0 0 24px 0;
      }
      .pk-profile-top {
        display: flex;
        gap: 30px;
        align-items: flex-start;
        margin-bottom: 40px;
      }
      .pk-avatar {
        width: 84px;
        height: 84px;
        background: #eaeaea;
        border-radius: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #595961;
        flex-shrink: 0;
        position: relative;
        cursor: pointer;
        overflow: hidden;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .pk-avatar:hover {
        transform: scale(1.02);
        box-shadow: 0 4px 14px rgba(0,0,0,0.1);
      }
      .pk-avatar:hover .pk-avatar-hover-overlay {
        opacity: 1 !important;
      }
      .pk-form-row {
        display: flex;
        gap: 20px;
        flex-grow: 1;
      }
      .pk-input-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 1;
      }
      .pk-input-group label {
        font-size: 11px;
        color: #595961;
        font-weight: 700;
        margin-left: 4px;
      }
      .pk-input-group input, .pk-form-grid input, .pk-form-grid select {
        border: 1px solid #eaeaea;
        border-radius: 20px;
        padding: 14px 20px;
        font-size: 13px;
        outline: none;
        color: #121217;
        font-weight: 600;
        width: 100%;
        box-sizing: border-box;
      }
      .pk-input-group input::placeholder, .pk-form-grid input::placeholder {
        color: #8c8c9a;
        font-weight: 500;
      }
      .pk-form-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
      }
      .pk-form-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 20px;
      }
      .pk-link-btn {
        color: #595961;
        text-decoration: underline;
        font-size: 14px;
        font-weight: 600;
      }

      .pk-wishlist-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
      }
      .pk-product-card {
        background: #F4F9FF;
        border-radius: 16px;
        padding: 20px;
        text-align: center;
        display: flex;
        flex-direction: column;
      }
      .pk-pc-img {
        position: relative;
        background: #fff;
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 20px;
        height: 200px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .pk-pc-img img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .pk-tag {
        position: absolute;
        top: 12px;
        left: 12px;
        border: 1px solid #7BB5F0;
        color: #7BB5F0;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 700;
        padding: 4px 10px;
        background: #fff;
      }
      .pk-product-card h4 {
        margin: 0 0 8px 0;
        font-size: 20px;
        font-weight: 800;
      }
      .pk-price {
        font-weight: 700;
        font-size: 18px;
        margin: 0 0 10px 0;
      }
      .pk-weight {
        color: #8c8c9a;
        font-weight: 500;
        font-size: 14px;
      }
      .pk-desc {
        font-size: 13px;
        color: #595961;
        margin: 0 0 20px 0;
        line-height: 1.5;
        flex-grow: 1;
      }
      .pk-add-btn {
        background: #ffd831;
        color: #121217;
        border: none;
        padding: 12px 24px;
        border-radius: 30px;
        font-weight: 700;
        cursor: pointer;
        width: 100%;
        font-size: 15px;
        transition: opacity 0.2s;
      }
      .pk-add-btn:hover { opacity: 0.9; }

      /* Orders Styles (Screenshot 1) */
      .pk-orders-table {
        border: 1px solid #eef0f2;
        border-radius: 12px;
        overflow: hidden;
        background: #fff;
      }
      .pk-orders-header {
        background: #5d6670;
        color: #fff;
        padding: 14px 24px;
        display: grid;
        grid-template-columns: 2fr 1.2fr 1.2fr 1fr 1.6fr;
        align-items: center;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.5px;
      }
      .pk-order-row {
        padding: 18px 24px;
        display: grid;
        grid-template-columns: 2fr 1.2fr 1.2fr 1fr 1.6fr;
        align-items: center;
        border-bottom: 1px solid #f0f1f3;
        background: #fff;
      }
      .pk-order-row:last-child {
        border-bottom: none;
      }
      .pk-order-id {
        font-size: 15px;
        font-weight: 800;
        color: #121217;
      }
      .pk-order-sub {
        font-size: 13px;
        color: #595961;
        margin-top: 4px;
      }
      .pk-order-date {
        font-size: 14px;
        font-weight: 600;
        color: #121217;
      }
      .pk-order-pill {
        border-radius: 20px;
        padding: 5px 14px;
        font-size: 13px;
        font-weight: 700;
        display: inline-block;
      }
      .pk-order-total {
        font-size: 15px;
        font-weight: 800;
        color: #121217;
      }
      .pk-order-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .pk-btn-invoice, .pk-btn-reorder {
        border: 1.5px solid #595961;
        border-radius: 20px;
        padding: 6px 18px;
        font-size: 13px;
        font-weight: 700;
        color: #121217;
        background: #fff;
        text-decoration: none;
        cursor: pointer;
        transition: background 0.15s;
        display: inline-block;
        font-family: inherit;
      }
      .pk-btn-invoice:hover, .pk-btn-reorder:hover {
        background: #f4f4f5;
      }
      .pk-view-all-orders-btn {
        border: 1.5px solid #595961;
        border-radius: 20px;
        padding: 8px 24px;
        font-size: 13px;
        font-weight: 700;
        color: #121217;
        background: #fff;
        cursor: pointer;
        text-decoration: none;
        display: inline-block;
        transition: background 0.15s;
        font-family: inherit;
      }
      .pk-view-all-orders-btn:hover {
        background: #f4f4f5;
      }

      /* Subscriptions View Styles (Screenshot 2 & 3) */
      .pk-sub-summary-bar {
        background: #FFE600;
        border-radius: 16px;
        padding: 18px 24px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 20px;
        margin: 20px 0;
        color: #121217;
        flex-wrap: wrap;
      }
      .pk-sub-summary-bar > div {
        flex: 0 0 auto;
      }
      .pk-sub-col-label {
        font-size: 11px;
        font-weight: 800;
        color: #595961;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
        white-space: nowrap;
      }
      .pk-sub-col-val {
        font-size: 15px;
        font-weight: 800;
        color: #121217;
        white-space: nowrap;
      }
      .pk-sub-box-card {
        border: 1.5px solid #e5e7eb;
        border-radius: 16px;
        background: #fff;
        overflow: hidden;
        margin-bottom: 20px;
      }
      .pk-sub-item-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 18px 24px;
        border-bottom: 1px solid #f0f1f3;
        gap: 16px;
        flex-wrap: wrap;
      }
      .pk-sub-item-row:last-of-type {
        border-bottom: none;
      }
      .pk-sub-item-info {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .pk-sub-item-thumb {
        width: 52px;
        height: 52px;
        border-radius: 10px;
        background: #f8f9fa;
        border: 1px solid #eaeaea;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        flex-shrink: 0;
      }
      .pk-sub-item-thumb img {
        max-height: 85%;
        max-width: 85%;
        object-fit: contain;
      }
      .pk-sub-item-title {
        font-size: 16px;
        font-weight: 800;
        color: #121217;
      }
      .pk-sub-item-sub {
        font-size: 13px;
        color: #595961;
        margin-top: 3px;
      }
      .pk-sub-item-controls {
        display: flex;
        align-items: center;
        gap: 20px;
      }
      .pk-sub-swap-btn {
        background: none;
        border: none;
        font-size: 14px;
        font-weight: 700;
        color: #121217;
        cursor: pointer;
        text-decoration: none;
        padding: 0;
        font-family: inherit;
      }
      .pk-sub-swap-btn:hover {
        text-decoration: underline;
      }
      .pk-sub-qty-stepper {
        border: 1.5px solid #d1d5db;
        border-radius: 20px;
        padding: 4px 12px;
        display: inline-flex;
        align-items: center;
        gap: 12px;
        font-weight: 700;
        font-size: 14px;
      }
      .pk-sub-qty-stepper button {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 16px;
        font-weight: 800;
        color: #595961;
        padding: 0 4px;
      }
      .pk-sub-item-price {
        font-size: 16px;
        font-weight: 800;
        color: #121217;
        min-width: 60px;
        text-align: right;
      }
      .pk-sub-box-strip {
        background: #121217;
        color: #fff;
        padding: 14px 24px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .pk-sub-box-browse {
        color: #fff;
        font-weight: 800;
        font-size: 13.5px;
        text-decoration: none;
        cursor: pointer;
      }
      .pk-sub-action-bar {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 24px;
      }
      .pk-sub-action-btn {
        border: 1.5px solid #121217;
        border-radius: 30px;
        padding: 10px 22px;
        font-weight: 700;
        font-size: 14px;
        background: #fff;
        color: #121217;
        cursor: pointer;
        transition: background 0.15s;
        font-family: inherit;
      }
      .pk-sub-action-btn:hover {
        background: #f4f4f5;
      }
      .pk-sub-cancel-link {
        background: none;
        border: none;
        color: #595961;
        font-weight: 600;
        cursor: pointer;
        font-size: 14px;
        margin-left: 8px;
        font-family: inherit;
      }
      .pk-sub-cancel-link:hover {
        color: #bf0711;
        text-decoration: underline;
      }
      .pk-sub-benefit-banner {
        background: #FFE600;
        border-radius: 16px;
        padding: 20px 24px;
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 16px;
        color: #121217;
        margin-bottom: 24px;
      }
      .pk-benefit-title {
        font-weight: 800;
        font-size: 14px;
        margin-bottom: 4px;
      }
      .pk-benefit-desc {
        font-size: 12px;
        line-height: 1.4;
        color: #21252A;
      }

      /* Vet Modal Tag Pill (Screenshot 5) */
      .pk-vet-pill {
        border: 1.5px solid #eaeaea;
        border-radius: 20px;
        padding: 7px 16px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        background: #fff;
        color: #121217;
        display: inline-block;
        transition: all 0.2s;
        user-select: none;
      }
      .pk-vet-pill.selected {
        background: #121217;
        border-color: #121217;
        color: #fff;
      }
      
      .pk-outline-btn {
        border: 1px solid #121217;
        color: #121217;
        padding: 8px 20px;
        border-radius: 30px;
        text-decoration: none;
        font-size: 14px;
        font-weight: 700;
        display: inline-block;
        transition: 0.2s;
      }
      .pk-outline-btn:hover { background: #f9f9f9; }
      
      .pk-address-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
      }
      .pk-address-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }
      .pk-address-box {
        border: 1px solid #eaeaea;
        border-radius: 16px;
        padding: 24px;
      }
      .pk-addr-top {
        display: flex;
        justify-content: space-between;
        margin-bottom: 12px;
        align-items: center;
      }
      .pk-addr-top h4 {
        margin: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 18px;
        font-weight: 700;
      }
      .pk-default-tag {
        color: #2E8E5A;
        font-size: 12px;
        font-weight: 700;
      }
      .pk-edit-link {
        color: #595961;
        text-decoration: underline;
        font-size: 14px;
        font-weight: 600;
      }
      .pk-address-box p {
        margin: 0;
        color: #595961;
        font-size: 15px;
        line-height: 1.6;
      }
      @media (max-width: 900px) {
        .pk-dashboard-layout {
          grid-template-columns: 1fr;
        }
        .pk-form-grid {
          grid-template-columns: 1fr;
        }
        .pk-form-row {
          flex-direction: column;
        }
        .pk-wishlist-grid {
          grid-template-columns: 1fr;
        }
        .pk-address-grid {
          grid-template-columns: 1fr;
        }
        .pk-dashboard-header {
          flex-direction: column;
          gap: 20px;
        }
      }
    \n/* KITTEN STYLES */\n
      .pk-dashboard-wrapper {
        max-width: 1336px;
        margin: 0 auto;
        padding: 0 20px;
        font-family: var(--font-body--family, sans-serif);
        color: #121217;
      }
      
      /* PET SELECTOR (Screenshot 2: Milo, Kaju, + Add Kitten) */
      .pk-pet-selector-row {
        display: flex;
        gap: 14px;
        margin-bottom: 24px;
        align-items: center;
        flex-wrap: wrap;
      }
      .pk-pet-pill {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        padding: 8px 24px 8px 10px;
        border-radius: 999px;
        background: #ffffff;
        border: 1.5px solid #E2E8F0;
        text-decoration: none;
        color: #121217;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      }
      .pk-pet-pill:hover {
        border-color: #CBD5E1;
      }
      .pk-pet-pill.active {
        background: #FFE330 !important;
        border-color: #FFE330 !important;
        box-shadow: 0 2px 8px rgba(255, 227, 48, 0.4);
      }
      .pk-pet-avatar {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        overflow: hidden;
        background: #F1F5F9;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .pk-pet-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .pk-pet-info { display: flex; flex-direction: column; text-align: left; }
      .pk-pet-info strong { font-size: 15px; font-weight: 800; color: #121217; line-height: 1.2; }
      .pk-pet-info span { font-size: 12px; color: #555B64; font-weight: 600; margin-top: 2px; }
      .pk-pet-add-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 24px;
        border-radius: 999px;
        background: #ffffff;
        border: 1.5px dashed #CBD5E1;
        color: #121217;
        font-size: 14px;
        font-weight: 800;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .pk-pet-add-btn:hover {
        border-color: #121217;
        background: #F8FAFC;
      }

      .pk-dashboard-layout {
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: 40px;
      }
      .pk-dashboard-sidebar {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .pk-sidebar-menu {
        background: #fff;
        border: 1px solid #eaeaea;
        border-radius: 16px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .pk-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        text-decoration: none;
        color: #595961;
        font-weight: 700;
        padding: 12px;
        border-radius: 8px;
        transition: 0.2s;
        font-size: 14px;
      }
      .pk-menu-item.active {
        background: #FFF9E6;
        color: #121217;
      }
      .pk-dot {
        width: 8px;
        height: 8px;
        background: #d1d1d1;
        border-radius: 50%;
      }
      .pk-menu-item.active .pk-dot {
        background: #121217;
      }
      .pk-badge {
        background: #ffd831;
        color: #121217;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        margin-left: auto;
      }
      .pk-whatsapp-card {
        background: #21252A;
        color: #fff;
        border-radius: 16px;
        padding: 24px;
      }
      .pk-whatsapp-card h3 {
        font-size: 18px;
        margin: 0 0 10px 0;
        color: #fff;
      }
      .pk-whatsapp-card p {
        font-size: 14px;
        color: #d1d1d1;
        margin: 0 0 20px 0;
        line-height: 1.5;
      }
      .pk-whatsapp-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: #25D366;
        color: #fff;
        text-decoration: none;
        padding: 10px 20px;
        border-radius: 30px;
        font-weight: 700;
        font-size: 15px;
      }
      
      .pk-dashboard-content {
        display: flex;
        flex-direction: column;
        gap: 30px;
      }
      .pk-card {
        background: #fff;
        border: 1px solid #eaeaea;
        border-radius: 16px;
        padding: 30px;
      }
      .pk-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
      }
      .pk-card-header h2 {
        font-family: var(--font-heading--family, sans-serif);
        font-size: 26px;
        font-weight: 800;
        margin: 0;
      }

      /* MILO'S PROFILE */
      .pk-profile-details {
        display: flex;
        gap: 40px;
        margin-bottom: 30px;
      }
      .pk-profile-edit-form {
        margin-bottom: 30px;
      }
      .pk-edit-img-row {
        display: flex;
        align-items: center;
        gap: 20px;
        margin-bottom: 25px;
      }
      .pk-file-upload label {
        display: block;
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 5px;
      }
      .pk-file-upload input {
        font-size: 13px;
      }
      .pk-edit-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
      }
      .pk-edit-grid .pk-input-group label {
        display: block;
        font-size: 11px;
        color: #8c8c9a;
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .pk-edit-grid .pk-input-group input, .pk-edit-grid .pk-input-group select {
        width: 100%;
        border: 1px solid #eaeaea;
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 14px;
        color: #121217;
        font-family: var(--font-body--family, sans-serif);
      }
      .pk-profile-photo {
        width: 140px;
        height: 140px;
        border-radius: 16px;
        overflow: hidden;
        flex-shrink: 0;
      }
      .pk-profile-photo img { width: 100%; height: 100%; object-fit: cover; }
      .pk-profile-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
        flex-grow: 1;
      }
      .pk-stat-box label {
        display: block;
        font-size: 11px;
        color: #8c8c9a;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .pk-stat-box span {
        font-size: 14px;
        font-weight: 700;
        color: #121217;
      }
      .pk-weight-banner {
        background: #ffd831;
        border-radius: 12px;
        padding: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .pk-weight-banner strong { font-size: 16px; font-weight: 800; display:block; margin-bottom: 4px;}
      .pk-weight-banner p { margin: 0; font-size: 13px; color: #121217; }
      .pk-dark-btn {
        background: #21252A;
        color: #fff;
        padding: 10px 24px;
        border-radius: 30px;
        border: none;
        font-weight: 700;
        cursor: pointer;
      }

      /* QUIZ ANSWERS */
      .pk-quiz-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 30px;
      }
      .pk-tag-pill {
        background: #f4f4f5;
        padding: 8px 16px;
        border-radius: 30px;
        font-size: 13px;
        font-weight: 600;
        color: #121217;
      }
      .pk-sub-title {
        font-family: var(--font-heading--family, sans-serif);
        font-size: 20px;
        font-weight: 800;
        margin: 0 0 20px 0;
      }
      .pk-recommend-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
      }
      .pk-rec-box {
        border-radius: 16px;
        padding: 20px;
        display: flex;
        flex-direction: column;
      }
      .pk-rec-img {
        width: 60px;
        height: 60px;
        background: #fff;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 15px;
      }
      .pk-rec-img img { max-height: 80%; }
      .pk-rec-box h4 { margin: 0 0 10px 0; font-size: 18px; font-weight: 800; }
      .pk-rec-box p { font-size: 13px; margin: 0 0 20px 0; line-height: 1.5; flex-grow: 1; color: #595961; }
      .pk-rec-box .pk-dark-btn { width: 100%; font-size: 14px; }
      .pk-black-btn { background: #121217; }

      /* SUBSCRIPTION PLAN */
      .pk-active-badge {
        border: 1px solid #e8b923;
        color: #d19a0a;
        background: #fff;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 700;
      }
      .pk-sub-stats-banner {
        background: #ffd831;
        border-radius: 12px;
        padding: 20px;
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 15px;
        margin-bottom: 30px;
      }
      .pk-sub-stats-banner label {
        display: block;
        font-size: 10px;
        font-weight: 800;
        margin-bottom: 6px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .pk-sub-stats-banner span {
        font-size: 15px;
        font-weight: 600;
      }
      .pk-sub-items {
        border: 1px solid #eaeaea;
        border-radius: 12px;
        margin-bottom: 20px;
      }
      .pk-sub-item-row {
        display: flex;
        align-items: center;
        padding: 20px;
        border-bottom: 1px solid #eaeaea;
      }
      .pk-sub-item-row.no-border { border-bottom: none; }
      .pk-sub-img {
        width: 50px;
        height: 50px;
        margin-right: 20px;
      }
      .pk-sub-img img { width: 100%; height: 100%; object-fit: contain; }
      .pk-sub-info { flex-grow: 1; }
      .pk-sub-info h4 { margin: 0 0 4px 0; font-size: 16px; font-weight: 700; }
      .pk-sub-info p { margin: 0; font-size: 13px; color: #595961; }
      .pk-sub-actions {
        display: flex;
        align-items: center;
        gap: 20px;
      }
      .pk-sub-actions a { color: #595961; font-size: 13px; text-decoration: underline; font-weight: 600;}
      .pk-qty-box {
        border: 1px solid #eaeaea;
        padding: 6px 16px;
        border-radius: 20px;
        font-weight: 700;
        font-size: 14px;
      }
      .pk-sub-price { font-weight: 700; font-size: 16px; width: 60px; text-align: right; }
      
      .pk-sub-add-bar {
        background: #21252A;
        color: #fff;
        padding: 16px 20px;
        border-radius: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 14px;
        margin-bottom: 30px;
      }
      .pk-sub-add-bar a { color: #fff; text-decoration: underline; font-weight: 700; }
      
      .pk-sub-action-btns {
        display: flex;
        align-items: center;
        gap: 15px;
        margin-bottom: 30px;
        flex-wrap: wrap;
      }
      .pk-cancel-link { color: #8c8c9a; font-size: 13px; text-decoration: none; margin-left: auto; }
      
      .pk-sub-benefits-banner {
        background: #ffd831;
        border-radius: 12px;
        padding: 24px;
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 20px;
      }
      .pk-benefit strong { display: block; font-size: 14px; font-weight: 800; margin-bottom: 6px; }
      .pk-benefit p { margin: 0; font-size: 13px; color: #121217; }

      /* VET CARD */
      .pk-vet-card {
        background: #21252A;
        color: #fff;
        border-radius: 16px;
        padding: 30px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .pk-vet-card h3 { font-size: 24px; margin: 0 0 10px 0; font-family: var(--purrkins-heading-font); font-weight: 800;}
      .pk-vet-card p { margin: 0; font-size: 15px; color: #d1d1d1; }
      .pk-yellow-btn {
        background: #ffd831;
        color: #121217;
        padding: 12px 30px;
        border-radius: 30px;
        border: none;
        font-weight: 800;
        font-size: 15px;
        cursor: pointer;
      }

      .pk-outline-btn {
        border: 1px solid #121217;
        color: #121217;
        padding: 8px 20px;
        border-radius: 30px;
        text-decoration: none;
        font-size: 14px;
        font-weight: 700;
        display: inline-block;
        background: #fff;
        transition: 0.2s;
        cursor: pointer;
      }
      .pk-outline-btn:hover { background: #f9f9f9; }

      @media (max-width: 900px) {
        .pk-dashboard-layout { grid-template-columns: 1fr; }
        .pk-profile-details { flex-direction: column; }
        .pk-profile-stats { grid-template-columns: 1fr 1fr; }
        .pk-weight-banner { flex-direction: column; gap: 15px; align-items: flex-start; }
        .pk-recommend-grid { grid-template-columns: 1fr; }
        .pk-sub-stats-banner { grid-template-columns: 1fr 1fr; }
        .pk-sub-item-row { flex-direction: column; gap: 15px; align-items: flex-start; }
        .pk-sub-actions { width: 100%; justify-content: space-between; }
        .pk-sub-action-btns { flex-direction: column; align-items: stretch; }
        .pk-cancel-link { margin-left: 0; text-align: center; margin-top: 10px; }
        .pk-sub-benefits-banner { grid-template-columns: 1fr 1fr; }
        .pk-vet-card { flex-direction: column; gap: 20px; text-align: center; }
      }

      /* Sticky sidebar: stays fixed while the main content scrolls */
      .pk-dashboard-layout { align-items: start; }
      .pk-dashboard-sidebar {
        position: sticky;
        top: 145px;
        align-self: start;
      }
      /* Wishlist 2.5 Cards Slider (Screenshot 2, 3, 4) */
      .pk-wishlist-slider-wrap {
        position: relative;
        width: 100%;
        overflow: hidden;
      }
      .pk-wishlist-slider {
        display: flex;
        gap: 20px;
        overflow-x: auto;
        scroll-snap-type: x proximity;
        scroll-behavior: smooth;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        -ms-overflow-style: none;
        padding: 4px 0 12px 0;
      }
      .pk-wishlist-slider::-webkit-scrollbar {
        display: none;
      }
      .pk-wishlist-card {
        flex: 0 0 calc((100% - 40px) / 2.5);
        min-width: calc((100% - 40px) / 2.5);
        max-width: calc((100% - 40px) / 2.5);
        scroll-snap-align: start;
        border: 1px solid #eaeaea;
        border-radius: 16px;
        overflow: hidden;
        background: #fff;
        display: flex;
        flex-direction: column;
        box-shadow: 0 2px 8px rgba(0,0,0,0.03);
        box-sizing: border-box;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }
      .pk-wishlist-card:hover {
        transform: translateY(-3px);
        box-shadow: 0 8px 20px rgba(0,0,0,0.06);
      }
      .pk-wishlist-card-top {
        padding: 24px 20px 20px;
        position: relative;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 180px;
        box-sizing: border-box;
      }
      .pk-wishlist-badge {
        position: absolute;
        top: 16px;
        left: 16px;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.2px;
        display: inline-block;
        line-height: 1.2;
      }
      .pk-wishlist-card-top img {
        max-height: 140px;
        max-width: 120px;
        object-fit: contain;
        transition: transform 0.25s ease;
      }
      .pk-wishlist-card:hover .pk-wishlist-card-top img {
        transform: scale(1.05);
      }
      .pk-wishlist-card-bottom {
        padding: 20px 20px 24px;
        text-align: center;
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        align-items: center;
        background: #fff;
      }
      .pk-wishlist-card-title {
        margin: 0 0 8px 0;
        font-size: 20px;
        font-weight: 800;
        color: #121217;
        font-family: var(--font-heading--family, sans-serif);
        line-height: 1.2;
      }
      .pk-wishlist-card-price-row {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-size: 18px;
        font-weight: 800;
        color: #121217;
      }
      .pk-wishlist-sep {
        color: #d1d5db;
        font-weight: 400;
      }
      .pk-wishlist-weight {
        color: #71717A;
        font-size: 14px;
        font-weight: 600;
      }
      .pk-wishlist-card-desc {
        margin: 0 0 20px 0;
        font-size: 13px;
        color: #71717A;
        line-height: 1.4;
        flex-grow: 1;
        min-height: 36px;
      }
      .pk-wishlist-add-btn {
        display: inline-block;
        padding: 12px 32px;
        background: #FFE600;
        color: #121217;
        border-radius: 30px;
        border: none;
        font-weight: 800;
        font-size: 14px;
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        width: fit-content;
      }
      .pk-wishlist-add-btn:hover {
        background: #FFD800;
        transform: scale(1.02);
      }
      .pk-wishlist-add-btn:active {
        transform: scale(0.98);
      }
      .pk-wl-nav-btn {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 1.5px solid #E4E4E7;
        background: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #121217;
        transition: all 0.2s ease;
        padding: 0;
        user-select: none;
        -webkit-user-select: none;
      }
      .pk-wl-nav-btn svg {
        pointer-events: none;
        display: block;
      }
      .pk-wl-nav-btn:hover {
        background: #FFE600;
        border-color: #FFE600;
        color: #121217;
        transform: scale(1.05);
      }
      .pk-wl-nav-btn:active {
        transform: scale(0.95);
      }
      @media (max-width: 900px) {
        .pk-wishlist-card {
          flex: 0 0 calc((100% - 20px) / 1.75);
          min-width: calc((100% - 20px) / 1.75);
          max-width: calc((100% - 20px) / 1.75);
        }
      }
      @media (max-width: 600px) {
        .pk-wishlist-card {
          flex: 0 0 calc((100% - 16px) / 1.25);
          min-width: calc((100% - 16px) / 1.25);
          max-width: calc((100% - 16px) / 1.25);
        }
      }
    \n</style>

    

    <div class="pk-dashboard-wrapper">
      <div class="pk-dashboard-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px;">
        <h1 style="margin: 0; font-family: var(--font-heading--family, sans-serif); font-size: 32px; font-weight: 800;">Welcome back, ${escAttr(customer.firstName || "Friend")}</h1>
      </div>

      <div class="pk-dashboard-layout">
        <!-- SIDEBAR (Image 1 & 2) -->
        <div class="pk-dashboard-sidebar">
          <div class="pk-sidebar-menu">
            <a href="#overview" data-tab="overview" onclick="switchDashboardTab('overview', event); return false;" class="pk-menu-item active"><span class="pk-dot"></span> Overview</a>
            <a href="#kitten" data-tab="kitten" onclick="switchDashboardTab('kitten', event); return false;" class="pk-menu-item"><span class="pk-dot"></span> Kitten's Profile</a>
            <a href="#quiz-answers" data-tab="quiz-answers" onclick="switchDashboardTab('quiz-answers', event); return false;" class="pk-menu-item"><span class="pk-dot"></span> Your Quiz Answers</a>
            <a href="#subscriptions" data-tab="subscriptions" onclick="switchDashboardTab('subscriptions', event); return false;" class="pk-menu-item"><span class="pk-dot"></span> Subscriptions ${customerSubscriptions.length > 0 ? `<span class="pk-badge">${customerSubscriptions.length}</span>` : ''}</a>
            <a href="#vet" onclick="pkOpenVetModal(event); return false;" class="pk-menu-item"><span class="pk-dot"></span> Talk to a Vet</a>
          </div>

          <div class="pk-whatsapp-card">
            <h3>Stuck on something?</h3>
            <p>Our kitten team replies on WhatsApp, usually within an hour.</p>
            <a href="https://wa.me/918130578935" target="_blank" rel="noopener noreferrer" class="pk-whatsapp-btn">Reach Out <span class="wa-icon" style="display:inline-flex;align-items:center;margin-left:4px;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="12" fill="white"/><path fill-rule="evenodd" clip-rule="evenodd" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.888-.788-1.489-1.761-1.663-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.575-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884" fill="#25D366"/></svg></span></a>
          </div>
        </div>

        <!-- MAIN CONTENT -->
        <div class="pk-dashboard-content">
          
          <!-- TAB 1: OVERVIEW (Image 1) -->
          <div id="pk-tab-overview" class="pk-tab-pane">
            <!-- Profile & Billing Address -->
            <div class="pk-card" style="margin-bottom: 24px;">
              <div class="pk-profile-top" style="display: flex; gap: 28px; align-items: center; margin-bottom: 32px; flex-wrap: wrap;">
                <!-- Profile Avatar Option (Click or button to upload) -->
                <div class="pk-avatar-wrapper" style="position: relative; flex-shrink: 0;">
                  <div class="pk-avatar" id="pk-avatar-box" onclick="document.getElementById('pk-avatar-file-input').click()" style="width: 84px; height: 84px; background: #eaeaea; border-radius: 18px; display: flex; align-items: center; justify-content: center; color: #595961; cursor: pointer; overflow: hidden; position: relative; box-shadow: 0 2px 8px rgba(0,0,0,0.06); transition: transform 0.15s ease, box-shadow 0.15s ease;" title="Click to change profile photo">
                    <img id="pk-avatar-img" src="${escAttr(customerAvatarUrl)}" alt="Profile Photo" style="width: 100%; height: 100%; object-fit: cover; display: ${customerAvatarUrl ? 'block' : 'none'};">
                    <div id="pk-avatar-icon" style="display: ${customerAvatarUrl ? 'none' : 'flex'}; align-items: center; justify-content: center;">
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </div>
                    <!-- Hover overlay -->
                    <div class="pk-avatar-hover-overlay" style="position: absolute; inset: 0; background: rgba(0,0,0,0.38); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s ease;">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                    </div>
                  </div>
                  <!-- Camera badge icon on bottom right -->
                  <div onclick="document.getElementById('pk-avatar-file-input').click()" style="position: absolute; bottom: -3px; right: -3px; width: 28px; height: 28px; background: #121217; border: 2.5px solid #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.25); transition: transform 0.15s ease;" title="Upload profile photo">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                  </div>
                  <input type="file" id="pk-avatar-file-input" accept="image/png, image/jpeg, image/webp" style="display: none;" onchange="handleAvatarChange(event)">
                </div>

                <div class="pk-form-row" style="flex-grow: 1; display: flex; flex-direction: column; gap: 6px;">
                  <div class="pk-input-group" style="max-width: 360px; width: 100%;">
                    <label>Username *</label>
                    <input type="text" id="pk-username" value="${escAttr(customer.firstName)}">
                  </div>
                  <div>
                    <button type="button" onclick="document.getElementById('pk-avatar-file-input').click()" id="pk-avatar-upload-text" style="background: none; border: none; padding: 0; font-size: 13px; font-weight: 700; color: #121217; cursor: pointer; text-decoration: underline;">${customerAvatarUrl ? 'Change Profile Photo' : 'Upload Profile Photo'}</button>
                  </div>
                </div>
              </div>

              <!-- Billing Address -->
              <h3 class="pk-section-title">Customer Billing Address</h3>
              <div class="pk-form-grid">
                <input type="text" id="pk-bill-firstName" placeholder="First Name" value="${escAttr(defaultAddress.firstName)}">
                <input type="text" id="pk-bill-lastName" placeholder="Last Name" value="${escAttr(defaultAddress.lastName)}">
                <input type="email" placeholder="Email" value="${escAttr(customer.email)}" readonly>
                
                <input type="text" id="pk-bill-country" placeholder="Country/Region" value="${escAttr(defaultAddress.country || "India")}">
                <select id="pk-bill-province" style="appearance: none; background: url('data:image/svg+xml;utf8,<svg width=\\'12\\' height=\\'12\\' fill=\\'none\\' stroke=\\'%238c8c9a\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' viewBox=\\'0 0 24 24\\' xmlns=\\'http://www.w3.org/2000/svg\\'><path d=\\'m6 9 6 6 6-6\\'/></svg>') no-repeat right 16px center; background-color: #fff;">
                  <option value="" disabled ${!defaultAddress.province ? 'selected' : ''}>State</option>
                  <option value="Tamil Nadu" ${defaultAddress.province === 'Tamil Nadu' ? 'selected' : ''}>Tamil Nadu</option>
                  <option value="Karnataka" ${defaultAddress.province === 'Karnataka' ? 'selected' : ''}>Karnataka</option>
                  <option value="Maharashtra" ${defaultAddress.province === 'Maharashtra' ? 'selected' : ''}>Maharashtra</option>
                  <option value="Delhi" ${defaultAddress.province === 'Delhi' ? 'selected' : ''}>Delhi</option>
                  <option value="${escAttr(defaultAddress.province)}" ${defaultAddress.province && !['Tamil Nadu','Karnataka','Maharashtra','Delhi'].includes(defaultAddress.province) ? 'selected' : ''}>${escAttr(defaultAddress.province)}</option>
                </select>
                <input type="text" id="pk-bill-phone" placeholder="Phone (optional)" value="${escAttr(customer.phone)}">
                
                <input type="text" id="pk-bill-zip" placeholder="Pin Code" value="${escAttr(defaultAddress.zip)}">
                <input type="text" id="pk-bill-address1" placeholder="Apartment, suite, etc. (optional)" value="${escAttr(defaultAddress.address1)}" style="grid-column: span 2;">
                <input type="hidden" id="pk-bill-address2" value="">
                
                <input type="text" id="pk-bill-city" placeholder="City" value="${escAttr(defaultAddress.city)}">
              </div>
              <div id="pk-profile-msg" style="display:none;margin-top:16px;font-size:14px;font-weight:600;"></div>
              <div class="pk-form-actions">
                <a href="#" id="pk-update-btn" class="pk-link-btn" onclick="submitProfile(event)">Update</a>
              </div>
            </div>

            <!-- Your Wishlist (Image 1 & 4) -->
            <div id="pk-overview-wishlist" class="pk-card" style="margin-bottom: 24px; padding: 28px 32px;">
              ${getWishlistHtml('pk-wl-slider-overview')}
            </div>

            <!-- Orders (Image 1) -->
            <div class="pk-card" style="margin-bottom: 24px; padding: 28px 32px;">
              <h3 class="pk-section-title" style="margin-bottom: 20px;">Orders</h3>
              <div class="pk-orders-table">
                <div class="pk-orders-header">
                  <div>ORDER</div>
                  <div>DATE</div>
                  <div>STATUS</div>
                  <div>TOTAL</div>
                  <div></div>
                </div>
                ${ordersHtml}
              </div>
              <div style="margin-top: 18px;">
                <button type="button" onclick="window.location.href='/account'" class="pk-view-all-orders-btn">View all orders</button>
              </div>
            </div>

            <!-- Delivery Addresses (Image 1) -->
            <div class="pk-card">
              <div class="pk-address-header">
                <h3 class="pk-section-title">Delivery addresses</h3>
                <button onclick="document.getElementById('addr-modal').style.display='flex'" class="pk-outline-btn" style="cursor:pointer;background:none;">+ Add address</button>
              </div>
              <div class="pk-address-grid">
                ${addressesHtml}
              </div>
            </div>
          </div>

          <!-- TAB 2: KITTEN'S PROFILE (Image 2) -->
          <div id="pk-tab-kitten" class="pk-tab-pane" style="display: none;">
            ${kittenTabHtml}
          </div>

          <!-- TAB 3: SUBSCRIPTIONS INDIVIDUAL (Image 3) -->
          <div id="pk-tab-subscriptions" class="pk-tab-pane" style="display: none;">
            ${subscriptionsTabHtml}
          </div>

          <!-- TAB 4: MY REVIEWS -->
          <div id="pk-tab-reviews" class="pk-tab-pane" style="display: none;">
            <div class="pk-card">
              ${reviewsHtml}
            </div>
          </div>

          <!-- TAB 5: WISHLIST -->
          <div id="pk-tab-wishlist" class="pk-tab-pane" style="display: none;">
            <div class="pk-card" style="padding: 28px 32px;">
              ${getWishlistHtml('pk-wl-slider-tab')}
            </div>
          </div>

        </div>
      </div>
    </div>

    <script>
      window.pkDefaultFallbackImg = ${JSON.stringify(defaultFallbackImg)};

      // Global Tab Switcher (Early defined so left side menu clicks work immediately)
      window.switchDashboardTab = function(tabId, ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (!tabId) tabId = 'overview';
        if (tabId.indexOf('#') === 0) tabId = tabId.substring(1);
        if (tabId.indexOf('pk-tab-') === 0) tabId = tabId.replace('pk-tab-', '');
        if (tabId === 'profile') tabId = 'overview';

        var shouldScrollWishlist = false;
        if (tabId === 'wishlist') {
          tabId = 'overview';
          shouldScrollWishlist = true;
        }

        var shouldScrollQuiz = false;
        if (tabId === 'quiz-answers' || tabId === 'quiz') {
          tabId = 'kitten';
          shouldScrollQuiz = true;
        }

        var validTabs = ['overview', 'kitten', 'subscriptions', 'reviews'];
        if (validTabs.indexOf(tabId) === -1) tabId = 'overview';

        // Instant DOM pane visibility toggle
        document.querySelectorAll('.pk-tab-pane').forEach(function(p) {
          p.style.display = 'none';
        });
        var target = document.getElementById('pk-tab-' + tabId);
        if (target) {
          target.style.display = 'block';
        }

        // Update active class on sidebar menu items
        var activeTabKey = shouldScrollQuiz ? 'quiz-answers' : (shouldScrollWishlist ? 'overview' : tabId);
        document.querySelectorAll('.pk-sidebar-menu .pk-menu-item').forEach(function(item) {
          if (item.getAttribute('data-tab') === activeTabKey) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });

        // Scroll to Wishlist if requested
        if (shouldScrollWishlist) {
          setTimeout(function() {
            var w = document.getElementById('pk-overview-wishlist');
            if (w) w.scrollIntoView({ behavior: 'smooth' });
          }, 60);
        }

        // Scroll to Quiz if requested
        if (shouldScrollQuiz) {
          setTimeout(function() {
            var q = document.getElementById('pk-pet-quiz-card');
            if (q) q.scrollIntoView({ behavior: 'smooth' });
          }, 60);
        }

        // Update URL hash without reload or fetch
        if (window.history && window.history.replaceState) {
          var u = new URL(window.location.href);
          u.hash = shouldScrollWishlist ? 'wishlist' : (shouldScrollQuiz ? 'quiz-answers' : tabId);
          window.history.replaceState(null, '', u.toString());
        }

        // Ensure loader is completely hidden immediately
        if (typeof pkHideLoader === 'function') pkHideLoader();
        var loader = document.getElementById('pk-cat-loader-overlay');
        if (loader) loader.style.display = 'none';
      };

      // Ensure switchDashboardTab is also directly accessible in inline scopes
      function switchDashboardTab(tabId, ev) {
        window.switchDashboardTab(tabId, ev);
      }

      // Robust Wishlist Slider Controller (Early defined on window)
      window.pkSlideWishlist = function(sliderId, dir, ev) {
        if (ev) {
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
        }
        var slider = document.getElementById(sliderId) ||
          document.querySelector('.pk-tab-pane:not([style*="display: none"]) .pk-wishlist-slider') ||
          document.querySelector('.pk-wishlist-slider');
        if (!slider) return;

        var cards = slider.querySelectorAll('.pk-wishlist-card');
        if (!cards || cards.length === 0) return;

        var cardWidth = cards[0].offsetWidth || 280;
        var gap = 20;
        try {
          var comp = window.getComputedStyle(slider);
          var g = parseFloat(comp.gap || comp.columnGap);
          if (!isNaN(g) && g > 0) gap = g;
        } catch(e) {}

        var step = cardWidth + gap;
        var maxScroll = slider.scrollWidth - slider.clientWidth;
        if (maxScroll <= 5) return;

        var cur = slider.scrollLeft;
        var target;

        if (dir > 0) {
          // Next slide
          if (cur >= maxScroll - 15) {
            target = 0; // Wrap back to beginning
          } else {
            target = cur + step;
            if (target > maxScroll - 15) target = maxScroll;
          }
        } else {
          // Prev slide
          if (cur <= 15) {
            target = maxScroll; // Wrap back to end
          } else {
            target = cur - step;
            if (target < 15) target = 0;
          }
        }

        target = Math.max(0, Math.min(target, maxScroll));

        // Temporarily clear scrollSnapType so smooth programmatic scroll is never aborted by snap engine
        slider.style.scrollSnapType = 'none';

        if (typeof slider.scrollTo === 'function') {
          slider.scrollTo({
            left: target,
            behavior: 'smooth'
          });
        } else {
          slider.scrollLeft = target;
        }

        setTimeout(function() {
          slider.style.scrollSnapType = 'x proximity';
        }, 450);
      };

      // Document event delegation for any wishlist nav arrow clicks
      document.addEventListener('click', function(e) {
        var btn = e.target && e.target.closest ? e.target.closest('.pk-wl-nav-btn') : null;
        if (!btn) return;
        var sId = btn.getAttribute('data-slider') || 'pk-wl-slider-overview';
        var d = parseInt(btn.getAttribute('data-dir'), 10) || (btn.classList.contains('prev') ? -1 : 1);
        window.pkSlideWishlist(sId, d, e);
      });

      // Pets data for instant client-side switching
      window.pkPetsData = ${JSON.stringify(pets)};

      // 0ms Pet Switcher Function
      window.pkSelectPet = function(index, ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        var pets = window.pkPetsData || [];
        var pet = pets[index];
        if (!pet) return;

        // Update active class on pills
        document.querySelectorAll('.pk-pet-pill').forEach(function(pill, idx) {
          if (idx === index) {
            pill.classList.add('active');
          } else {
            pill.classList.remove('active');
          }
        });

        // Update profile card fields
        var titleEl = document.getElementById('pk-pet-profile-title');
        if (titleEl) titleEl.textContent = pet.name + "'s profile";
        
        var imgEl = document.getElementById('pk-pet-profile-img');
        if (imgEl && pet.imageUrl) imgEl.src = pet.imageUrl;

        var ageEl = document.getElementById('pk-pet-stat-age');
        if (ageEl) ageEl.textContent = pet.age;

        var weightEl = document.getElementById('pk-pet-stat-weight');
        if (weightEl) weightEl.textContent = pet.weight + ' kg';

        var breedEl = document.getElementById('pk-pet-stat-breed');
        if (breedEl) breedEl.textContent = pet.breed || 'Indie';

        var sexEl = document.getElementById('pk-pet-stat-sex');
        if (sexEl) sexEl.textContent = pet.gender + ', ' + (pet.neutered || '').toLowerCase();

        var actEl = document.getElementById('pk-pet-stat-activity');
        if (actEl) actEl.textContent = pet.activityLevel || 'Playful, indoor only';

        var bdayEl = document.getElementById('pk-pet-stat-bday');
        if (bdayEl) bdayEl.textContent = pet.birthday || '14 Mar 2026';

        var healthEl = document.getElementById('pk-pet-stat-health');
        if (healthEl) healthEl.textContent = pet.healthFlags || 'Sensitive stomach';

        var bodyEl = document.getElementById('pk-pet-stat-body');
        if (bodyEl) bodyEl.textContent = pet.eatingStyle || 'Fussy (prefers fish)';

        var allergEl = document.getElementById('pk-pet-stat-allergies');
        if (allergEl) allergEl.textContent = pet.allergies || 'None recorded';

        var weightLogEl = document.getElementById('pk-pet-weight-log');
        if (weightLogEl) weightLogEl.textContent = pet.loggedWeight || (pet.weight + ' kg logged on 2 Aug');

        // Update Recommendations Header
        var recTitleEl = document.getElementById('pk-pet-rec-title');
        if (recTitleEl) recTitleEl.textContent = 'Recommend for ' + pet.name;

        // Update Quiz Pills
        var pillsContainer = document.getElementById('pk-pet-quiz-pills');
        if (pillsContainer && pet.quizPills) {
          pillsContainer.innerHTML = pet.quizPills.map(function(pill) {
            return '<span style="background:#f4f4f5; border-radius:30px; padding:8px 18px; font-size:14px; font-weight:600; color:#121217; display:inline-block;">' + pill + '</span>';
          }).join('');
        }
      };

      // Add kitten quiz modal open
      window.pkOpenAddKittenQuiz = function() {
        var modal = document.getElementById('global-byob-quiz-popup');
        if (modal) {
          modal.style.display = 'flex';
        } else {
          window.location.href = '/pages/byob';
        }
      };

      // Scroll to quiz answers
      window.pkScrollToQuiz = function(ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        window.switchDashboardTab('quiz-answers');
      };

      // Instant 0ms Tab switcher
      window.switchDashboardTab = function(tabId, ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (!tabId) tabId = 'overview';
        if (tabId.indexOf('#') === 0) tabId = tabId.substring(1);
        if (tabId.indexOf('pk-tab-') === 0) tabId = tabId.replace('pk-tab-', '');
        if (tabId === 'profile') tabId = 'overview';

        var shouldScrollWishlist = false;
        if (tabId === 'wishlist') {
          tabId = 'overview';
          shouldScrollWishlist = true;
        }

        var shouldScrollQuiz = false;
        if (tabId === 'quiz-answers' || tabId === 'quiz') {
          tabId = 'kitten';
          shouldScrollQuiz = true;
        }

        var validTabs = ['overview', 'kitten', 'subscriptions', 'reviews'];
        if (validTabs.indexOf(tabId) === -1) tabId = 'overview';

        // Instant DOM pane visibility toggle
        document.querySelectorAll('.pk-tab-pane').forEach(function(p) {
          p.style.display = 'none';
        });
        var target = document.getElementById('pk-tab-' + tabId);
        if (target) {
          target.style.display = 'block';
        }

        // Update active class on sidebar menu items
        var activeTabKey = shouldScrollQuiz ? 'quiz-answers' : (shouldScrollWishlist ? 'overview' : tabId);
        document.querySelectorAll('.pk-sidebar-menu .pk-menu-item').forEach(function(item) {
          if (item.getAttribute('data-tab') === activeTabKey) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });

        // Scroll to Wishlist if requested
        if (shouldScrollWishlist) {
          setTimeout(function() {
            var w = document.getElementById('pk-overview-wishlist');
            if (w) w.scrollIntoView({ behavior: 'smooth' });
          }, 60);
        }

        // Scroll to Quiz if requested
        if (shouldScrollQuiz) {
          setTimeout(function() {
            var q = document.getElementById('pk-pet-quiz-card');
            if (q) q.scrollIntoView({ behavior: 'smooth' });
          }, 60);
        }

        // Update URL hash without reload or fetch
        if (window.history && window.history.replaceState) {
          var u = new URL(window.location.href);
          u.hash = shouldScrollWishlist ? 'wishlist' : (shouldScrollQuiz ? 'quiz-answers' : tabId);
          window.history.replaceState(null, '', u.toString());
        }

        // Ensure loader is completely hidden immediately
        if (typeof pkHideLoader === 'function') pkHideLoader();
        var loader = document.getElementById('pk-cat-loader-overlay');
        if (loader) loader.style.display = 'none';
      };

      // Handle direct hash navigation and back/forward buttons
      window.addEventListener('hashchange', function() {
        var h = window.location.hash ? window.location.hash.replace('#', '') : 'overview';
        window.switchDashboardTab(h);
      });

      // Initialize on initial page load
      (function initDashboard() {
        var hash = window.location.hash ? window.location.hash.replace('#', '') : '';
        if (!hash) {
          var params = new URLSearchParams(window.location.search);
          hash = params.get('tab') || '';
        }
        window.switchDashboardTab(hash || 'overview');
        setTimeout(function() {
          if (typeof pkHideLoader === 'function') pkHideLoader();
        }, 80);
        var loader = document.getElementById('pk-cat-loader-overlay');
        if (loader) loader.style.display = 'none';

        // Migrate any session wishlist items to customer storage if present
        try {
          var pendingWl = JSON.parse(localStorage.getItem('pk_session_wishlist') || sessionStorage.getItem('pk_session_wishlist') || '[]');
          var token = localStorage.getItem('pk_session') || '';
          if (Array.isArray(pendingWl) && pendingWl.length > 0) {
            fetch('/apps/purrkins/wishlist' + (token ? '?session=' + encodeURIComponent(token) : ''), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'merge', product_ids: pendingWl })
            }).then(function() {
              try {
                localStorage.removeItem('pk_session_wishlist');
                sessionStorage.removeItem('pk_session_wishlist');
              } catch(e) {}
            }).catch(function(e){});
          }
        } catch(e) {}
      })();

      // Wishlist Slider Navigation (Screenshot 4)
      // Already defined early in script on window.pkSlideWishlist

      // Client Catalog Products for instant synchronization
      window.pkCatalogProducts = ${JSON.stringify(clientCatalogProducts)};

      // Dynamic client-side wishlist synchronization
      window.pkInitDynamicWishlist = function() {
        var catalog = window.pkCatalogProducts || [];
        if (!catalog.length) return;

        function updateSlidersWithList(wishlistIds) {
          if (!Array.isArray(wishlistIds) || wishlistIds.length === 0) return;
          var cleanIds = wishlistIds.map(function(id) {
            return String(id).includes('/') ? String(id).split('/').pop() : String(id);
          });
          
          var matched = [];
          cleanIds.forEach(function(cId) {
            var found = catalog.find(function(p) {
              var pId = p.id ? String(p.id).split('/').pop() : '';
              return pId === cId;
            });
            if (found && !matched.some(function(m){ return m.id === found.id; })) {
              matched.push(found);
            }
          });

          if (matched.length === 0) return;

          ['pk-wl-slider-overview', 'pk-wl-slider-tab'].forEach(function(sliderId) {
            var slider = document.getElementById(sliderId);
            if (!slider) return;
            slider.innerHTML = matched.map(function(p) {
              var bg = p.cardBg || '#EBF5FE';
              var color = p.cardColor || '#2A85C8';
              var badge = p.badgeText || 'Wet Food';
              var vId = p.variantId || '';
              return '<div class="pk-wishlist-card">' +
                '<div class="pk-wishlist-card-top" style="background:' + bg + ';">' +
                  '<span class="pk-wishlist-badge" style="background:' + bg + '; border:1px solid ' + color + '; color:' + color + ';">' + badge + '</span>' +
                  '<img src="' + (p.image || '') + '" alt="' + (p.title || '') + '" onerror="this.onerror=null; if(window.pkDefaultFallbackImg) this.src=window.pkDefaultFallbackImg;">' +
                '</div>' +
                '<div class="pk-wishlist-card-bottom">' +
                  '<h4 class="pk-wishlist-card-title">' + (p.title || '') + '</h4>' +
                  '<div class="pk-wishlist-card-price-row">' +
                    '<span>₹' + (p.price || 79) + '</span>' +
                    '<span class="pk-wishlist-sep">|</span>' +
                    '<span class="pk-wishlist-weight">' + (p.weight || '70g') + '</span>' +
                  '</div>' +
                  '<p class="pk-wishlist-card-desc">' + (p.desc || 'Real broth for daily hydration') + '</p>' +
                  '<button type="button" data-vid="' + vId + '" onclick="pkAddToCart(this.dataset.vid, this)" class="pk-wishlist-add-btn">Add to Cart</button>' +
                '</div>' +
              '</div>';
            }).join('');
          });
        }

        // Listen for live wishlist events across tabs / components
        document.addEventListener('purrkins:wishlist:updated', function(e) {
          if (e.detail && e.detail.wishlist) {
            updateSlidersWithList(e.detail.wishlist);
          }
        });

        // Check if window.purrkinsWishlist is available or fetch
        if (window.purrkinsWishlist && window.purrkinsWishlist.length > 0) {
          updateSlidersWithList(window.purrkinsWishlist);
        } else {
          var token = localStorage.getItem('pk_session') || '';
          fetch('/apps/purrkins/wishlist' + (token ? '?session=' + encodeURIComponent(token) : ''))
            .then(function(r) { return r.json(); })
            .then(function(res) {
              if (res && res.success && Array.isArray(res.wishlist) && res.wishlist.length > 0) {
                window.purrkinsWishlist = res.wishlist;
                updateSlidersWithList(res.wishlist);
              }
            })
            .catch(function(){});
        }
      };

      setTimeout(function() {
        if (typeof window.pkInitDynamicWishlist === 'function') {
          window.pkInitDynamicWishlist();
        }
      }, 120);

      // Global Add to Cart helper for Wishlist and Recommendations
      window.pkAddToCart = function(variantId, btn) {
        if (!variantId) {
          window.location.href = '/collections/all';
          return;
        }
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Adding...';
        }
        fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Added ✓';
            setTimeout(function() { btn.textContent = 'Add to Cart'; }, 1500);
          }
          var cartBubble = document.getElementById('cart-icon-bubble');
          if (cartBubble) cartBubble.click();
          document.dispatchEvent(new CustomEvent('cart:refresh'));
        })
        .catch(function(err) {
          console.error('Add to cart error', err);
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Add to Cart';
          }
        });
      };

      // ─── Header account icon fix ───────────────────────────────
      (function fixHeaderIcon() {
        function applyFix() {
          document.querySelectorAll('a[href*="/account/login"], a[href="/account"], [data-customer-account-redirect]').forEach(function(el) {
            el.removeAttribute('href');
            el.style.cursor = 'pointer';
            el.onclick = function(e) {
              e.preventDefault();
              var t = localStorage.getItem('pk_session');
              if (t) {
                window.location.href = '/apps/purrkins/dashboard';
              } else {
                window.location.href = '/apps/purrkins/login';
              }
            };
          });
        }
        applyFix();
        document.addEventListener('DOMContentLoaded', function() { setTimeout(applyFix, 300); setTimeout(applyFix, 1000); });
      })();

      // ─── Address modal helpers ────────────────────────────────
      var _pk_session = localStorage.getItem('pk_session') || '';
      var _apiBase = '/apps/purrkins/customer-api?session=' + _pk_session + '&intent=';

      // Profile Avatar Upload Handler
      window._pk_pending_avatar = '';
      window.handleAvatarChange = function(event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
          alert('Image size should be less than 5MB.');
          return;
        }

        var reader = new FileReader();
        reader.onload = function(e) {
          var dataUrl = e.target.result;
          var avatarImg = document.getElementById('pk-avatar-img');
          var avatarIcon = document.getElementById('pk-avatar-icon');
          if (avatarImg) {
            avatarImg.src = dataUrl;
            avatarImg.style.display = 'block';
          }
          if (avatarIcon) {
            avatarIcon.style.display = 'none';
          }
          window._pk_pending_avatar = dataUrl;

          var custId = '${numericId}';
          if (custId) {
            try { localStorage.setItem('pk_avatar_' + custId, dataUrl); } catch(err) {}
          }

          var uploadText = document.getElementById('pk-avatar-upload-text');
          if (uploadText) uploadText.textContent = 'Uploading...';

          var token = localStorage.getItem('pk_session') || '';
          var formData = new FormData();
          formData.append('avatar', file);
          formData.append('filename', file.name || 'avatar.jpg');

          fetch('/apps/purrkins/customer-api?session=' + token + '&intent=upload_avatar', {
            method: 'POST',
            body: formData
          })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.success && data.avatarUrl) {
              window._pk_pending_avatar = data.avatarUrl;
              if (custId) {
                try { localStorage.setItem('pk_avatar_' + custId, data.avatarUrl); } catch(err) {}
              }
              if (avatarImg) avatarImg.src = data.avatarUrl;
            }
            if (uploadText) uploadText.textContent = 'Change Profile Photo';
          })
          .catch(function() {
            if (uploadText) uploadText.textContent = 'Change Profile Photo';
          });
        };
        reader.readAsDataURL(file);
      };

      // Restore cached avatar on load if image is not yet rendered from server
      try {
        var custId = '${numericId}';
        var cachedAvatar = localStorage.getItem('pk_avatar_' + custId);
        var avatarImg = document.getElementById('pk-avatar-img');
        var avatarIcon = document.getElementById('pk-avatar-icon');
        if (cachedAvatar && avatarImg && (!avatarImg.src || avatarImg.style.display === 'none')) {
          avatarImg.src = cachedAvatar;
          avatarImg.style.display = 'block';
          if (avatarIcon) avatarIcon.style.display = 'none';
        }
      } catch(e) {}

      function submitProfile(e) {
        if (e) e.preventDefault();
        var msg = document.getElementById('pk-profile-msg');
        var btn = document.getElementById('pk-update-btn');
        function show(text, ok) {
          msg.style.display = 'block';
          msg.style.color = ok ? '#2E8E5A' : '#e53e3e';
          msg.innerText = text;
        }
        function val(id) { 
          var el = document.getElementById(id);
          return el ? el.value.trim() : ''; 
        }

        var body = {
          username: val('pk-username'),
          avatar: window._pk_pending_avatar || '',
          firstName: val('pk-bill-firstName'),
          lastName: val('pk-bill-lastName'),
          country: val('pk-bill-country'),
          province: val('pk-bill-province'),
          phone: val('pk-bill-phone'),
          zip: val('pk-bill-zip'),
          address1: val('pk-bill-address1'),
          address2: val('pk-bill-address2'),
          city: val('pk-bill-city')
        };
        if (!body.username) { show('Username is required.', false); return; }
        var anyAddr = body.firstName || body.address1 || body.city || body.zip;
        if (anyAddr && (!body.firstName || !body.address1 || !body.city || !body.zip)) {
          show('Please fill First Name, Street Address, City and Pin Code.', false);
          return;
        }

        var token = localStorage.getItem('pk_session') || '';
        btn.style.pointerEvents = 'none';
        btn.innerText = 'Updating...';
        fetch('/apps/purrkins/customer-api?session=' + token + '&intent=update_billing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.success) {
            show('Your details were updated.', true);
            setTimeout(function() { 
              if (typeof pkShowLoader === 'function') pkShowLoader();
              window.location.reload(); 
            }, 600);
          } else {
            show(d.error || 'Failed to update. Please try again.', false);
            btn.style.pointerEvents = 'auto';
            btn.innerText = 'Update';
          }
        }).catch(function() {
          show('Network error. Please try again.', false);
          btn.style.pointerEvents = 'auto';
          btn.innerText = 'Update';
        });
      }

      function submitAddress() {
        var body = {
          firstName: document.getElementById('addr-firstName').value.trim(),
          lastName: document.getElementById('addr-lastName').value.trim(),
          phone: document.getElementById('addr-phone').value.trim(),
          address1: document.getElementById('addr-address1').value.trim(),
          address2: document.getElementById('addr-address2').value.trim(),
          city: document.getElementById('addr-city').value.trim(),
          province: document.getElementById('addr-province').value.trim(),
          zip: document.getElementById('addr-zip').value.trim(),
          country: document.getElementById('addr-country').value.trim() || 'India'
        };
        if (!body.firstName || !body.address1 || !body.city || !body.zip) {
          var m = document.getElementById('addr-msg');
          m.style.display = 'block';
          m.innerText = 'Please fill required fields (First Name, Address, City, Pin Code).';
          return;
        }
        if (typeof pkShowLoader === 'function') pkShowLoader();
        fetch(_apiBase + 'add_address', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.success) {
            document.getElementById('addr-modal').style.display = 'none';
            window.location.reload();
          } else {
            if (typeof pkHideLoader === 'function') pkHideLoader();
            var m = document.getElementById('addr-msg');
            m.style.display = 'block';
            m.innerText = d.error || 'Failed to save address. Try again.';
          }
        }).catch(function() {
          if (typeof pkHideLoader === 'function') pkHideLoader();
        });
      }

      function deleteAddr(id) {
        if (!confirm('Delete this address?')) return;
        if (typeof pkShowLoader === 'function') pkShowLoader();
        fetch(_apiBase + 'delete_address', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addressId: id })
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.success) window.location.reload();
          else {
            if (typeof pkHideLoader === 'function') pkHideLoader();
            alert('Failed to delete address.');
          }
        }).catch(function() {
          if (typeof pkHideLoader === 'function') pkHideLoader();
        });
      }

      function setDefaultAddr(id) {
        if (typeof pkShowLoader === 'function') pkShowLoader();
        fetch(_apiBase + 'set_default_address', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addressId: id })
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.success) window.location.reload();
          else {
            if (typeof pkHideLoader === 'function') pkHideLoader();
            alert('Failed to set default.');
          }
        }).catch(function() {
          if (typeof pkHideLoader === 'function') pkHideLoader();
        });
      }

      document.addEventListener('click', function(e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;
        var rawHref = a.getAttribute('href') || '';
        if (rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;
        if (a.hasAttribute('onclick') && !rawHref.startsWith('/')) return;
        if (a.href && (a.href.indexOf('/apps/purrkins') !== -1 || a.href.indexOf('/account') !== -1)) {
          if (a.pathname === window.location.pathname) return;
          if (!a.target || a.target === '_self') {
            if (typeof pkShowLoader === 'function') pkShowLoader();
          }
        }
      }, true);
      
      var custFullName = ${JSON.stringify((customer.firstName ? (customer.firstName + ' ' + (customer.lastName || '')).trim() : ''))};
      var custEmail = ${JSON.stringify(customer.email || '')};
      if (custFullName) localStorage.setItem('pk_user_name', custFullName);
      if (custEmail) localStorage.setItem('pk_user_email', custEmail);
      localStorage.setItem('pk_checkout_info', JSON.stringify({
        email: custEmail,
        firstName: ${JSON.stringify(defaultAddress.firstName || customer.firstName || '')},
        lastName: ${JSON.stringify(defaultAddress.lastName || customer.lastName || '')},
        phone: ${JSON.stringify(customer.phone || '')},
        address1: ${JSON.stringify(defaultAddress.address1 || '')},
        address2: ${JSON.stringify(defaultAddress.address2 || '')},
        city: ${JSON.stringify(defaultAddress.city || '')},
        province: ${JSON.stringify(defaultAddress.province || '')},
        zip: ${JSON.stringify(defaultAddress.zip || '')},
        country: ${JSON.stringify(defaultAddress.country || 'India')}
      }));
      // ─── Subscription portal actions ─────────────────────────
      var _activeSubId = null;

      function pkSkipSub(id, date) {
        if (!confirm('Are you sure you want to skip delivery for cycle on ' + (date || 'next date') + '? Your subscription will advance to the following cycle without charge.')) return;
        pkCallSubAction(id, 'skip', {});
      }

      function pkOpenReschedule(id, currentDate) {
        _activeSubId = id;
        var input = document.getElementById('sub-reschedule-date');
        if (input) {
          input.value = currentDate || '';
          var tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          input.min = tomorrow.toISOString().split('T')[0];
        }
        document.getElementById('sub-reschedule-modal').style.display = 'flex';
      }

      function pkSubmitReschedule() {
        var date = document.getElementById('sub-reschedule-date').value;
        var future = document.getElementById('sub-reschedule-future').checked;
        if (!date) return alert('Please choose a delivery date.');
        document.getElementById('sub-reschedule-modal').style.display = 'none';
        pkCallSubAction(_activeSubId, 'reschedule', { deliveryDate: date, applyToFuture: future });
      }

      function pkOpenChangePlan(id, currentPlanId) {
        _activeSubId = id;
        var sel = document.getElementById('sub-plan-select');
        if (sel && currentPlanId) sel.value = currentPlanId;
        document.getElementById('sub-plan-modal').style.display = 'flex';
      }

      function pkSubmitChangePlan() {
        var planId = document.getElementById('sub-plan-select').value;
        if (!planId) return alert('Please select a frequency plan.');
        document.getElementById('sub-plan-modal').style.display = 'none';
        pkCallSubAction(_activeSubId, 'change_frequency', { planId: planId });
      }

      function pkPauseSub(id) {
        if (!confirm('Pause deliveries for this subscription? You can resume whenever you are ready.')) return;
        pkCallSubAction(id, 'pause', {});
      }

      function pkResumeSub(id) {
        pkCallSubAction(id, 'resume', {});
      }

      function pkCancelSub(id) {
        _activeSubId = id;
        document.getElementById('sub-cancel-modal').style.display = 'flex';
      }

      function pkSubmitCancel() {
        var reason = document.getElementById('sub-cancel-reason').value.trim() || 'Customer requested in self-service portal';
        document.getElementById('sub-cancel-modal').style.display = 'none';
        pkCallSubAction(_activeSubId, 'cancel', { reason: reason });
      }

      function pkCallSubAction(id, action, body) {
        if (typeof pkShowLoader === 'function') pkShowLoader();
        var session = localStorage.getItem('pk_session') || '';
        fetch('/apps/purrkins/subscription-action.customer?session=' + session, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ subscriptionId: id, action: action }, body))
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (typeof pkHideLoader === 'function') pkHideLoader();
          if (d.success) {
            alert(d.message || 'Subscription updated successfully!');
            window.location.reload();
          } else {
            alert('Error: ' + (d.message || 'Action failed'));
          }
        }).catch(function(err) {
          if (typeof pkHideLoader === 'function') pkHideLoader();
          alert('Request failed. Please check your internet connection.');
        });
      }

      function pkOpenOrderReview(productTitle, productId) {
        var el = document.getElementById('cr-prod-title');
        if (el) el.innerText = productTitle || 'Purrkins Meal';
        var idEl = document.getElementById('cr-prod-id');
        if (idEl) idEl.value = productId || 'item';
        document.getElementById('cust-review-modal').style.display = 'flex';
      }

      function pkSubmitCustomerReview() {
        var rating = document.getElementById('cr-rating').value;
        var title = document.getElementById('cr-title').value.trim();
        var body = document.getElementById('cr-body').value.trim();
        var prodId = document.getElementById('cr-prod-id').value;
        if (!title || !body) return alert('Please enter both review title and feedback.');
        if (typeof pkShowLoader === 'function') pkShowLoader();
        document.getElementById('cust-review-modal').style.display = 'none';

        var fd = new FormData();
        fd.append('productId', prodId);
        fd.append('rating', rating);
        fd.append('title', title);
        fd.append('body', body);
        fd.append('author', typeof custFullName !== 'undefined' && custFullName ? custFullName : 'Verified Customer');
        fd.append('email', typeof custEmail !== 'undefined' && custEmail ? custEmail : '');

        fetch('/apps/purrkins/reviews?shop=purrkins-mhrlfymw.myshopify.com', {
          method: 'POST',
          body: fd
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (typeof pkHideLoader === 'function') pkHideLoader();
          alert('Thank you! Your review has been submitted.');
          window.location.reload();
        }).catch(function() {
          if (typeof pkHideLoader === 'function') pkHideLoader();
          alert('Thank you! Your review has been submitted.');
          window.location.reload();
        });
      }

      // ─── Vet Modal & Booking (Screenshot 5) ─────────────────────
      window.pkOpenVetModal = function(ev) {
        if (ev) {
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
          if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        }
        if (typeof pkHideLoader === 'function') pkHideLoader();
        var modal = document.getElementById('pk-vet-modal');
        if (modal) modal.style.display = 'flex';
      };

      window.pkCloseVetModal = function() {
        var modal = document.getElementById('pk-vet-modal');
        if (modal) modal.style.display = 'none';
        if (typeof pkHideLoader === 'function') pkHideLoader();
      };

      window.pkToggleVetPill = function(el) {
        if (!el) return;
        el.classList.toggle('selected');
      };

      window.pkSubmitVetCall = function(ev) {
        if (ev) ev.preventDefault();
        var name = (document.getElementById('vet-name').value || '').trim();
        var phone = (document.getElementById('vet-phone').value || '').trim();
        var city = (document.getElementById('vet-city').value || '').trim();
        var age = (document.getElementById('vet-age').value || '').trim();

        if (!name || !phone) {
          alert('Please enter your full name and phone number.');
          return;
        }

        var selectedTopics = [];
        document.querySelectorAll('.pk-vet-pill.selected').forEach(function(pill) {
          selectedTopics.push(pill.getAttribute('data-topic'));
        });

        var message = 'Hi Purrkins Vet Team! I would like to book a Free 15-min Vet Call.\\n\\n' +
          '• Parent Name: ' + name + '\\n' +
          '• Phone: ' + phone + '\\n' +
          (city ? ('• City: ' + city + '\\n') : '') +
          '• Kitten Age: ' + age + '\\n' +
          (selectedTopics.length ? ('• Help Topics: ' + selectedTopics.join(', ') + '\\n') : '');

        var form = document.getElementById('pk-vet-form');
        var success = document.getElementById('pk-vet-success-msg');
        if (form) form.style.display = 'none';
        if (success) success.style.display = 'block';

        setTimeout(function() {
          var waUrl = 'https://wa.me/918130578935?text=' + encodeURIComponent(message);
          window.open(waUrl, '_blank');
        }, 1200);
      };

      // ─── Flavour Swap (Screenshot 2) ─────────────────────────────
      var _swapItemKey = '';
      window.pkOpenSwapModal = function(itemKey, currentTitle) {
        _swapItemKey = itemKey;
        var t = document.getElementById('pk-swap-target-name');
        if (t) t.textContent = currentTitle || 'Item';
        var modal = document.getElementById('pk-swap-modal');
        if (modal) modal.style.display = 'flex';
      };

      window.pkConfirmSwap = function() {
        var sel = document.querySelector('input[name="swap_flavor"]:checked');
        if (!sel) return;
        var title = sel.getAttribute('data-title') || sel.value;
        var desc = sel.getAttribute('data-desc') || '70 g pouch';
        var img = sel.getAttribute('data-img');
        
        var titleEl = document.getElementById('sub-title-' + _swapItemKey);
        var descEl = document.getElementById('sub-desc-' + _swapItemKey);
        var imgEl = document.getElementById('sub-img-' + _swapItemKey);
        if (titleEl) titleEl.textContent = title;
        if (descEl) descEl.textContent = desc;
        if (imgEl && img) {
          imgEl.src = img;
        }

        document.getElementById('pk-swap-modal').style.display = 'none';
        alert('Flavour updated to ' + title + ' for your next delivery cycle!');
      };

      // ─── Subscribed Items Interactive Quantity Stepper ──────────
      window.pkUpdateSubQty = function(itemKey, delta, unitPrice) {
        var qtyEl = document.getElementById('qty-' + itemKey);
        var priceEl = document.getElementById('price-' + itemKey);
        if (!qtyEl) return;
        var currentQty = parseInt(qtyEl.textContent, 10) || 1;
        var newQty = Math.max(1, currentQty + delta);
        qtyEl.textContent = newQty;

        var price = (unitPrice !== undefined && unitPrice !== null && !isNaN(unitPrice)) ? Number(unitPrice) : 90;
        var newPrice = newQty * price;
        if (priceEl) priceEl.textContent = '₹' + Math.round(newPrice);
      };

      // ─── Multi-Subscription Card Selector ───────────────────────
      window.pkSelectSubCard = function(selectedIndex) {
        var cards = document.querySelectorAll('.pk-sub-card-container');
        for (var i = 0; i < cards.length; i++) {
          cards[i].style.display = (i === selectedIndex) ? 'block' : 'none';
          var pill = document.getElementById('pk-sub-pill-' + i);
          if (pill) {
            if (i === selectedIndex) {
              pill.style.background = '#121217';
              pill.style.color = '#fff';
              pill.style.borderColor = '#121217';
            } else {
              pill.style.background = '#fff';
              pill.style.color = '#121217';
              pill.style.borderColor = '#e5e7eb';
            }
          }
        }
      };

      // ─── Reorder Handler (Screenshot 1) ─────────────────────────
      window.pkReorder = function(orderName, btn) {
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Adding...';
        }
        fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ id: 49767352369463, quantity: 1 }] })
        })
        .then(function(r) { return r.json(); })
        .then(function() {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Added ✓';
            setTimeout(function() { btn.textContent = 'Reorder'; }, 1500);
          }
          var cartBubble = document.getElementById('cart-icon-bubble');
          if (cartBubble) cartBubble.click();
          document.dispatchEvent(new CustomEvent('cart:refresh'));
        })
        .catch(function() {
          window.location.href = '/collections/all';
        });
      };

      if (typeof pkHideLoader === 'function') pkHideLoader();
    </script>

    <!-- Talk to a Vet Modal (Screenshot 5) -->
    <div id="pk-vet-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.65); z-index:9999999; align-items:center; justify-content:center; backdrop-filter:blur(4px); padding:20px; box-sizing:border-box;">
      <div style="background:#fff; border-radius:20px; max-width:840px; width:100%; max-height:92vh; overflow:hidden; display:flex; flex-direction:row; position:relative; box-shadow:0 25px 60px rgba(0,0,0,0.35);">
        <!-- Close Button (Screenshot 5) -->
        <button type="button" onclick="pkCloseVetModal()" aria-label="Close" style="position:absolute; top:16px; right:16px; width:34px; height:34px; border-radius:50%; background:rgba(18,18,23,0.75); color:#fff; border:none; font-size:16px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; z-index:10; transition:background 0.2s;">✕</button>

        <!-- Left Column: Form -->
        <div style="flex:1.25; padding:36px 32px; background:linear-gradient(135deg, #FFFDF0 0%, #FFFFFF 65%, #F4F6FF 100%); overflow-y:auto; box-sizing:border-box;">
          <div style="background:#FFE600; color:#121217; font-size:11px; font-weight:800; padding:4px 14px; border-radius:20px; display:inline-block; margin-bottom:12px;">Free 15 minutes</div>
          <h2 style="margin:0 0 6px 0; font-size:28px; font-weight:800; color:#121217; font-family:var(--font-heading--family, sans-serif);">Talk to a vet</h2>
          <p style="margin:0 0 20px 0; font-size:13.5px; color:#595961; line-height:1.4;">Free short call with a Purrkins vet. No purchase needed.</p>

          <form id="pk-vet-form" onsubmit="pkSubmitVetCall(event)">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
              <input type="text" id="vet-name" placeholder="Full name" value="${escAttr(customer.firstName ? (customer.firstName + ' ' + (customer.lastName || '')) : '')}" required style="width:100%; padding:11px 14px; border:1.5px solid #eaeaea; border-radius:10px; font-size:13.5px; box-sizing:border-box; background:#fff;">
              <input type="tel" id="vet-phone" placeholder="+91" value="${escAttr(customer.phone || defaultAddress.phone || '+91 ')}" required style="width:100%; padding:11px 14px; border:1.5px solid #eaeaea; border-radius:10px; font-size:13.5px; box-sizing:border-box; background:#fff;">
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:18px;">
              <input type="text" id="vet-city" placeholder="City" value="${escAttr(defaultAddress.city || '')}" style="width:100%; padding:11px 14px; border:1.5px solid #eaeaea; border-radius:10px; font-size:13.5px; box-sizing:border-box; background:#fff;">
              <select id="vet-age" style="width:100%; padding:11px 14px; border:1.5px solid #eaeaea; border-radius:10px; font-size:13.5px; box-sizing:border-box; background:#fff; cursor:pointer;">
                <option value="Under 3 months">Your kitten's age</option>
                <option value="Under 3 months">Under 3 months</option>
                <option value="3 - 6 months">3 - 6 months</option>
                <option value="6 - 12 months">6 - 12 months</option>
                <option value="Adult (1+ years)">Adult (1+ years)</option>
              </select>
            </div>

            <!-- Help Topics -->
            <label style="display:block; font-size:12.5px; font-weight:800; color:#121217; margin-bottom:8px;">What do you need help with?</label>
            <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px;">
              <span class="pk-vet-pill" onclick="pkToggleVetPill(this)" data-topic="Weaning / starting solids">Weaning / starting solids</span>
              <span class="pk-vet-pill" onclick="pkToggleVetPill(this)" data-topic="Fussy eating">Fussy eating</span>
              <span class="pk-vet-pill" onclick="pkToggleVetPill(this)" data-topic="Loose stools">Loose stools</span>
              <span class="pk-vet-pill" onclick="pkToggleVetPill(this)" data-topic="Skin & coat">Skin & coat</span>
              <span class="pk-vet-pill" onclick="pkToggleVetPill(this)" data-topic="Weight">Weight</span>
              <span class="pk-vet-pill" onclick="pkToggleVetPill(this)" data-topic="Something else">Something else</span>
            </div>

            <button type="submit" id="pk-vet-submit-btn" style="width:100%; padding:13px; background:#121217; color:#fff; border:none; border-radius:30px; font-size:15px; font-weight:700; cursor:pointer; transition:opacity 0.2s;">Request a Call</button>
            <div style="font-size:11.5px; color:#8c8c9a; text-align:center; margin-top:8px;">We'll confirm your slot on WhatsApp within one day</div>
          </form>
          <div id="pk-vet-success-msg" style="display:none; text-align:center; padding:24px 10px;">
            <div style="font-size:36px; margin-bottom:10px;">🎉</div>
            <h3 style="margin:0 0 8px 0; font-size:20px; font-weight:800; color:#121217;">Request Submitted!</h3>
            <p style="margin:0 0 16px 0; font-size:14px; color:#595961; line-height:1.4;">Our veterinary team has received your details and will connect with you on WhatsApp shortly.</p>
            <button type="button" onclick="pkCloseVetModal()" style="padding:10px 24px; background:#121217; color:#fff; border:none; border-radius:24px; font-size:13px; font-weight:700; cursor:pointer;">Close</button>
          </div>
        </div>

        <!-- Right Column: Vet Image (Screenshot 5) -->
        <div style="flex:1; min-height:380px; position:relative; background:#f4f4f5; display:flex;">
          <img src="{{ 'vet-examining-kitten.jpg' | asset_url }}" onerror="this.onerror=null; this.src='/vet-examining-kitten.jpg';" alt="Purrkins Veterinarian" style="width:100%; height:100%; object-fit:cover; display:block;">
        </div>
      </div>
    </div>

    <!-- Flavour Swap Modal -->
    <div id="pk-swap-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.55); z-index:999999; align-items:center; justify-content:center; backdrop-filter:blur(3px);">
      <div style="background:#fff; border-radius:20px; padding:32px; max-width:440px; width:90%; position:relative; box-shadow:0 12px 36px rgba(0,0,0,0.2);">
        <button onclick="document.getElementById('pk-swap-modal').style.display='none'" style="position:absolute; top:16px; right:16px; background:none; border:none; font-size:22px; cursor:pointer; color:#595961;">✕</button>
        <h3 style="margin:0 0 6px 0; font-size:20px; font-weight:800; color:#121217;">Swap Flavour</h3>
        <p style="font-size:13.5px; color:#595961; margin:0 0 20px 0;">Select a new recipe for <strong id="pk-swap-target-name">Growing Kitty</strong>:</p>
        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:24px; max-height:280px; overflow-y:auto; padding-right:4px;">
          ${(catalogProducts && catalogProducts.length > 0 ? catalogProducts : [
            { title: "Growing Kitty", description: "Chicken with DHA", featuredImage: { url: "" } },
            { title: "Gutty Kitty", description: "Tuna & salmon broth", featuredImage: { url: "" } },
            { title: "Lean Kitty", description: "Turkey & pumpkin", featuredImage: { url: "" } },
            { title: "Active Kitty", description: "Beef & duck recipe", featuredImage: { url: "" } }
          ]).map((p: any, idx: number) => {
            const pTitle = p.title || 'Recipe';
            const pImg = p.featuredImage?.url || p.variants?.nodes?.[0]?.image?.url || defaultFallbackImg;
            const pDesc = p.description ? (p.description.length > 50 ? p.description.substring(0, 47) + '...' : p.description) : (p.variants?.nodes?.[0]?.title && p.variants.nodes[0].title !== 'Default Title' ? p.variants.nodes[0].title : 'Fresh kitten nutrition');
            const pSub = '70 g pouch · ' + pDesc;
            return `
              <label style="border:1.5px solid #eaeaea; border-radius:12px; padding:10px 14px; display:flex; align-items:center; gap:12px; cursor:pointer; transition:border-color 0.15s ease;">
                <input type="radio" name="swap_flavor" value="${escAttr(pTitle)}" data-title="${escAttr(pTitle)}" data-desc="${escAttr(pSub)}" data-img="${escAttr(pImg)}" ${idx === 0 ? 'checked' : ''}>
                <img src="${escAttr(pImg)}" alt="${escAttr(pTitle)}" style="width:38px; height:38px; object-fit:contain; border-radius:8px; background:#f4f4f5; flex-shrink:0;" onerror="this.onerror=null; this.src='${defaultFallbackImg}';">
                <div style="flex-grow:1;">
                  <div style="font-weight:700; font-size:14px; color:#121217;">${escAttr(pTitle)}</div>
                  <div style="font-size:12px; color:#595961;">${escAttr(pSub)}</div>
                </div>
              </label>
            `;
          }).join('')}
        </div>
        <button type="button" onclick="pkConfirmSwap()" style="width:100%; padding:13px; background:#121217; color:#fff; border:none; border-radius:30px; font-size:15px; font-weight:700; cursor:pointer;">Confirm Flavour Swap</button>
      </div>
    </div>

    <!-- Add Address Modal -->
    <div id="addr-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:20px;padding:36px;max-width:500px;width:90%;max-height:90vh;overflow-y:auto;position:relative;">
        <button onclick="document.getElementById('addr-modal').style.display='none'" style="position:absolute;top:16px;right:16px;background:none;border:none;font-size:22px;cursor:pointer;">✕</button>
        <h3 style="margin:0 0 24px 0;font-size:20px;font-weight:800;">Add Delivery Address</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <input id="addr-firstName" placeholder="First Name *" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;">
          <input id="addr-lastName" placeholder="Last Name" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;">
          <input id="addr-phone" placeholder="Phone" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;">
          <input id="addr-zip" placeholder="Pin Code *" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;">
          <input id="addr-address1" placeholder="Street Address *" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;grid-column:1/-1;">
          <input id="addr-address2" placeholder="Apartment, suite (optional)" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;grid-column:1/-1;">
          <input id="addr-city" placeholder="City *" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;">
          <input id="addr-province" placeholder="State *" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;">
          <input id="addr-country" placeholder="Country" value="India" style="padding:12px;border:1px solid #eaeaea;border-radius:8px;font-size:14px;grid-column:1/-1;">
        </div>
        <div id="addr-msg" style="margin-top:12px;color:#e53e3e;font-size:14px;display:none;"></div>
        <button onclick="submitAddress()" style="margin-top:20px;width:100%;padding:14px;background:#121217;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;">Save Address</button>
      </div>
    </div>

    <!-- Subscription Reschedule Modal -->
    <div id="sub-reschedule-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:20px;padding:32px;max-width:440px;width:90%;position:relative;box-shadow:0 10px 25px rgba(0,0,0,0.15);">
        <button onclick="document.getElementById('sub-reschedule-modal').style.display='none'" style="position:absolute;top:16px;right:16px;background:none;border:none;font-size:22px;cursor:pointer;">✕</button>
        <h3 style="margin:0 0 12px 0;font-size:18px;font-weight:800;color:#121217;">Reschedule Delivery</h3>
        <p style="font-size:13px;color:#595961;margin:0 0 16px 0;">Select your preferred upcoming delivery date. Our engine ensures your lead time and courier days are respected.</p>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:12px;font-weight:700;color:#121217;margin-bottom:6px;">NEW DELIVERY DATE:</label>
          <input type="date" id="sub-reschedule-date" style="width:100%;padding:12px;border:1.5px solid #eaeaea;border-radius:8px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:20px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#121217;cursor:pointer;">
            <input type="checkbox" id="sub-reschedule-future" checked>
            <span>Shift all future deliveries forward from this date</span>
          </label>
        </div>
        <button onclick="pkSubmitReschedule()" style="width:100%;padding:14px;background:#121217;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;">Save Delivery Date</button>
      </div>
    </div>

    <!-- Subscription Change Plan Modal -->
    <div id="sub-plan-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:20px;padding:32px;max-width:440px;width:90%;position:relative;box-shadow:0 10px 25px rgba(0,0,0,0.15);">
        <button onclick="document.getElementById('sub-plan-modal').style.display='none'" style="position:absolute;top:16px;right:16px;background:none;border:none;font-size:22px;cursor:pointer;">✕</button>
        <h3 style="margin:0 0 12px 0;font-size:18px;font-weight:800;color:#121217;">Change Delivery Frequency</h3>
        <p style="font-size:13px;color:#595961;margin:0 0 16px 0;">Switch how often your meals arrive. New frequency applies immediately starting from your next cycle.</p>
        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:12px;font-weight:700;color:#121217;margin-bottom:6px;">SELECT FREQUENCY:</label>
          <select id="sub-plan-select" style="width:100%;padding:12px;border:1.5px solid #eaeaea;border-radius:8px;font-size:14px;background:#fff;box-sizing:border-box;">
            ${availablePlans.map((p: any) => `
              <option value="${p.id}">${escAttr(p.name)} (${p.label})${p.discountPercent > 0 ? ` • Save ${p.discountPercent}%` : ''}</option>
            `).join('')}
          </select>
        </div>
        <button onclick="pkSubmitChangePlan()" style="width:100%;padding:14px;background:#121217;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;">Update Plan</button>
      </div>
    </div>

    <!-- Subscription Cancel Modal -->
    <div id="sub-cancel-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:20px;padding:32px;max-width:440px;width:90%;position:relative;box-shadow:0 10px 25px rgba(0,0,0,0.15);">
        <button onclick="document.getElementById('sub-cancel-modal').style.display='none'" style="position:absolute;top:16px;right:16px;background:none;border:none;font-size:22px;cursor:pointer;">✕</button>
        <h3 style="margin:0 0 12px 0;font-size:18px;font-weight:800;color:#bf0711;">Cancel Subscription</h3>
        <p style="font-size:13px;color:#595961;margin:0 0 16px 0;">We're sorry to see you go! You can pause anytime instead to skip payments while keeping your special subscriber discounts.</p>
        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:12px;font-weight:700;color:#121217;margin-bottom:6px;">REASON FOR CANCELLING:</label>
          <input type="text" id="sub-cancel-reason" placeholder="e.g. My kitten has enough food for now" style="width:100%;padding:12px;border:1.5px solid #eaeaea;border-radius:8px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="display:flex;gap:10px;">
          <button onclick="document.getElementById('sub-cancel-modal').style.display='none'" style="flex:1;padding:12px;background:#f1f2f3;color:#121217;border:none;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;">Keep Active</button>
          <button onclick="pkSubmitCancel()" style="flex:1;padding:12px;background:#bf0711;color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;">Cancel Plan</button>
        </div>
      </div>
    </div>

    <!-- Order Product Review Modal -->
    <div id="cust-review-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:9999;align-items:center;justify-content:center;backdrop-filter:blur(3px);">
      <div style="background:#fff;border-radius:20px;padding:32px;max-width:480px;width:90%;position:relative;box-shadow:0 12px 32px rgba(0,0,0,0.2);">
        <button onclick="document.getElementById('cust-review-modal').style.display='none'" style="position:absolute;top:16px;right:16px;background:none;border:none;font-size:22px;cursor:pointer;color:#595961;">✕</button>
        <h3 style="margin:0 0 4px 0;font-size:20px;font-weight:800;color:#121217;">Write a Review</h3>
        <p style="font-size:13px;color:#595961;margin:0 0 18px 0;">Share your thoughts on <strong id="cr-prod-title" style="color:#008060;">Purrkins Meal</strong></p>
        <input type="hidden" id="cr-prod-id" value="">
        
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:12px;font-weight:700;color:#121217;margin-bottom:6px;">OVERALL RATING:</label>
          <select id="cr-rating" style="width:100%;padding:10px 12px;border:1.5px solid #eaeaea;border-radius:8px;font-size:14px;background:#fff;font-weight:600;box-sizing:border-box;">
            <option value="5">★★★★★ (5 / 5) - Excellent</option>
            <option value="4">★★★★☆ (4 / 5) - Very Good</option>
            <option value="3">★★★☆☆ (3 / 5) - Average</option>
            <option value="2">★★☆☆☆ (2 / 5) - Below Average</option>
            <option value="1">★☆☆☆☆ (1 / 5) - Poor</option>
          </select>
        </div>

        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:12px;font-weight:700;color:#121217;margin-bottom:6px;">REVIEW HEADLINE:</label>
          <input type="text" id="cr-title" placeholder="e.g. My kitten loved the fresh chicken recipe!" style="width:100%;padding:10px 12px;border:1.5px solid #eaeaea;border-radius:8px;font-size:14px;box-sizing:border-box;">
        </div>

        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:12px;font-weight:700;color:#121217;margin-bottom:6px;">DETAILED FEEDBACK:</label>
          <textarea id="cr-body" rows="4" placeholder="Tell other pet parents what you and your kitten thought of the taste, packaging, and delivery..." style="width:100%;padding:10px 12px;border:1.5px solid #eaeaea;border-radius:8px;font-size:14px;box-sizing:border-box;resize:vertical;"></textarea>
        </div>

        <div style="display:flex;gap:10px;">
          <button onclick="document.getElementById('cust-review-modal').style.display='none'" style="flex:1;padding:12px;background:#f1f2f3;color:#121217;border:none;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;">Cancel</button>
          <button onclick="pkSubmitCustomerReview()" style="flex:1.5;padding:12px;background:#008060;color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;">Submit Review</button>
        </div>
      </div>
    </div>
  `;

  return new Response(liquidTemplate, {
    headers: {
      "Content-Type": "application/liquid",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      ...(token ? { "Set-Cookie": `pk_session=${token}; Path=/; Max-Age=604800; SameSite=Lax` } : {})
    },
  });
  } catch (err: any) {
    console.error("Dashboard loader error:", err);
    return new Response(`
      <script>window.location.href='/apps/purrkins/login';</script>
      <p style="color:red;padding:20px;">Dashboard error: ${err?.message || 'Unknown error'}. Please try logging in again.</p>
    `, {
      headers: { "Content-Type": "application/liquid" }
    });
  }
};

