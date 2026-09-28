import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const liquidTemplate = `
    {% if customer %}
      <script>window.location.href = "/apps/purrkins/dashboard";</script>
    {% endif %}

    <style>
      body, html {
        margin: 0;
        padding: 0;
        font-family: var(--font-body--family, sans-serif);
        background-color: #f4f4f5;
      }
      .pk-login-container {
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: calc(100vh - 120px);
        padding: 40px 20px;
      }
      .pk-login-card {
        display: flex;
        background: linear-gradient(135deg, #FFFAE0 0%, #E8F0FF 100%);
        border-radius: 24px;
        overflow: hidden;
        max-width: 1000px;
        width: 100%;
        box-shadow: 0 10px 40px rgba(0,0,0,0.05);
      }
      .pk-login-left {
        flex: 1;
        padding: 60px;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .pk-login-right {
        flex: 1.2;
        background-image: url('https://purrkins-mhrlfymw.myshopify.com/apps/purrkins/cat-login.jpg');
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        min-height: 500px;
      }
      .pk-login-title {
        font-family: var(--font-heading--family, sans-serif);
        font-size: 36px;
        font-weight: 900;
        color: #121217;
        margin: 0 0 40px 0;
      }
      .pk-input-group {
        margin-bottom: 20px;
      }
      .pk-input-group input {
        width: 100%;
        padding: 16px 20px;
        border-radius: 30px;
        border: 1px solid #d1d1d1;
        background: #fff;
        font-size: 15px;
        box-sizing: border-box;
        outline: none;
        transition: 0.2s;
      }
      .pk-input-group input:focus {
        border-color: #ffd831;
        box-shadow: 0 0 0 3px rgba(255, 216, 49, 0.2);
      }
      .pk-login-options {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 30px;
        font-size: 14px;
      }
      .pk-remember {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #595961;
      }
      .pk-forgot {
        color: #595961;
        text-decoration: underline;
      }
      .pk-btn-primary {
        background: #ffd831;
        color: #121217;
        font-weight: 800;
        font-size: 16px;
        border: none;
        border-radius: 30px;
        padding: 16px;
        width: 100%;
        cursor: pointer;
        transition: 0.2s;
        margin-bottom: 15px;
      }
      .pk-btn-primary:hover {
        background: #f0c822;
      }
      .pk-btn-google {
        background: #f8f6f0;
        color: #121217;
        font-weight: 800;
        font-size: 16px;
        border: none;
        border-radius: 30px;
        padding: 16px;
        width: 100%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        transition: 0.2s;
        margin-bottom: 30px;
      }
      .pk-btn-google:hover {
        background: #eae8e2;
      }
      .pk-signup-text {
        text-align: center;
        color: #8c8c9a;
        font-size: 14px;
      }
      .pk-signup-text a {
        color: #121217;
        font-weight: 700;
        text-decoration: underline;
      }

      /* Shopify Form Error Styles */
      .errors {
        background: #fff0f0;
        color: #d8000c;
        padding: 15px;
        border-radius: 12px;
        margin-bottom: 20px;
        font-size: 14px;
        border: 1px solid #ffd2d2;
      }
      .errors ul { margin: 0; padding-left: 20px; }

      @media (max-width: 900px) {
        .pk-login-card {
          flex-direction: column;
        }
        .pk-login-right {
          min-height: 300px;
        }
        .pk-login-left {
          padding: 40px 20px;
        }
      }
    </style>

    <div class="pk-login-container">
      <div class="pk-login-card">
        <div class="pk-login-left">
          <h1 class="pk-login-title">Log in or sign up</h1>
          
          {% form 'customer_login' %}
            {{ form.errors | default_errors }}
            
            <input type="hidden" name="checkout_url" value="/apps/purrkins/dashboard">

            <div class="pk-input-group">
              <input type="email" name="customer[email]" placeholder="Email address" required>
            </div>
            <div class="pk-input-group" style="position: relative;">
              <input type="password" name="customer[password]" placeholder="Password" id="pk-login-pass" required>
              <button type="button" onclick="togglePass()" style="position: absolute; right: 15px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; color: #595961;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>

            <div class="pk-login-options">
              <label class="pk-remember">
                <input type="checkbox" name="remember" checked>
                Remember me
              </label>
              <a href="/account/login#recover" class="pk-forgot">Forgot Password</a>
            </div>

            <button type="submit" class="pk-btn-primary">Log in</button>
            
          {% endform %}

          <button class="pk-btn-google">
            <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Log in with Google
          </button>

          <div class="pk-signup-text">
            Don't have an account? <a href="/account/register">Sign Up</a>
          </div>
        </div>
        <div class="pk-login-right"></div>
      </div>
    </div>
    
    <script>
      function togglePass() {
        var input = document.getElementById("pk-login-pass");
        if (input.type === "password") {
          input.type = "text";
        } else {
          input.type = "password";
        }
      }
    </script>
  `;

  return new Response(liquidTemplate, {
    headers: {
      "Content-Type": "application/liquid",
    },
  });
};
