import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // We return a Liquid template string. 
  // Shopify's App Proxy will automatically execute this Liquid and wrap it in the theme's layout!
  const liquidTemplate = `
    {% if customer == blank %}
      <script>window.location.href = "/account/login?checkout_url=/apps/purrkins/dashboard";</script>
    {% endif %}

    <div class="pk-dashboard-wrapper">
      <div class="pk-dashboard-header">
        <h1>Welcome back, {{ customer.first_name | default: 'Friend' }}</h1>
        <div class="pk-header-actions">
          <a href="/apps/purrkins/dashboard" class="pk-action-btn">Profile</a>
          <a href="#" class="pk-action-btn">Wishlist</a>
          <a href="/account/logout" class="pk-action-btn">Log out</a>
        </div>
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
                  <input type="text" value="{{ customer.first_name }}" readonly>
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
              <input type="text" placeholder="First Name" value="{{ customer.default_address.first_name }}">
              <input type="text" placeholder="Last Name" value="{{ customer.default_address.last_name }}">
              <input type="email" placeholder="Email" value="{{ customer.email }}" readonly>
              
              <input type="text" placeholder="Country/Region" value="{{ customer.default_address.country | default: 'India' }}">
              <input type="text" placeholder="State" value="{{ customer.default_address.province }}">
              <input type="text" placeholder="Phone (optional)" value="{{ customer.phone }}">
              
              <input type="text" placeholder="Pin Code" value="{{ customer.default_address.zip }}">
              <input type="text" placeholder="Apartment, suite, etc. (optional)" value="{{ customer.default_address.address2 }}" style="grid-column: span 2;">
              <input type="text" placeholder="City" value="{{ customer.default_address.city }}">
            </div>
            <div class="pk-form-actions">
              <a href="#" class="pk-link-btn">Update</a>
            </div>
          </div>

          <!-- Wishlist -->
          <div class="pk-card pk-wishlist-card">
            <h3 class="pk-section-title">Your Wishlist</h3>
            <div class="pk-wishlist-grid">
              {% assign w_count = 0 %}
              {% for item in customer.metafields.custom.wishlist.value limit: 3 %}
                {% assign w_count = w_count | plus: 1 %}
                <div class="pk-product-card">
                  <div class="pk-pc-img">
                    <span class="pk-tag">Wet Food</span>
                    <img src="{{ item.featured_image | image_url: width: 200 }}" alt="{{ item.title }}">
                  </div>
                  <h4>{{ item.title }}</h4>
                  <p class="pk-price">{{ item.price | money }} <span class="pk-weight">70g</span></p>
                  <p class="pk-desc">{{ item.metafields.custom.short_description | default: 'Healthy meal for your cat' }}</p>
                  <button class="pk-add-btn">Add to Cart</button>
                </div>
              {% endfor %}
              {% if w_count == 0 %}
                <div style="grid-column: 1/-1; color: #595961; padding: 20px 0;">Your wishlist is empty.</div>
              {% endif %}
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
              {% for order in customer.orders limit: 3 %}
                <div class="pk-tr">
                  <div>
                    <strong>{{ order.name }}</strong><br>
                    <span class="pk-subtext">{{ order.line_items.first.title | truncate: 30 }}</span>
                  </div>
                  <div>{{ order.created_at | date: "%d %b %Y" }}</div>
                  <div><span class="pk-status {% if order.fulfillment_status == 'fulfilled' %}delivered{% else %}transit{% endif %}">{{ order.fulfillment_status_label | default: 'Unfulfilled' }}</span></div>
                  <div>{{ order.total_price | money }}</div>
                  <div class="pk-order-actions" style="display:flex; gap:10px;">
                    {% if order.fulfillment_status == 'fulfilled' %}
                      <a href="{{ order.customer_url }}" class="pk-outline-btn">Reorder</a>
                    {% endif %}
                    <a href="{{ order.customer_url }}" class="pk-outline-btn">Invoice</a>
                  </div>
                </div>
              {% else %}
                <div class="pk-tr"><div style="grid-column: 1/-1; color: #595961;">No orders found.</div></div>
              {% endfor %}
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
              {% for address in customer.addresses limit: 2 %}
                <div class="pk-address-box">
                  <div class="pk-addr-top">
                    <h4>{% if forloop.index == 1 %}Home{% else %}Office{% endif %} {% if address == customer.default_address %}<span class="pk-default-tag">Default</span>{% endif %}</h4>
                    <a href="#" class="pk-edit-link">Edit</a>
                  </div>
                  <p>{{ address.name }} - {{ address.phone }}<br>
                  {{ address.address1 }}, {{ address.address2 }}<br>
                  {{ address.city }}, {{ address.province }} {{ address.zip }}</p>
                </div>
              {% else %}
                 <p style="color: #595961;">No addresses found.</p>
              {% endfor %}
            </div>
          </div>

        </div>
      </div>
    </div>

    <style>
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
    </style>

    <script>
      document.addEventListener("click", async function(e) {
        var link = e.target.closest("a.pk-menu-item");
        if (link && link.getAttribute("href").startsWith("/apps/purrkins/")) {
          e.preventDefault();
          
          document.querySelectorAll(".pk-menu-item").forEach(function(el) { el.classList.remove("active") });
          link.classList.add("active");
          
          var mainContent = document.querySelector(".pk-dashboard-content");
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
            
            var newContent = doc.querySelector(".pk-dashboard-content");
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
};
