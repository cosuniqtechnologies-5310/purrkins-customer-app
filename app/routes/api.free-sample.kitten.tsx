import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import jwt from "jsonwebtoken";
import { unauthenticated } from "../shopify.server";
import { getLoaderHtml } from "../loader-snippet";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
  const url = new URL(request.url);
  const petIndex = parseInt(url.searchParams.get("pet_index") || "0", 10);
  const cookieHeader = request.headers.get("Cookie");
  const cookieMatch = cookieHeader ? cookieHeader.match(/pk_session=([^;]+)/) : null;
  const cookieToken = cookieMatch ? cookieMatch[1] : null;
  const token = url.searchParams.get("session") || cookieToken;
  let customerId: string | null = null;
  let isTokenPresentAndInvalid = false;
  let customerFirstName = "Friend";

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
          window.location.href = currentUrl.toString();
        } else {
          // No token anywhere, go to login.
          window.location.href = '/apps/purrkins/login';
        }
      </script>
    `, { headers: { 
      "Content-Type": "application/liquid",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    } });
  }

  // Use unauthenticated.admin to ensure token refresh is handled
  const { admin } = await unauthenticated.admin("purrkins-mhrlfymw.myshopify.com");
  if (!admin) {
    console.error("Admin access denied");
    return new Response("<script>window.location.href='/apps/purrkins/login';</script>", {
      headers: { "Content-Type": "application/liquid" }
    });
  }

  let pets: any[] = [];
  const gqlRes = await admin.graphql(`
    query($id: ID!) {
      customer(id: $id) {
        firstName
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
                subscription: field(key: "subscription_products") {
                  references(first: 10) {
                    nodes {
                      ... on Product {
                        id
                        title
                        handle
                        featuredImage { url }
                        variants(first: 1) { edges { node { id title price } } }
                      }
                    }
                  }
                }
                profile: field(key: "profile") {
                  reference {
                    ... on MediaImage {
                      image { url }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { id: customerId } });

  const gqlData = await gqlRes.json() as any;
    console.log("Kitten GQL errors:", JSON.stringify(gqlData?.errors));
    console.log("Kitten customer:", JSON.stringify(gqlData?.data?.customer?.firstName));
    customerFirstName = gqlData?.data?.customer?.firstName || "Friend";
    pets = gqlData?.data?.customer?.pets?.references?.nodes || [];


  const activePet = pets[petIndex] || null;

  let allProducts: any[] = [];
  try {
    const productRes = await admin.graphql(`
      query {
        products(first: 100) {
          edges {
            node {
              handle
              title
              tags
              featuredImage { url }
              variants(first:1) { edges { node { id } } }
              metafield(namespace: "custom", key: "short_description") { value }
            }
          }
        }
      }
    `);
    const productData = await productRes.json() as any;
    allProducts = productData?.data?.products?.edges?.map((e:any) => e.node) || [];
  } catch (e) {
    console.error("Failed to fetch products for recommendations", e);
  }

  // ── Subscription orders (Shopify Subscriptions app) ──────────
  // Contracts owned by Shopify's Subscriptions app can't be read by custom apps, but every
  // subscription purchase is an order line item with a selling plan, which read_orders allows.
  type SubItem = {
    handle: string; title: string; imageUrl: string; variantTitle: string;
    price: number; quantity: number; planName: string; deliveries: number; lastOrdered: string;
    tags: string[];
  };
  const orderSubItems = new Map<string, SubItem>();
  try {
    const ordersRes = await admin.graphql(`
      query($id: ID!) {
        customer(id: $id) {
          orders(first: 50, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                processedAt
                cancelledAt
                lineItems(first: 20) {
                  edges {
                    node {
                      quantity
                      sellingPlan { name }
                      originalUnitPriceSet { shopMoney { amount } }
                      variant { title }
                      product { handle title tags featuredImage { url } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { variables: { id: customerId } });
    const ordersData = await ordersRes.json() as any;
    if (ordersData?.errors) console.error("Kitten orders GQL errors:", JSON.stringify(ordersData.errors));
    const orderEdges = ordersData?.data?.customer?.orders?.edges || [];
    for (const oe of orderEdges) {
      if (oe.node.cancelledAt) continue;
      for (const le of oe.node.lineItems?.edges || []) {
        const li = le.node;
        if (!li.sellingPlan || !li.product?.handle) continue; // only subscription purchases
        const existing = orderSubItems.get(li.product.handle);
        if (existing) { existing.deliveries += 1; continue; }  // orders are newest-first
        orderSubItems.set(li.product.handle, {
          handle: li.product.handle,
          title: li.product.title,
          imageUrl: li.product.featuredImage?.url || "",
          variantTitle: li.variant?.title && li.variant.title !== "Default Title" ? li.variant.title : "",
          price: parseFloat(li.originalUnitPriceSet?.shopMoney?.amount || "0") || 0,
          quantity: li.quantity || 1,
          planName: li.sellingPlan?.name || "",
          deliveries: 1,
          lastOrdered: oe.node.processedAt || "",
          tags: (li.product.tags || []).map((t: string) => String(t).toLowerCase()),
        });
      }
    }
  } catch (e) {
    console.error("Failed to fetch subscription orders", e);
  }

  // ── Per-pet helpers ──────────────────────────────────────────
  const esc = (v: any) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const optionsHtml = (current: any, opts: string[]) => opts.map(o => `<option value="${o}" ${current === o ? 'selected' : ''}>${o}</option>`).join('');
  const petName = activePet?.name?.value || "Kitten";

  // Match a product (by tags/title) against ONE pet's quiz answers. Returns -1 if it hits an allergy.
  const STOP_WORDS = new Set(["and", "the", "for", "with", "cat", "cats", "week", "weeks", "month", "months", "year", "years", "old", "none", "nil", "not", "any"]);
  const tokenize = (s: any): string[] =>
    String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const splitList = (s: any): string[] =>
    String(s ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

  const scoreForPet = (pet: any, rawTags: string[], title: string): number => {
    if (!pet) return 0;
    const tags = (rawTags || []).map((t) => String(t).toLowerCase());
    const prodTokens = new Set<string>([...tags.flatMap(tokenize), ...tokenize(title)]);

    for (const a of tokenize(pet.allergies?.value)) if (prodTokens.has(a)) return -1;

    let score = 0;
    for (const phrase of splitList(pet.focus?.value)) {
      const phraseHit = tags.some((t) => t.includes(phrase) || (t.length > 2 && phrase.includes(t)));
      if (phraseHit) score += 3;
      else if (tokenize(phrase).some((w) => prodTokens.has(w))) score += 2;
    }
    const generalTokens = new Set<string>([
      ...tokenize(pet.age?.value), 
      ...tokenize(pet.weight?.value), 
      ...tokenize(pet.gender?.value), 
      ...tokenize(pet.neutered?.value), 
      ...tokenize(pet.body?.value), 
      ...tokenize(pet.activity?.value),
    ]);
    for (const w of generalTokens) if (prodTokens.has(w)) score += 1;
    return score;
  };

  // Subscription products for THIS pet:
  //  1) products set on the pet profile (metaobject field "subscription_products"), plus
  //  2) the customer's subscription-order products that fit this pet's quiz
  //     (with a single pet, every subscription product belongs to it)
  const subscriptionMap = new Map<string, SubItem>();
  for (const p of (activePet?.subscription?.references?.nodes || []).filter((n: any) => n?.title)) {
    const v = p.variants?.edges?.[0]?.node;
    subscriptionMap.set(p.handle, {
      handle: p.handle, title: p.title, imageUrl: p.featuredImage?.url || "",
      variantTitle: v?.title && v.title !== "Default Title" ? v.title : "",
      price: parseFloat(v?.price || "0") || 0, quantity: 1, planName: "", deliveries: 0, lastOrdered: "", tags: [],
    });
  }
  for (const item of orderSubItems.values()) {
    const belongs = pets.length <= 1 || scoreForPet(activePet, item.tags, item.title) > 0;
    if (belongs) subscriptionMap.set(item.handle, item);
  }
  const subscriptionProducts: SubItem[] = Array.from(subscriptionMap.values());
  const hasSubscription = !!activePet && subscriptionProducts.length > 0;
  const subscriptionTotal = subscriptionProducts.reduce((sum, p) => sum + p.price * p.quantity, 0);
  const subscribedHandles = new Set(subscriptionProducts.map((p) => p.handle));
  const subscriptionPlanName = subscriptionProducts.find((p) => p.planName)?.planName || "";
  const subscriptionDeliveries = Math.max(0, ...subscriptionProducts.map((p) => p.deliveries));
  const subscriptionLastOrdered = subscriptionProducts.map((p) => p.lastOrdered).filter(Boolean).sort().pop() || "";

  // Recommendations: score every product against THIS pet's quiz answers using product tags
  const recommendedProducts: any[] = !activePet ? [] : allProducts
    .filter((prod) => !subscribedHandles.has(prod.handle))
    .map((prod) => ({ prod, score: scoreForPet(activePet, prod.tags || [], prod.title) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((x) => x.prod);

  // Build pet pills HTML
  const petPillsHtml = pets.map((pet: any, i: number) => {
    const name = pet.name?.value || "Kitten";
    const imgUrl = pet.profile?.reference?.image?.url;
    const isActive = i === petIndex;
    const queryParam = `?pet_index=${i}`;
    return `
      <a href="/apps/purrkins/kitten${queryParam}" class="pk-pet-pill ${isActive ? 'active' : ''}">
        <div class="pk-pet-avatar" ${!isActive ? 'style="background:#e0e0e0;"' : ''}>
          ${imgUrl ? `<img src="${imgUrl}" style="${!isActive ? 'opacity:0.6' : ''}" alt="${name}">` :
          `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="#d1d1d1" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`}
        </div>
        <div class="pk-pet-info">
          <strong>${name}</strong>
          <span>${pet.age?.value || 'Unknown'}</span>
        </div>
      </a>
    `;
  }).join('');

  // Build current pet content
  const petContentHtml = activePet ? `
    <!-- PROFILE CARD -->
    <div class="pk-card pk-profile-card">
      <div class="pk-card-header">
        <h2>${activePet.name?.value || 'Kitten'}'s profile</h2>
        <button class="pk-outline-btn" id="edit-details-btn" style="border-radius:30px; cursor:pointer; background:none;">Edit Details</button>
      </div>
      <div id="profile-view-mode" class="pk-profile-details" style="display:flex; gap:30px; align-items:flex-start; margin-top:20px;">
        <div class="pk-profile-photo" style="flex-shrink:0; width:150px; height:150px; overflow:hidden; border-radius:16px; background:#f4f4f5; display:flex; align-items:center; justify-content:center;">
          ${activePet.profile?.reference?.image?.url
            ? `<img src="${activePet.profile.reference.image.url}" alt="${activePet.name?.value || ''}" style="width:100%; height:100%; object-fit:cover;">`
            : `<svg width="60%" height="60%" viewBox="0 0 24 24" fill="#d1d1d1" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`}
        </div>
        <div class="pk-profile-stats-grid" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:x 20px; row-gap:24px; flex-grow:1;">
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Age</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">${activePet.age?.value || '-'}</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Weight</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">${activePet.weight?.value ? activePet.weight.value + ' kg' : '-'}</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Breed</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">Indie</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Sex</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">${activePet.gender?.value || '-'}, ${activePet.neutered?.value?.toLowerCase() || '-'}</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Activity Level</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">${activePet.activity?.value || '-'}</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Birthday</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">14 Mar 2026</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Health flags</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">${activePet.focus?.value || '-'}</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Eating Style</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">${activePet.body?.value || '-'}</span>
           </div>
           <div class="pk-stat-item">
             <label style="display:block; font-size:11px; text-transform:uppercase; color:#888; font-weight:700; letter-spacing:1px; margin-bottom:6px;">Allergies</label>
             <span style="font-weight:700; font-size:14px; color:#121217;">${activePet.allergies?.value || '-'}</span>
           </div>
        </div>
      </div>

      <!-- EDIT FORM (toggled by "Edit Details"; posts to /apps/purrkins/update-pet) -->
      <form id="profile-edit-mode" style="display:none; margin-top:24px;">
        <input type="hidden" name="pet_id" value="${esc(activePet.id)}">
        <input type="hidden" name="profile_image_url" id="profile-image-url-input" value="">

        <div class="pk-edit-img-row">
          <div class="pk-file-upload">
            <label for="profile-image-file">Profile photo</label>
            <input type="file" id="profile-image-file" accept="image/*">
          </div>
        </div>

        <div class="pk-edit-grid">
          <div class="pk-input-group">
            <label for="edit-name">Name</label>
            <input type="text" id="edit-name" name="name" value="${esc(activePet.name?.value)}" required>
          </div>
          <div class="pk-input-group">
            <label for="edit-age">Age</label>
            <input type="text" id="edit-age" name="age" value="${esc(activePet.age?.value)}">
          </div>
          <div class="pk-input-group">
            <label for="edit-weight">Weight (kg)</label>
            <input type="number" step="0.1" min="0" id="edit-weight" name="weight" value="${esc(activePet.weight?.value)}">
          </div>
          <div class="pk-input-group">
            <label for="edit-gender">Sex</label>
            <select id="edit-gender" name="gender">${optionsHtml(activePet.gender?.value, ['Male', 'Female'])}</select>
          </div>
          <div class="pk-input-group">
            <label for="edit-neutered">Neutered</label>
            <select id="edit-neutered" name="neutered">${optionsHtml(activePet.neutered?.value, ['Neutered', 'Not Neutered'])}</select>
          </div>
          <div class="pk-input-group">
            <label for="edit-activity">Activity Level</label>
            <input type="text" id="edit-activity" name="activity" value="${esc(activePet.activity?.value)}">
          </div>
          <div class="pk-input-group">
            <label for="edit-body">Eating Style</label>
            <input type="text" id="edit-body" name="body" value="${esc(activePet.body?.value)}">
          </div>
          <div class="pk-input-group">
            <label for="edit-focus">Health Flags (comma separated)</label>
            <input type="text" id="edit-focus" name="focus" value="${esc(activePet.focus?.value)}">
          </div>
          <div class="pk-input-group">
            <label for="edit-allergies">Allergies</label>
            <input type="text" id="edit-allergies" name="allergies" value="${esc(activePet.allergies?.value)}">
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:12px; margin-top:24px;">
          <button type="submit" id="save-changes-btn" class="pk-dark-btn">Save Changes</button>
          <button type="button" id="cancel-edit-btn" class="pk-outline-btn">Cancel</button>
          <span id="save-loading-text" style="display:none; font-size:13px; color:#595961;">Saving...</span>
        </div>
      </form>

      <div id="weight-banner-ui" style="background:#FFE600; padding:16px 24px; border-radius:12px; margin-top:24px; display:flex; justify-content:space-between; align-items:center;">
         <div>
            <h4 style="margin:0 0 4px 0; font-weight:800; font-size:16px;">1.9 kg logged on 2 Aug</h4>
            <p style="margin:0; font-size:14px;">Portions and pack quantities update automatically when you log a new weight.</p>
         </div>
         <button style="background:#121217; color:#fff; border:none; border-radius:30px; padding:12px 24px; font-weight:700; cursor:pointer;">Log New Weight</button>
      </div>
    </div>

    <!-- COMBINED QUIZ & RECOMMENDATIONS CARD -->
    <div id="quiz" class="pk-card" style="margin-top:20px; scroll-margin-top:100px;">
      <!-- QUIZ ANSWERS -->
      <div class="pk-card-header" style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <h2 style="margin:0;">Your quiz answers</h2>
          <p style="color:#595961; margin:6px 0 0 0; font-size:14px;">Taken 14 July, updated 2 Aug. Everything below is built from these answers.</p>
        </div>
        <button onclick="document.getElementById('global-byob-quiz-popup').style.display='flex'" class="pk-outline-btn" style="border-radius:30px; cursor:pointer; background:none;">Retake quiz</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:24px;">
        ${activePet.age?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">Age - ${activePet.age.value}</span>` : ''}
        ${activePet.weight?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">Weight - ${activePet.weight.value} kg</span>` : ''}
        ${activePet.gender?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">${activePet.gender.value}</span>` : ''}
        ${activePet.neutered?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">${activePet.neutered.value}</span>` : ''}
        ${activePet.body?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">${activePet.body.value}</span>` : ''}
        ${activePet.activity?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">${activePet.activity.value}</span>` : ''}
        ${activePet.focus?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">${activePet.focus.value}</span>` : ''}
        ${activePet.allergies?.value ? `<span class="pk-quiz-pill" style="background:#f4f4f5; border-radius:20px; padding:6px 16px; font-size:13px; font-weight:600;">${activePet.allergies.value}</span>` : ''}
      </div>

      <!-- RECOMMENDATIONS (matched from this pet's quiz answers) -->
      ${(() => {
        const bgColors = ['#E8F4FE', '#FFF2E8', '#EAF6F0'];
        let productsHtml = '';

        if (recommendedProducts.length > 0) {
          productsHtml = recommendedProducts.map((prod: any, index: number) => {
            const bgColor = bgColors[index] || '#E8F4FE';
            const title = esc(prod.title);
            const imgUrl = esc(prod.featuredImage?.url || '');
            const desc = esc(prod.metafield?.value || 'Nourishing fuel for growing kittens.');
            const variantId = prod.variants?.edges?.[0]?.node?.id?.split('/').pop() || '';
            return `
              <div class="pk-recommend-card" style="flex: 1 1 250px; min-width: 250px; max-width: calc(33.333% - 11px); background:${bgColor}; padding:24px; border-radius:16px; display:flex; flex-direction:column;">
                <img src="${imgUrl}" style="width:50px; height:70px; object-fit:contain; margin-bottom:16px;" alt="">
                <h4 style="margin:0 0 8px 0; font-size:16px; font-weight:800;">${title}</h4>
                <p style="font-size:13px; margin:0 0 24px 0; color:#595961; line-height:1.4; flex-grow:1;">${desc}</p>
                <form method="post" action="/cart/add" class="quiz-rec-form">
                  <input type="hidden" name="id" value="${variantId}">
                  <button type="submit" style="background:#121217; color:#fff; border:none; border-radius:30px; padding:12px 20px; font-weight:700; cursor:pointer; width:max-content;">Add to Cart</button>
                </form>
              </div>
            `;
          }).join('');
        } else {
          productsHtml = `
            <div style="width: 100%; text-align: center; padding: 40px 20px; background: #f9f9f9; border-radius: 16px; border: 1px dashed #d1d1d1; color: #595961;">
              <h3 style="margin-top: 0; font-size: 18px; color: #121217; margin-bottom: 8px;">No exact matches found</h3>
              <p style="margin-bottom: 0;">We couldn't find products that exactly match <strong>${esc(petName)}'s</strong> specific quiz answers.</p>
            </div>
          `;
        }

        return `
          <div style="margin-top:40px; margin-bottom:12px;">
            <h2 style="margin:0 0 20px 0; font-size:20px;">Recommend for ${esc(petName)}</h2>
            <div style="display:flex; gap:16px; flex-wrap:wrap;">
              ${productsHtml}
            </div>
          </div>
        `;
      })()}
    </div>

    <!-- MONTHLY PLAN CARD (shows this pet's subscription products, or an empty state) -->
    ${hasSubscription ? `
    <div id="subscription" class="pk-card" style="margin-top:20px; scroll-margin-top:100px;">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">
        <h2 style="margin:0;">${esc(petName)}'s monthly plan</h2>
        <span style="background:#FFFDE7; color:#FBC02D; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:700; border:1px solid #FFF59D;">Active</span>
      </div>

      ${(subscriptionPlanName || subscriptionLastOrdered || subscriptionDeliveries > 0) ? `
      <div style="background:#FFE600; padding:16px 24px; border-radius:12px; display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:24px;">
        ${subscriptionPlanName ? `<div><div style="font-size:10px; font-weight:700; letter-spacing:1px; margin-bottom:4px; text-transform:uppercase;">Plan</div><div style="font-weight:700; font-size:14px;">${esc(subscriptionPlanName)}</div></div>` : ''}
        ${subscriptionLastOrdered ? `<div><div style="font-size:10px; font-weight:700; letter-spacing:1px; margin-bottom:4px; text-transform:uppercase;">Last Order</div><div style="font-weight:700; font-size:14px;">${esc(new Date(subscriptionLastOrdered).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }))}</div></div>` : ''}
        ${subscriptionDeliveries > 0 ? `<div><div style="font-size:10px; font-weight:700; letter-spacing:1px; margin-bottom:4px; text-transform:uppercase;">Deliveries So Far</div><div style="font-weight:700; font-size:14px;">${subscriptionDeliveries}</div></div>` : ''}
      </div>` : ''}

      <div style="display:flex; flex-direction:column; gap:20px;">
        ${subscriptionProducts.map((p) => `
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eaeaea; padding-bottom:20px;">
          <div style="display:flex; gap:16px; align-items:center;">
            ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" style="width:36px; height:50px; object-fit:contain;" alt="">` : ''}
            <div>
              <div style="font-weight:800; font-size:15px; margin-bottom:4px;">${esc(p.title)}</div>
              ${p.variantTitle ? `<div style="font-size:13px; color:#595961;">${esc(p.variantTitle)}</div>` : ''}
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:20px;">
            ${p.quantity > 1 ? `<span style="font-size:13px; font-weight:700; color:#595961;">Qty ${p.quantity}</span>` : ''}
            <span style="font-weight:800; font-size:15px; text-align:right;">${p.price > 0 ? '₹' + (p.price * p.quantity).toLocaleString('en-IN') : ''}</span>
          </div>
        </div>`).join('')}
      </div>

      ${subscriptionTotal > 0 ? `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:20px; font-size:15px; font-weight:800;">
        <span>Total per box</span>
        <span>₹${subscriptionTotal.toLocaleString('en-IN')}</span>
      </div>` : ''}

      <div style="background:#121217; color:#fff; padding:16px 24px; border-radius:12px; display:flex; justify-content:space-between; align-items:center; margin-top:20px;">
        <span style="font-size:14px; font-weight:700;">+ Add a product to this box — treats, broths and supplement mousses</span>
        <a href="/pages/byob" style="font-size:14px; font-weight:700; color:#fff; text-decoration:none; padding:6px 16px; border:1px solid rgba(255,255,255,0.3); border-radius:30px;">Browse</a>
      </div>

      <div style="background:#FFE600; padding:20px 24px; border-radius:12px; display:flex; justify-content:space-between; margin-top:30px;">
        <div>
           <div style="font-weight:800; font-size:14px; margin-bottom:6px;">Vet on call</div>
           <div style="font-size:13px; line-height:1.4;">Unlimited chats with the<br>Purrkins panel</div>
        </div>
        <div>
           <div style="font-weight:800; font-size:14px; margin-bottom:6px;">15% off every order</div>
           <div style="font-size:13px; line-height:1.4;">Applied automatically at<br>renewal</div>
        </div>
        <div>
           <div style="font-weight:800; font-size:14px; margin-bottom:6px;">Free delivery</div>
           <div style="font-size:13px; line-height:1.4;">On every subscription box</div>
        </div>
        <div>
           <div style="font-weight:800; font-size:14px; margin-bottom:6px;">Insurance benefit</div>
           <div style="font-size:13px; line-height:1.4;">Partner cover</div>
        </div>
      </div>
    </div>
    ` : `
    <div id="subscription" class="pk-card" style="margin-top:20px; scroll-margin-top:100px;">
      <h2 style="margin:0 0 16px 0; font-size:24px;">${esc(petName)}'s monthly plan</h2>
      <div style="background:#f4f4f5; border-radius:12px; padding:40px 20px; text-align:center;">
        <h3 style="margin:0 0 12px 0; font-size:18px;">No active subscription</h3>
        <p style="color:#595961; margin:0 0 24px 0; font-size:14px;">${esc(petName)} doesn't have a monthly plan yet. Build a custom box tailored to their quiz results.</p>
        <a href="/pages/byob" style="display:inline-block; padding:12px 28px; border-radius:30px; background:#121217; color:#fff; text-decoration:none; font-weight:700; font-size:14px;">Build a Box</a>
      </div>
    </div>
    `}

    <!-- VET CHAT CARD -->
    <div id="vet" style="scroll-margin-top:100px; background:#121217; border-radius:16px; padding:30px; display:flex; justify-content:space-between; align-items:center; margin-top:24px; color:#fff;">
      <div>
        <h3 style="margin:0 0 10px 0; font-size:24px; font-weight:800;">Something not right with your kitten?</h3>
        <p style="margin:0; font-size:14px; color:#ccc;">Vet chat is included with your plan. Most questions get an answer in an hour.</p>
      </div>
      <button style="background:#FFE600; color:#121217; border:none; border-radius:30px; padding:16px 32px; font-weight:800; font-size:15px; cursor:pointer;">Talk to a Vet</button>
    </div>
  ` : `
    <div class="pk-card" style="text-align:center; padding:60px 30px;">
      <h2 style="margin:0 0 16px 0; font-size:24px;">No Kittens Found!</h2>
      <p style="color:#595961; margin:0 0 30px 0;">Take the quiz to create a profile for your kitten and get personalized recommendations.</p>
      <a href="/pages/byob" style="display:inline-block; padding:14px 32px; border-radius:30px; background:#121217; color:#fff; text-decoration:none; font-weight:700;">Take the Quiz</a>
    </div>
  `;


  const dashUrl = '/apps/purrkins/dashboard';

  const liquidTemplate = `
    ${getLoaderHtml(true)}
    <style>
\n
      .pk-dashboard-wrapper {
        max-width: 1200px;
        margin: 40px auto;
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
        width: 80px;
        height: 80px;
        background: #eaeaea;
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #595961;
        flex-shrink: 0;
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
        font-size: 13px;
        color: #595961;
        font-weight: 600;
      }
      .pk-input-group input, .pk-form-grid input {
        border: 1px solid #eaeaea;
        border-radius: 20px;
        padding: 12px 16px;
        font-size: 14px;
        outline: none;
        color: #121217;
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

      .pk-orders-table {
        border: 1px solid #eaeaea;
        border-radius: 12px;
        overflow: hidden;
      }
      .pk-tr {
        display: grid;
        grid-template-columns: 2fr 1.5fr 1.5fr 1fr 1.5fr;
        padding: 20px;
        border-bottom: 1px solid #eaeaea;
        align-items: center;
        font-size: 14px;
      }
      .pk-th {
        background: #595961;
        color: #fff;
        font-weight: 700;
        font-size: 12px;
        letter-spacing: 0.5px;
        padding: 12px 20px;
      }
      .pk-tr:last-child {
        border-bottom: none;
      }
      .pk-tr strong {
        font-size: 15px;
        font-weight: 800;
        color: #121217;
      }
      .pk-status {
        padding: 6px 14px;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 700;
        display: inline-block;
      }
      .pk-status.delivered { background: #EAF6F0; color: #2E8E5A; }
      .pk-status.transit { background: #E8F4FE; color: #2B6CB0; }
      .pk-subtext { color: #8c8c9a; font-size: 13px; margin-top: 4px; display: block; }
      
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
        max-width: 1200px;
        margin: 40px auto;
        padding: 0 20px;
        font-family: var(--font-body--family, sans-serif);
        color: #121217;
      }
      
      /* PET SELECTOR */
      .pk-pet-selector-row {
        display: flex;
        gap: 15px;
        margin-bottom: 40px;
        align-items: center;
        flex-wrap: wrap;
      }
      .pk-pet-pill {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 24px 8px 8px;
        border-radius: 40px;
        background: #fff;
        border: 1px solid #eaeaea;
        text-decoration: none;
        color: #121217;
        transition: 0.2s;
      }
      .pk-pet-pill.active {
        background: #ffd831;
        border-color: #ffd831;
      }
      .pk-pet-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        overflow: hidden;
        background: #fff;
      }
      .pk-pet-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .pk-pet-info { display: flex; flex-direction: column; }
      .pk-pet-info strong { font-size: 15px; font-weight: 800; }
      .pk-pet-info span { font-size: 11px; color: #595961; }
      .pk-pet-add-btn {
        padding: 14px 24px;
        border-radius: 30px;
        background: #fff;
        border: 1px solid #eaeaea;
        color: #121217;
        text-decoration: none;
        font-weight: 700;
        font-size: 14px;
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
        top: 24px;
        align-self: start;
      }
      @media (max-width: 900px) {
        .pk-dashboard-sidebar { position: static; }
      }
    \n</style>
    <div class="pk-dashboard-wrapper">
      <div class="pk-dashboard-header" style="display: flex; justify-content: space-between; align-items: flex-start;">
        <h1>Welcome back, ${customerFirstName || "Friend"}</h1>
        <div class="pk-header-menu" style="background: #fff; border: 1px solid #eaeaea; border-radius: 12px; padding: 10px 0; min-width: 150px; text-align: left; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
          <a href="/apps/purrkins/dashboard" style="display: block; padding: 8px 20px; color: #1a1a1a; text-decoration: none; font-size: 13px; font-weight: 700;">Profile</a>
          <a href="/apps/purrkins/dashboard#pk-tab-wishlist" style="display: block; padding: 8px 20px; color: #1a1a1a; text-decoration: none; font-size: 13px; font-weight: 700; border-bottom: 1px solid #eaeaea; padding-bottom: 12px; margin-bottom: 4px;">Wishlist</a>
          <button onclick="localStorage.removeItem('pk_session'); window.location.href='/apps/purrkins/login';" style="display: block; width: 100%; text-align: left; padding: 8px 20px; color: #1a1a1a; text-decoration: none; font-size: 13px; font-weight: 700; background: none; border: none; cursor: pointer;">Log out</button>
        </div>
      </div>

      <!-- PET SELECTOR HEADER -->
      <div class="pk-pet-selector-row">
        ${petPillsHtml}
        <button onclick="document.getElementById('global-byob-quiz-popup').style.display='flex'" class="pk-pet-add-btn" style="border:none; cursor:pointer;">+ Add Kitten</button>
      </div>

      <div class="pk-dashboard-layout">
        <!-- SIDEBAR -->
        <div class="pk-dashboard-sidebar">
          <div class="pk-sidebar-menu">
            <a href="${dashUrl}" class="pk-menu-item"><span class="pk-dot"></span> Overview</a>
            <a href="/apps/purrkins/kitten" class="pk-menu-item active"><span class="pk-dot"></span> Kitten's Profile</a>
            <a href="#quiz" class="pk-menu-item"><span class="pk-dot"></span> Your Quiz Answers</a>
            <a href="#subscription" class="pk-menu-item"><span class="pk-dot"></span> Subscriptions ${hasSubscription ? '<span class="pk-badge">1</span>' : ''}</a>
            <a href="#vet" class="pk-menu-item"><span class="pk-dot"></span> Talk to a Vet</a>
          </div>

          <div class="pk-whatsapp-card">
            <h3>Stuck on something?</h3>
            <p>Our kitten team replies on WhatsApp, usually within an hour.</p>
            <a href="#" class="pk-whatsapp-btn">Reach Out <span class="wa-icon">💬</span></a>
          </div>
        </div>

        <!-- MAIN CONTENT -->
        <div class="pk-dashboard-content">
          ${petContentHtml}

          <script>
            window.initPurrkinsKitten = function() {
              var editBtn = document.getElementById("edit-details-btn");
              var cancelBtn = document.getElementById("cancel-edit-btn");
              var viewMode = document.getElementById("profile-view-mode");
              var editMode = document.getElementById("profile-edit-mode");
              var weightBanner = document.getElementById("weight-banner-ui");
              var fileInput = document.getElementById("profile-image-file");
              var urlInput = document.getElementById("profile-image-url-input");
              var saveBtn = document.getElementById("save-changes-btn");
              var loadingText = document.getElementById("save-loading-text");

              if (editMode) {
                editMode.addEventListener("submit", async function(e) {
                  e.preventDefault();
                  saveBtn.disabled = true;
                  loadingText.style.display = "inline";
                  if (typeof pkShowLoader === 'function') pkShowLoader();

                  var file = fileInput.files[0];
                  try {
                    if (file) {
                      // 1. Get Upload URL
                      var urlFormData = new FormData();
                      urlFormData.append("filename", file.name);
                      urlFormData.append("mimeType", file.type);
                      
                      var res = await fetch("/apps/purrkins/get-upload-url", {
                        method: "POST",
                        body: urlFormData
                      });
                      var data = await res.json();
                      
                      if (data.success && data.target) {
                        // 2. Upload file directly to Cloud Bucket
                        var uploadForm = new FormData();
                        data.target.parameters.forEach(function(param) {
                          uploadForm.append(param.name, param.value);
                        });
                        uploadForm.append("file", file);

                        var uploadRes = await fetch(data.target.url, {
                          method: "POST",
                          body: uploadForm
                        });

                        if (uploadRes.ok) {
                          // 3. Save the resourceUrl
                          urlInput.value = data.target.resourceUrl;
                        } else {
                          alert("Image upload failed. Please try again.");
                          saveBtn.disabled = false;
                          loadingText.style.display = "none";
                          return; // Stop execution
                        }
                      } else {
                         alert("Could not initialize upload.");
                         saveBtn.disabled = false;
                         loadingText.style.display = "none";
                         return; // Stop execution
                      }
                    }

                    // Submit the final form data to update-pet via AJAX
                    var finalFormData = new FormData(editMode);
                    var finalRes = await fetch("/apps/purrkins/update-pet", {
                      method: "POST",
                      body: finalFormData
                    });
                    var finalData = await finalRes.json();

                    if (finalData.success) {
                      // Instantly update the DOM to avoid Shopify Liquid caching
                      if (file) {
                        var reader = new FileReader();
                        reader.onload = function(event) {
                          var profilePhotos = document.querySelectorAll(".pk-profile-photo img, .pk-profile-photo svg");
                          profilePhotos.forEach(function(el) {
                             if (el.tagName.toLowerCase() === 'svg') {
                                var newImg = document.createElement('img');
                                newImg.src = event.target.result;
                                newImg.alt = "Profile";
                                newImg.style.width = "100%";
                                newImg.style.height = "100%";
                                newImg.style.objectFit = "cover";
                                el.parentNode.replaceChild(newImg, el);
                             } else {
                                el.src = event.target.result;
                             }
                          });
                          // Also update active sidebar card image
                          var activeSidebarImg = document.querySelector(".pk-pet-card.active img, .pk-pet-card.active svg");
                          if (activeSidebarImg) {
                             if (activeSidebarImg.tagName.toLowerCase() === 'svg') {
                                var sImg = document.createElement('img');
                                sImg.src = event.target.result;
                                sImg.alt = "Profile";
                                sImg.style.width = "40px";
                                sImg.style.height = "40px";
                                sImg.style.borderRadius = "50%";
                                sImg.style.objectFit = "cover";
                                activeSidebarImg.parentNode.replaceChild(sImg, activeSidebarImg);
                             } else {
                                activeSidebarImg.src = event.target.result;
                             }
                          }
                        };
                        reader.readAsDataURL(file);
                      }

                      // Update text fields in view mode
                      var updateStat = function(labelName, newValue) {
                         var boxes = document.querySelectorAll('.pk-stat-item');
                         boxes.forEach(function(box) {
                            var label = box.querySelector('label');
                            if(label && label.innerText.trim() === labelName) {
                               var span = box.querySelector('span');
                               if(span) span.innerText = newValue || '-';
                            }
                         });
                      };
                      
                      updateStat('Age', finalFormData.get('age'));
                      var newWeight = finalFormData.get('weight');
                      updateStat('Weight', newWeight ? newWeight + ' kg' : '-');
                      updateStat('Eating Style', finalFormData.get('body'));
                      updateStat('Sex', finalFormData.get('gender') + ', ' + finalFormData.get('neutered'));
                      updateStat('Activity Level', finalFormData.get('activity'));
                      updateStat('Health flags', finalFormData.get('focus'));
                      updateStat('Allergies', finalFormData.get('allergies'));
                      
                      var h2 = document.querySelector('.pk-card-header h2');
                      if (h2) h2.innerText = (finalFormData.get('name') || 'Kitten') + "'s profile";
                      var sidebarName = document.querySelector('.pk-pet-pill.active strong');
                      if (sidebarName) sidebarName.innerText = finalFormData.get('name') || 'Kitten';

                      // Switch back to view mode
                      editMode.style.display = "none";
                      viewMode.style.display = "flex";
                      if (weightBanner) weightBanner.style.display = "flex";
                      if (editBtn) editBtn.style.display = "inline-block";
                      
                      // Reset buttons
                      saveBtn.disabled = false;
                      loadingText.style.display = "none";

                      // Create a toast notification
                      var toast = document.createElement("div");
                      toast.innerText = "Profile updated successfully!";
                      toast.style.position = "fixed";
                      toast.style.bottom = "20px";
                      toast.style.right = "20px";
                      toast.style.backgroundColor = "#000";
                      toast.style.color = "#fff";
                      toast.style.padding = "12px 24px";
                      toast.style.borderRadius = "8px";
                      toast.style.fontFamily = "inherit";
                      toast.style.zIndex = "9999";
                      toast.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
                      document.body.appendChild(toast);

                      if (typeof pkHideLoader === 'function') pkHideLoader();
                      setTimeout(function() {
                        toast.style.opacity = '0';
                        toast.style.transition = 'opacity 0.5s ease';
                        setTimeout(function() { toast.remove(); }, 500);
                      }, 2000);
                    } else {
                      if (typeof pkHideLoader === 'function') pkHideLoader();
                      alert("Failed to update: " + (finalData.message || "Unknown error"));
                      saveBtn.disabled = false;
                      loadingText.style.display = "none";
                    }

                  } catch (err) {
                    if (typeof pkHideLoader === 'function') pkHideLoader();
                    console.error(err);
                    alert("An error occurred during update.");
                    saveBtn.disabled = false;
                    loadingText.style.display = "none";
                  }
                });
              }

              if (editBtn) {
                editBtn.addEventListener("click", function(e) {
                  e.preventDefault();
                  viewMode.style.display = "none";
                  weightBanner.style.display = "none";
                  editMode.style.display = "block";
                  editBtn.style.display = "none";
                });
              }

              if (cancelBtn) {
                cancelBtn.addEventListener("click", function(e) {
                  e.preventDefault();
                  editMode.style.display = "none";
                  viewMode.style.display = "flex";
                  weightBanner.style.display = "flex";
                  editBtn.style.display = "block";
                });
              }
            };
            
            // Initialize immediately if script runs
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", window.initPurrkinsKitten);
            } else {
              window.initPurrkinsKitten();
            }
          </script>

        </div>
      </div>
    </div>

    

        <script>
      // Hide session from URL
      (function hideSessionUrl() {
        if (window.history.replaceState) {
          var url = new URL(window.location.href);
          if (url.searchParams.has('session')) {
            url.searchParams.delete('session');
            window.history.replaceState(null, '', url.toString());
          }
        }
      })();

      if (!window.__pkPjaxInited) {
        window.__pkPjaxInited = true;
        document.addEventListener("click", async function(e) {
          var link = e.target.closest("a.pk-menu-item, a.pk-pet-pill");
          if (link && link.getAttribute("href") && link.getAttribute("href").startsWith("/apps/purrkins/")) {
            e.preventDefault();
            
            document.querySelectorAll(".pk-menu-item").forEach(function(el) { el.classList.remove("active") });
            link.classList.add("active");
            
            if (typeof pkShowLoader === 'function') pkShowLoader();
            
            var mainContent = document.querySelector(".pk-dashboard-wrapper");
            if (!mainContent) {
              window.location.href = link.getAttribute("href");
              return;
            }
            mainContent.style.opacity = "0.5";
            mainContent.style.pointerEvents = "none";
            mainContent.style.transition = "opacity 0.2s";
            
            var url = link.getAttribute("href");
            var displayUrl = url;
            
            var pk_token = localStorage.getItem('pk_session');
            var fetchUrl = url;
            if (pk_token) {
              fetchUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 'session=' + pk_token;
            }
            
            window.history.pushState({}, "", displayUrl);
            
            try {
              var res = await fetch(fetchUrl);
              var text = await res.text();
              
              var parser = new DOMParser();
              var doc = parser.parseFromString(text, "text/html");
              
              var newContent = doc.querySelector(".pk-dashboard-wrapper");
              if (newContent) {
                mainContent.innerHTML = newContent.innerHTML;
                
                var scripts = mainContent.querySelectorAll("script");
                scripts.forEach(function(oldScript) {
                  var newScript = document.createElement("script");
                  Array.from(oldScript.attributes).forEach(function(attr) { newScript.setAttribute(attr.name, attr.value); });
                  newScript.appendChild(document.createTextNode(oldScript.innerHTML));
                  oldScript.parentNode.replaceChild(newScript, oldScript);
                });
                if (typeof pkHideLoader === 'function') setTimeout(pkHideLoader, 150);
              } else {
                window.location.href = url;
              }
            } catch (err) {
               console.error("PJAX Error:", err);
               window.location.href = url;
            }
            
            mainContent.style.opacity = "1";
            mainContent.style.pointerEvents = "auto";
          }
        });
      }

      // Smooth-scroll sidebar anchor links (#quiz, #subscription, #vet) to their sections
      if (!window.__pkAnchorScroll) {
        window.__pkAnchorScroll = true;
        document.addEventListener("click", function(e) {
          var link = e.target.closest("a.pk-menu-item");
          if (!link) return;
          var href = link.getAttribute("href") || "";
          if (href.charAt(0) !== "#" || href.length < 2) return;
          var target = document.getElementById(href.slice(1));
          if (!target) return;
          e.preventDefault();
          document.querySelectorAll(".pk-menu-item").forEach(function(el) { el.classList.remove("active"); });
          link.classList.add("active");
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    </script>

    <!-- NEW QUIZ MODAL -->
    <div id="pk-quiz-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:99999; align-items:center; justify-content:center;">
      <div style="background:#fff; width:95%; max-width:1196px; height:90vh; border-radius:16px; position:relative; overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column; box-shadow: 0 20px 40px rgba(0,0,0,0.2);">
        <button id="pk-quiz-close" style="position:absolute; top:20px; right:20px; background:none; border:none; font-size:28px; cursor:pointer; color:#121217; padding:0; line-height:1; z-index:999999;">&times;</button>
        
        <div class="byob-quiz-section purrkins-section-block" id="byob-quiz-section" style="display: block;">
  <div class="purrkins-container" style="max-width: 1196px;">
    <div class="byob-quiz-card">
      <iframe name="quiz_hidden_iframe" id="quiz_hidden_iframe" style="display:none;"></iframe>
      <form id="byob-quiz-form" action="/account" method="post" target="quiz_hidden_iframe">
        <input type="hidden" name="form_type" value="customer">
        <input type="hidden" name="utf8" value="✓">
        <input type="hidden" name="return_to" value="/account">

        <div class="byob-quiz-slider-container">
          <div class="byob-quiz-slider" id="byob-quiz-slider">
            <!-- Slide 1 -->
            <div class="byob-quiz-slide active" data-step="1">
              <div class="byob-slider-wrapper">
                <div class="quiz-flex-wrapper">
                  <div class="byob-quiz-header">
                    <div class="quiz-nav">
                      <button type="button" class="quiz-next">
                        <img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/right-nav.svg?v=1790164808" alt="Next" width="50" height="50" loading="lazy">
                      </button>
                    </div>
                  </div>
                  <h2 class="quiz-title">Discover their daily rhythm</h2>
                  <div class="quiz-input-group row-group">
                    <label class="quiz-label-inline quiz-subtitle">Your kitten's name</label>
                    <input type="text" name="quiz_name" class="quiz-text-input underline-input" placeholder="Enter name">
                  </div>
                </div>
                <div class="quiz-flex-wrapper">
                  <div class="quiz-box-group">
                    <h3 class="quiz-subtitle">Select your cat's age</h3>
                    <div class="quiz-options grid-3">
                      <label class="quiz-option"><input type="radio" name="quiz_age" value="Lactating cat and babies"><span>Lactating cat and babies</span></label>
                      <label class="quiz-option"><input type="radio" name="quiz_age" value="3-8 weeks kitten"><span>3-8 weeks kitten</span></label>
                      <label class="quiz-option"><input type="radio" name="quiz_age" value="2-4-month kitten"><span>2-4-month kitten</span></label>
                      <label class="quiz-option"><input type="radio" name="quiz_age" value="4+ month kitten"><span>4+ month kitten</span></label>
                      <label class="quiz-option"><input type="radio" name="quiz_age" value="1+ years (adult)"><span>1+ years (adult)</span></label>
                      <label class="quiz-option"><input type="radio" name="quiz_age" value="7+ years (senior)"><span>7+ years (senior)</span></label>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Slide 2 -->
            <div class="byob-quiz-slide" data-step="2">
              <div class="byob-slider-wrapper">
                <div class="quiz-flex-wrapper">
                  <div class="byob-quiz-header">
                    <div class="quiz-nav">
                      <button type="button" class="quiz-prev"><img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/left-nav.svg?v=1790164808" alt="Previous" width="50" height="50" loading="lazy"></button>
                      <button type="button" class="quiz-next"><img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/right-nav.svg?v=1790164808" alt="Next" width="50" height="50" loading="lazy"></button>
                    </div>
                  </div>

                  <div class="quiz-split-layout">
                    <div class="quiz-split-content quiz-box-group">
                      <h2 class="quiz-title">Are they a boy or a girl, and have they been neutered?</h2>
                      <div class="quiz-box-group-custom">
                        <h3 class="quiz-subtitle">Gender</h3>
                        <div class="quiz-options grid-2">
                          <label class="quiz-option"><input type="radio" name="quiz_gender" value="Male"><span>Male</span></label>
                          <label class="quiz-option"><input type="radio" name="quiz_gender" value="Female"><span>Female</span></label>
                        </div>
                      </div>
                      <div class="quiz-box-group-custom">
                        <h3 class="quiz-subtitle">Neutered</h3>
                        <div class="quiz-options grid-2">
                          <label class="quiz-option"><input type="radio" name="quiz_neutered" value="Neutered"><span>Yes</span></label>
                          <label class="quiz-option"><input type="radio" name="quiz_neutered" value="Not Neutered"><span>No</span></label>
                        </div>
                      </div>
                    </div>
                    <div class="quiz-split-image">
                        <div style="width: 100%; height: 100%; background: #ccc; border-radius: 12px; display: flex; align-items: center; justify-content: center;">
                          Image 2
                        </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Slide 3 -->
            <div class="byob-quiz-slide" data-step="3">
              <div class="byob-slider-wrapper">
                <div class="quiz-flex-wrapper">
                  <div class="byob-quiz-header">
                    <div class="quiz-nav">
                      <button type="button" class="quiz-prev"><img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/left-nav.svg?v=1790164808" alt="Previous" width="50" height="50" loading="lazy"></button>
                      <button type="button" class="quiz-next"><img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/right-nav.svg?v=1790164808" alt="Next" width="50" height="50" loading="lazy"></button>
                    </div>
                  </div>
                  <div class="quiz-input-group row-group">
                    <label class="quiz-label-inline quiz-subtitle">What is their current weight (in kgs)?</label>
                    <input type="number" step="0.1" name="quiz_weight" class="quiz-text-input underline-input" placeholder="e.g. 4.5">
                  </div>
                </div>

                <div class="quiz-flex-wrapper">
                  <div class="quiz-image-options grid-4">
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_body" value="Skinny">
                      <div class="quiz-image-card"><h4>Skinny</h4></div>
                    </label>
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_body" value="Lean">
                      <div class="quiz-image-card"><h4>Lean</h4></div>
                    </label>
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_body" value="Healthy">
                      <div class="quiz-image-card"><h4>Healthy</h4></div>
                    </label>
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_body" value="Obese">
                      <div class="quiz-image-card"><h4>Obese</h4></div>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <!-- Slide 4 -->
            <div class="byob-quiz-slide" data-step="4">
              <div class="byob-slider-wrapper">
                <div class="quiz-flex-wrapper">
                  <div class="byob-quiz-header">
                    <div class="quiz-nav">
                      <button type="button" class="quiz-prev"><img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/left-nav.svg?v=1790164808" alt="Previous" width="50" height="50" loading="lazy"></button>
                      <button type="button" class="quiz-next"><img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/right-nav.svg?v=1790164808" alt="Next" width="50" height="50" loading="lazy"></button>
                    </div>
                  </div>
                  <div class="row-group">
                    <h2 class="quiz-subtitle">What is their activity level? Choose between the 4 images.</h2>
                  </div>
                </div>
                <div class="quiz-flex-wrapper">
                  <div class="quiz-image-options grid-4">
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_activity" value="Couch Potato">
                      <div class="quiz-image-card"><h4>Couch Potato</h4></div>
                    </label>
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_activity" value="Playful">
                      <div class="quiz-image-card"><h4>Playful</h4></div>
                    </label>
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_activity" value="Explorer">
                      <div class="quiz-image-card"><h4>Explorer</h4></div>
                    </label>
                    <label class="quiz-image-option">
                      <input type="radio" name="quiz_activity" value="Super-active">
                      <div class="quiz-image-card"><h4>Super-active</h4></div>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <!-- Slide 5 -->
            <div class="byob-quiz-slide" data-step="5">
              <div class="byob-slider-wrapper">
                <div class="quiz-flex-wrapper">
                  <div class="byob-quiz-header">
                    <div class="quiz-nav">
                      <button type="button" class="quiz-prev"><img src="https://cdn.shopify.com/s/files/1/0955/9366/0663/files/left-nav.svg?v=1790164808" alt="Previous" width="50" height="50" loading="lazy"></button>
                    </div>
                  </div>
                  <h2 class="quiz-subtitle">Which part of their daily routine needs the most focus? Tick all that apply.</h2>
                  <div class="quiz-options grid-4">
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Obesity"><span>Obesity</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Hairball"><span>Hairball</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Shedding"><span>Shedding</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Loose Motions"><span>Loose Motions</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Weak Immunity"><span>Weak Immunity</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Dehydration"><span>Dehydration</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Under Nourishment"><span>Under Nourishment</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Gut Issues"><span>Gut Issues</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Nursing mother"><span>Nursing mother</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Picky eater"><span>Picky eater</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Kitty growth"><span>Kitty growth</span></label>
                    <label class="quiz-option"><input type="checkbox" name="quiz_focus[]" value="Dental care"><span>Dental care</span></label>
                  </div>
                </div>
                <div class="quiz-flex-wrapper">
                  <h2 class="quiz-subtitle" style="margin-top: 40px;">Any allergies or underlying health issues. Please elaborate.</h2>
                  <div class="quiz-textarea-wrapper">
                    <textarea name="quiz_allergies" class="quiz-textarea" placeholder="Mention here in detail"></textarea>
                  </div>
                  <div class="quiz-submit-wrapper">
                    <button type="submit" class="quiz-submit-btn purrkins-btn-secondary" style="background:#FFE600; padding:16px 32px; border:none; border-radius:30px; font-weight:800; cursor:pointer;">Submit</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  </div>
</div>
      </div>
    </div>
    
<style>
  .byob-slider-wrapper { padding: 40px 70px; display: flex; flex-direction: column; justify-content: space-evenly; height: 100%; }
  .byob-quiz-card { background-color: #fff5ee; border-radius: 16px; position: relative; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1); }
  .byob-quiz-slider-container { overflow: hidden; width: 100%; }
  .byob-quiz-slider { display: flex; transition: transform 0.5s ease-in-out; width: 100%; }
  .byob-quiz-slide { flex: 0 0 100%; width: 100%; position: relative; }
  .byob-quiz-header { display: flex; justify-content: space-between; align-items: flex-start; }
  .quiz-nav { display: flex; gap: 24px; position: absolute; top: 20px; right: 20px; }
  .quiz-nav button { background: transparent; border: none; padding: 0; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: opacity 0.2s; }
  .quiz-nav button:disabled { opacity: 0.5; cursor: not-allowed; }
  .quiz-title { color: #303030; font-family: var(--purrkins-heading-font, sans-serif); font-size: 32px; font-weight: 700; line-height: 1.25; margin-bottom: 40px; margin-top: 0; }
  .quiz-subtitle { font-size: 26px; font-weight: 700; color: #121217; margin: 0 0 30px 0; font-family: var(--purrkins-heading-font, sans-serif); }
  .quiz-box-group-custom { margin-bottom: 30px; }
  .row-group { display: flex; align-items: baseline; gap: 20px; margin-bottom: 30px; }
  .underline-input { border: none; border-bottom: 3px solid #121217 !important; background: transparent !important; font-size: 24px; color: #121217; outline: none; border-radius: 0; font-weight: 500; width:100%; }
  .quiz-options { display: grid; gap: 30px 22px; }
  .quiz-options.grid-2 { grid-template-columns: repeat(2, 1fr); }
  .quiz-options.grid-3 { grid-template-columns: repeat(3, 1fr); }
  .quiz-options.grid-4 { grid-template-columns: repeat(4, 1fr); }
  .quiz-option { position: relative; display: block; cursor: pointer; }
  .quiz-option input { position: absolute; opacity: 0; cursor: pointer; }
  .quiz-option span { display: block; padding: 13px 20px; text-align: center; color: #121217; font-size: 18px; font-weight: 700; border-radius: 16px; border: 1px solid #dab195; user-select: none; }
  .quiz-option input:checked + span { background: #e8cdbb; }
  .quiz-split-layout { display: flex; gap: 40px; align-items: stretch; }
  .quiz-split-content { max-width: 410px; }
  .quiz-split-image { flex: 1; display: flex; align-items: flex-end; justify-content: center; }
  .quiz-box-group { border-radius: 16px; border: 1px solid #f1eabc; background: #fff; padding: 34px 30px; z-index: 1; }
  .quiz-image-options { display: grid; gap: 18px; }
  .quiz-image-options.grid-4 { grid-template-columns: repeat(4, 1fr); }
  .quiz-image-option { cursor: pointer; }
  .quiz-image-option input { display: none; }
  .quiz-image-card { padding: 24px 24px 0; text-align: center; border: 2px solid transparent; height: 100%; display: flex; flex-direction: column; justify-content: center; border-radius: 16px; background: #e8cdbb; min-height: 100px; }
  .quiz-image-option input:checked + .quiz-image-card { border-color: #121217; }
  .quiz-textarea { width: 100%; font-size: 16px; min-height: 81px; resize: vertical; border-radius: 16px; border: 1px solid #dab195; padding: 20px; box-sizing: border-box; }
  .quiz-textarea-wrapper { padding: 20px; border-radius: 16px; border: 1px solid #f1eabc; background: #fff; }
</style>
<script>
      document.addEventListener("click", function(e) {
        var target = e.target.closest('a[href="/pages/byob"]');
        if (target) {
          e.preventDefault();
          document.getElementById("pk-quiz-modal").style.display = "flex";
        }
      });
      
      document.getElementById("pk-quiz-close")?.addEventListener("click", function() {
        document.getElementById("pk-quiz-modal").style.display = "none";
      });

      const slider = document.getElementById('byob-quiz-slider');
      const form = document.getElementById('byob-quiz-form');
      if (slider && form) {
        const slides = slider.querySelectorAll('.byob-quiz-slide');
        let currentStep = 0;

        function updateSlider() {
          slider.style.transform = 'translateX(-' + (currentStep * 100) + '%)';
          slides.forEach((slide, index) => {
            if (index === currentStep) slide.classList.add('active');
            else slide.classList.remove('active');
            const prevBtn = slide.querySelector('.quiz-prev');
            if (prevBtn) prevBtn.disabled = index === 0;
          });
        }
        updateSlider();

        const checkSlideComplete = (slide) => {
          const textInputs = Array.from(slide.querySelectorAll('input[type="text"], input[type="number"], textarea'));
          const allTextFilled = textInputs.every(input => input.value.trim() !== '');

          const radioGroups = {};
          Array.from(slide.querySelectorAll('input[type="radio"]')).forEach(radio => radioGroups[radio.name] = true);
          let allRadiosFilled = true;
          for (const name in radioGroups) {
            if (!slide.querySelector('input[name="' + name + '"]:checked')) {
              allRadiosFilled = false; break;
            }
          }

          const checkboxes = Array.from(slide.querySelectorAll('input[type="checkbox"]'));
          let allCheckboxesValid = true;
          if (checkboxes.length > 0) allCheckboxesValid = checkboxes.some(cb => cb.checked);

          return allTextFilled && allRadiosFilled && allCheckboxesValid;
        };

        slides.forEach((slide, index) => {
          const prevBtn = slide.querySelector('.quiz-prev');
          const nextBtn = slide.querySelector('.quiz-next');
          
          if (prevBtn) prevBtn.addEventListener('click', () => { if (currentStep > 0) { currentStep--; updateSlider(); } });
          if (nextBtn) {
            nextBtn.addEventListener('click', () => {
              if (!checkSlideComplete(slide)) {
                alert('Please fill out all required fields before continuing.');
                return;
              }
              if (currentStep < slides.length - 1) { currentStep++; updateSlider(); }
            });
          }

          slide.querySelectorAll('input, textarea').forEach(input => {
            input.addEventListener('change', () => {
              if (index === slides.length - 1) return;
              if (checkSlideComplete(slide)) {
                setTimeout(() => { if (currentStep === index) { currentStep++; updateSlider(); } }, 300);
              }
            });
          });
        });

        form.addEventListener('submit', function(e) {
          e.preventDefault();
          if (!checkSlideComplete(slides[slides.length - 1])) {
            alert('Please fill out all required fields.');
            return;
          }

          const quizData = {};
          const formData = new FormData(form);
          for (const [key, value] of formData.entries()) {
            if (key.startsWith('quiz_') && value.trim() !== '') {
              const cleanKey = key.replace('quiz_', '').replace('[]', '');
              if (quizData[cleanKey]) quizData[cleanKey] += ', ' + value.trim();
              else quizData[cleanKey] = value.trim();
            }
          }
          
          const submitBtn = form.querySelector('.quiz-submit-btn');
          submitBtn.textContent = 'Submitting...';
          submitBtn.disabled = true;

          const payload = {
            customerId: "{{ customer.id }}",
            tag: "byob-quiz-completed",
            quiz_data: quizData
          };

          fetch('/apps/purrkins/byob/customer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(res => res.json())
          .then(data => {
            if (data && data.success) {
              if (typeof pkShowLoader === 'function') pkShowLoader();
              window.location.reload();
            } else {
              alert('Failed to save quiz: ' + (data.message || 'Unknown error'));
              submitBtn.textContent = 'Submit';
              submitBtn.disabled = false;
            }
          })
          .catch(err => {
            console.error('[BYOB Quiz] Error:', err);
            alert('An error occurred. Please try again.');
            submitBtn.textContent = 'Submit';
            submitBtn.disabled = false;
          });
        });
      }
</script>

  `;

  return new Response(liquidTemplate, {
    headers: {
      "Content-Type": "application/liquid",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
    },
  });
  } catch (err: any) {
    console.error("Kitten loader error:", err);
    return new Response(`<script>window.location.href='/apps/purrkins/login';</script><p style="color:red;padding:20px;">Error: ${err?.message}</p>`, {
      headers: { "Content-Type": "application/liquid" }
    });
  }
};
