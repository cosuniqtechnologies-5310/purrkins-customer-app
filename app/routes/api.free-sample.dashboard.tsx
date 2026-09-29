import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import jwt from "jsonwebtoken";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
  const url = new URL(request.url);
  const token = url.searchParams.get("session");
  let customerId: string | null = null;

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.SHOPIFY_API_SECRET || "s3cr3t") as any;
      customerId = decoded.customerId;
    } catch (e) {
      // invalid token
    }
  }
  
  if (!customerId) {
    return new Response(`
      <script>
        var t = localStorage.getItem('pk_session');
        if (t) {
          window.location.replace(window.location.pathname + "?session=" + t);
        } else {
          window.location.href = '/apps/purrkins/login';
        }
      </script>
    `, {
      headers: { "Content-Type": "application/liquid" }
    });
  }

  // Use the stored offline session to call Shopify Admin API directly
  const shopSession = await prisma.session.findFirst({
    where: { shop: "purrkins-mhrlfymw.myshopify.com", isOnline: false }
  });

  if (!shopSession?.accessToken) {
    console.error("No shop session found in DB");
    return new Response(`<script>window.location.href='/apps/purrkins/login';</script>`, {
      headers: { "Content-Type": "application/liquid" }
    });
  }

  const graphqlRes = await fetch(
    `https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": shopSession.accessToken,
      },
      body: JSON.stringify({
        query: `
          query($id: ID!) {
            customer(id: $id) {
              firstName
              email
              phone
              defaultAddress {
                id
                firstName
                lastName
                country
                province
                zip
                address2
                city
              }
              addresses(first: 2) {
                edges {
                  node {
                    id
                    name
                    phone
                    address1
                    address2
                    city
                    province
                    zip
                  }
                }
              }
              orders(first: 3, sortKey: CREATED_AT, reverse: true) {
                edges {
                  node {
                    name
                    createdAt
                    totalPriceSet { shopMoney { amount } }
                    displayFulfillmentStatus
                    statusPageUrl
                    lineItems(first: 1) { edges { node { title } } }
                  }
                }
              }
              pets: metafield(namespace: "custom", key: "pets") { value }
              wishlist: metafield(namespace: "custom", key: "wishlist") { value }
            }
          }
        `,
        variables: { id: customerId }
      })
    }
  );

  const data = await graphqlRes.json();
  if (data.errors) {
    console.error("GraphQL errors:", JSON.stringify(data.errors));
  }
  const customer = data?.data?.customer || {};
  const defaultAddress = customer.defaultAddress || {};
  
  const ordersHtml = customer.orders?.edges?.length > 0 
    ? customer.orders.edges.map((e: any) => `
      <div class="pk-tr">
        <div>
          <strong>${e.node.name}</strong><br>
          <span class="pk-subtext">${e.node.lineItems.edges[0]?.node?.title?.substring(0, 30) || ''}</span>
        </div>
        <div>${new Date(e.node.createdAt).toLocaleDateString()}</div>
        <div><span class="pk-status ${e.node.displayFulfillmentStatus === 'FULFILLED' ? 'delivered' : 'transit'}">${e.node.displayFulfillmentStatus || 'UNFULFILLED'}</span></div>
        <div>₹${e.node.totalPriceSet?.shopMoney?.amount}</div>
        <div class="pk-order-actions" style="display:flex; gap:10px;">
          ${e.node.displayFulfillmentStatus === 'FULFILLED' ? `<a href="${e.node.statusPageUrl}" class="pk-outline-btn">Reorder</a>` : ''}
          <a href="${e.node.statusPageUrl}" class="pk-outline-btn">Invoice</a>
        </div>
      </div>
    `).join('')
    : '<div class="pk-tr"><div style="grid-column: 1/-1; color: #595961;">No orders found.</div></div>';

  const addressesHtml = customer.addresses?.edges?.length > 0
    ? customer.addresses.edges.map((edge: any, index: number) => {
        const a = edge.node;
        return `
      <div class="pk-address-box">
        <div class="pk-addr-top">
          <h4>${index === 0 ? 'Home' : 'Office'} ${a.id === defaultAddress.id ? '<span class="pk-default-tag">Default</span>' : ''}</h4>
          <a href="#" class="pk-edit-link">Edit</a>
        </div>
        <p>${a.name || ''} - ${a.phone || ''}<br>
        ${a.address1 || ''}, ${a.address2 || ''}<br>
        ${a.city || ''}, ${a.province || ''} ${a.zip || ''}</p>
      </div>
    `;
      }).join('')
    : '<p style="color: #595961;">No addresses found.</p>';

  const liquidTemplate = `
    \n\n<style>\n
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
    \n</style>

    
    {% assign active_index = -1 %}
    <div class="pk-dashboard-wrapper">
      <div class="pk-dashboard-header">
        <h1>Welcome back, ${customer.firstName || "Friend"}</h1>
        <div class="pk-header-actions">
          <a href="/apps/purrkins/dashboard" class="pk-action-btn">Profile</a>
          <a href="#" class="pk-action-btn">Wishlist</a>
          <a href="/account/logout" class="pk-action-btn">Log out</a>
        </div>
      </div>

      <!-- PET SELECTOR HEADER -->
      <div class="pk-pet-selector-row">
        {% for pet in pets %}
          <a href="/apps/purrkins/kitten?pet_index={{ forloop.index0 }}" class="pk-pet-pill {% if forloop.index0 == active_index %}active{% endif %}">
            <div class="pk-pet-avatar" {% if forloop.index0 != active_index %}style="background:#e0e0e0;"{% endif %}>
              {% if pet.profile.value %}
                <img src="{{ pet.profile.value | image_url: width: 100 }}" {% if forloop.index0 != active_index %}style="opacity:0.6"{% endif %} alt="{{ pet.name.value }}">
              {% else %}
                <svg width="100%" height="100%" viewBox="0 0 24 24" fill="#d1d1d1" xmlns="http://www.w3.org/2000/svg" {% if forloop.index0 != active_index %}style="opacity:0.6"{% endif %}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
              {% endif %}
            </div>
            <div class="pk-pet-info">
              <strong>{{ pet.name.value | default: 'Kitten' }}</strong>
              <span>{{ pet.age.value | default: 'Unknown' }}</span>
            </div>
          </a>
        {% endfor %}
        <a href="/pages/byob" class="pk-pet-add-btn">+ Add Kitten</a>
      </div>

      <div class="pk-dashboard-layout">
        <!-- SIDEBAR -->
        <div class="pk-dashboard-sidebar">
          <div class="pk-sidebar-menu">
            <a href="/apps/purrkins/dashboard" class="pk-menu-item active"><span class="pk-dot"></span> Overview</a>
            <a href="/apps/purrkins/kitten" class="pk-menu-item"><span class="pk-dot"></span> Kitten's Profile</a>
          </div>

          <div class="pk-whatsapp-card">
            <h3>Stuck on something?</h3>
            <p>Our kitten team replies on WhatsApp, usually within an hour.</p>
            <a href="#" class="pk-whatsapp-btn">Reach Out <span class="wa-icon">💬</span></a>
          </div>
        </div>

        <!-- MAIN CONTENT -->
        <div class="pk-dashboard-content">
          
          <!-- Profile & Password -->
          <div class="pk-card">
            <div class="pk-profile-top">
              <div class="pk-avatar">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </div>
              <div class="pk-form-row">
                <div class="pk-input-group">
                  <label>Username *</label>
                  <input type="text" value="${customer.firstName || ""}" readonly>
                </div>
                <div class="pk-input-group">
                  <label>Change Password</label>
                  <input type="password" placeholder="Enter New Password">
                </div>
                <div class="pk-input-group">
                  <label>Confirm Password *</label>
                  <input type="password" placeholder="Confirm Your New Password">
                </div>
              </div>
            </div>

            <!-- Billing Address -->
            <h3 class="pk-section-title">Customer Billing Address</h3>
            <div class="pk-form-grid">
              <input type="text" placeholder="First Name" value="${defaultAddress.firstName || ""}">
              <input type="text" placeholder="Last Name" value="${defaultAddress.lastName || ""}">
              <input type="email" placeholder="Email" value="${customer.email || ""}" readonly>
              
              <input type="text" placeholder="Country/Region" value="${defaultAddress.country || "India"}">
              <input type="text" placeholder="State" value="${defaultAddress.province || ""}">
              <input type="text" placeholder="Phone (optional)" value="${customer.phone || ""}">
              
              <input type="text" placeholder="Pin Code" value="${defaultAddress.zip || ""}">
              <input type="text" placeholder="Apartment, suite, etc. (optional)" value="${defaultAddress.address2 || ""}" style="grid-column: span 2;">
              <input type="text" placeholder="City" value="${defaultAddress.city || ""}">
            </div>
            <div class="pk-form-actions">
              <a href="#" class="pk-link-btn">Update</a>
            </div>
          </div>

          <!-- Wishlist -->
          <div class="pk-card pk-wishlist-card">
            <h3 class="pk-section-title">Your Wishlist</h3>
            <div class="pk-wishlist-grid">
              <div style="grid-column: 1/-1; color: #595961; padding: 20px 0;">Your wishlist is empty. (Wishlist products are managed in Shopify admin)</div>
            </div>
          </div>

          <!-- Orders -->
          <div class="pk-card">
            <h3 class="pk-section-title">Orders</h3>
            <div class="pk-orders-table">
              <div class="pk-tr pk-th">
                <div>ORDER</div>
                <div>DATE</div>
                <div>STATUS</div>
                <div>TOTAL</div>
                <div></div>
              </div>
              ${ordersHtml}
            </div>
            <div style="margin-top: 15px;">
              <a href="#" class="pk-outline-btn">View all orders</a>
            </div>
          </div>

          <!-- Delivery Addresses -->
          <div class="pk-card">
            <div class="pk-address-header">
              <h3 class="pk-section-title">Delivery addresses</h3>
              <a href="#" class="pk-outline-btn">Add address</a>
            </div>
            <div class="pk-address-grid">
              ${addressesHtml}
            </div>
          </div>

        </div>
      </div>
    </div>

    

    <script>
      document.addEventListener("click", async function(e) {
        var link = e.target.closest("a.pk-menu-item, a.pk-pet-pill");
        if (link && link.getAttribute("href").startsWith("/apps/purrkins/")) {
          e.preventDefault();
          
          document.querySelectorAll(".pk-menu-item").forEach(function(el) { el.classList.remove("active") });
          link.classList.add("active");
          
          var mainContent = document.querySelector(".pk-dashboard-wrapper");
          if (!mainContent) return;
          mainContent.style.opacity = "0.5";
          mainContent.style.pointerEvents = "none";
          mainContent.style.transition = "opacity 0.2s";
          
          var url = link.getAttribute("href");
          window.history.pushState({}, "", url);
          
          try {
            var res = await fetch(url);
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
            }
          } catch (err) {
             console.error("PJAX Error:", err);
             window.location.href = url;
          }
          
          mainContent.style.opacity = "1";
          mainContent.style.pointerEvents = "auto";
        }
      });
    </script>
  `;

  return new Response(liquidTemplate, {
    headers: {
      "Content-Type": "application/liquid",
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
