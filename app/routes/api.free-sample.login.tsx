import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const email = (formData.get("email") as string).trim().toLowerCase();

  if (intent === "send_otp") {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Delete any existing OTPs for this email first
    // @ts-ignore
    await prisma.oTP.deleteMany({ where: { email } });

    // @ts-ignore
    await prisma.oTP.create({
      data: {
        email,
        code,
        expiresAt: new Date(Date.now() + 15 * 60000), // 15 minutes
      }
    });

    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD
        }
      });

      await transporter.sendMail({
        from: `"Purrkins" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `Your Purrkins Login Code - ${new Date().toLocaleTimeString()}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #121217; text-align: center;">Purrkins Login</h2>
            <p style="font-size: 16px; color: #595961; text-align: center;">Use the following 6-digit code to log in to your account. This code expires in 10 minutes.</p>
            <div style="background-color: #f4f4f5; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #000;">${code}</span>
            </div>
            <p style="font-size: 14px; color: #8c8c9a; text-align: center;">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `
      });
      console.log(`Email sent successfully to ${email}`);
    } catch (e) {
      console.error("Email send failed:", e);
      return new Response(JSON.stringify({ success: false, error: "Failed to send email. Check Gmail credentials." }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true, message: "OTP Sent" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (intent === "verify_otp") {
    const code = (formData.get("code") as string).trim();
    
    // @ts-ignore
    const validOtp = await prisma.oTP.findFirst({
      where: { email, code, expiresAt: { gt: new Date() } }
    });

    if (!validOtp) {
      return new Response(JSON.stringify({ success: false, error: "Invalid or expired code" }), { status: 400 });
    }

    const tempPassword = "Temp" + Math.random().toString(36).slice(-8) + "X!";
    
    const searchRes = await admin.graphql(`
      query {
        customers(first: 5, query: "email:${email}") {
          edges { node { id email firstName } }
        }
      }
    `);
    const searchData = await searchRes.json();
    console.log("=== LOGIN SEARCH RESULT ===", JSON.stringify(searchData?.data?.customers?.edges, null, 2));
    const customerEdge = searchData.data.customers.edges[0];
    
    let customerId;
    if (customerEdge) {
      customerId = customerEdge.node.id;
      console.log("Found existing customer:", customerId, customerEdge.node.firstName, customerEdge.node.email);
    } else {
      // Create customer without password (Shopify New Customer Accounts doesn't support password field)
      const createRes = await admin.graphql(`
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id email firstName }
            userErrors { field message }
          }
        }
      `, {
        variables: { input: { email } }
      });
      const createData = await createRes.json();
      console.log("Create customer result:", JSON.stringify(createData?.data?.customerCreate, null, 2));
      customerId = createData.data?.customerCreate?.customer?.id;
    }

    console.log("Final customerId for JWT:", customerId);

    // @ts-ignore
    await prisma.oTP.delete({ where: { id: validOtp.id } });

    // Generate JWT token for session
    const token = jwt.sign({ customerId, email }, process.env.SHOPIFY_API_SECRET || "s3cr3t", { expiresIn: "7d" });

    return new Response(JSON.stringify({ success: true, token, redirect: "/apps/purrkins/dashboard" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Invalid intent" }), { status: 400 });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const liquidTemplate = `
    {% if customer %}
      <script>window.location.href = "/apps/purrkins/dashboard";</script>
    {% endif %}

    <style>
      body, html {
        margin: 0;
        padding: 0;
        font-family: var(--font-body--family, 'Inter', sans-serif);
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
        background-image: url('/apps/purrkins/login-images.png');
        background-size: contain;
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

      /* Email Step Styles */
      .pk-inline-input-group {
        position: relative;
        margin-bottom: 25px;
      }
      .pk-inline-input-group input {
        width: 100%;
        padding: 20px 60px 20px 20px;
        border-radius: 12px;
        border: 2px solid #0056b3;
        background: #fff;
        font-size: 16px;
        box-sizing: border-box;
        outline: none;
        transition: 0.2s;
        box-shadow: 0 2px 10px rgba(0,0,0,0.02);
      }
      .pk-inline-input-group input:focus {
        border-color: #004494;
        box-shadow: 0 0 0 3px rgba(0, 86, 179, 0.15);
      }
      .pk-inline-input-btn {
        position: absolute;
        right: 15px;
        top: 50%;
        transform: translateY(-50%);
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #121217;
        transition: 0.2s;
      }
      .pk-inline-input-btn:hover {
        transform: translateY(-50%) translateX(3px);
      }
      .pk-inline-input-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .pk-checkbox-group {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 40px;
      }
      .pk-checkbox-group input[type="checkbox"] {
        appearance: none;
        width: 20px;
        height: 20px;
        border: 1px solid #d1d1d1;
        border-radius: 4px;
        background: #fff;
        cursor: pointer;
        position: relative;
      }
      .pk-checkbox-group input[type="checkbox"]:checked {
        background: #121217;
        border-color: #121217;
      }
      .pk-checkbox-group input[type="checkbox"]:checked::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 6px;
        width: 4px;
        height: 10px;
        border: solid white;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }
      .pk-checkbox-group label {
        font-size: 15px;
        color: #121217;
        cursor: pointer;
      }

      /* OTP Step Styles */
      .pk-otp-title {
        font-size: 28px;
        font-weight: 700;
        color: #000;
        margin: 0 0 10px 0;
      }
      .pk-otp-subtitle {
        font-size: 15px;
        color: #595961;
        margin-bottom: 30px;
      }
      .pk-otp-change {
        color: #0056b3;
        text-decoration: none;
        margin-left: 8px;
        cursor: pointer;
      }
      .pk-otp-change:hover {
        text-decoration: underline;
      }
      .pk-otp-inputs {
        display: flex;
        gap: 10px;
        margin-bottom: 20px;
      }
      .pk-otp-inputs input {
        width: 45px;
        height: 60px;
        border: 1px solid #d1d1d1;
        border-radius: 8px;
        font-size: 24px;
        text-align: center;
        background: #fff;
        outline: none;
        transition: 0.2s;
      }
      .pk-otp-inputs input:focus {
        border-color: #0056b3;
        border-width: 2px;
        box-shadow: 0 0 0 3px rgba(0, 86, 179, 0.1);
      }
      
      .errors {
        background: #fff0f0;
        color: #d8000c;
        padding: 15px;
        border-radius: 12px;
        margin-bottom: 20px;
        font-size: 14px;
        border: 1px solid #ffd2d2;
        display: none;
      }

      /* Google button */
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
      }
      .pk-btn-google:hover {
        background: #eae8e2;
      }

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
        .pk-otp-inputs input {
          width: 40px;
          height: 50px;
          font-size: 20px;
        }
      }
    </style>

    <div class="pk-login-container">
      <div class="pk-login-card">
        <div class="pk-login-left">
          
          <div id="otp-flow-container">
            <!-- Step 1: Email Form -->
            <form id="otp-email-form">
              <h1 class="pk-login-title">Log in or sign up</h1>
              
              <div class="errors" id="otp-error"></div>
              
              <div class="pk-inline-input-group">
                <input type="email" name="email" id="otp-email" placeholder="Email" required autocomplete="email">
                <button type="submit" class="pk-inline-input-btn" id="otp-send-btn" aria-label="Submit">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </button>
              </div>

              <div class="pk-checkbox-group">
                <input type="checkbox" id="news-offers" name="news">
                <label for="news-offers">Email me with news and offers</label>
              </div>

              <button type="button" class="pk-btn-google" onclick="window.location.href='/account/login'">
                <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                Continue with Google
              </button>
            </form>

            <!-- Step 2: Verify OTP Form -->
            <form id="otp-verify-form" style="display: none;">
              <h2 class="pk-otp-title">Enter code</h2>
              <div class="pk-otp-subtitle">
                Sent to <span id="display-email"></span>
                <a class="pk-otp-change" id="otp-back-btn">Change</a>
              </div>

              <div class="errors" id="verify-error"></div>
              
              <div class="pk-otp-inputs" id="otp-inputs">
                <input type="text" maxlength="1" pattern="[0-9]*" inputmode="numeric" required autocomplete="off">
                <input type="text" maxlength="1" pattern="[0-9]*" inputmode="numeric" required autocomplete="off">
                <input type="text" maxlength="1" pattern="[0-9]*" inputmode="numeric" required autocomplete="off">
                <input type="text" maxlength="1" pattern="[0-9]*" inputmode="numeric" required autocomplete="off">
                <input type="text" maxlength="1" pattern="[0-9]*" inputmode="numeric" required autocomplete="off">
                <input type="text" maxlength="1" pattern="[0-9]*" inputmode="numeric" required autocomplete="off">
              </div>
              
              <div id="verifying-text" style="display: none; color: #0056b3; font-weight: 600; margin-top: 10px;">Verifying...</div>
            </form>
          </div>
        </div>
        <div class="pk-login-right"></div>
      </div>
    </div>
    
    <script>
      (function() {
        var emailForm = document.getElementById('otp-email-form');
        var verifyForm = document.getElementById('otp-verify-form');
        var emailInput = document.getElementById('otp-email');
        var displayEmail = document.getElementById('display-email');
        var currentEmail = '';

        // Step 1: Handle Email Submission
        if(emailForm) {
          emailForm.addEventListener('submit', function(e) {
            e.preventDefault();
            var btn = document.getElementById('otp-send-btn');
            btn.disabled = true;
            document.getElementById('otp-error').style.display = 'none';

            currentEmail = emailInput.value;
            
            var formData = new FormData();
            formData.append('intent', 'send_otp');
            formData.append('email', currentEmail);

            fetch(window.location.pathname, { method: 'POST', body: formData })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              btn.disabled = false;
              if(data.success) {
                emailForm.style.display = 'none';
                verifyForm.style.display = 'block';
                displayEmail.innerText = currentEmail;
                var inputs = document.querySelectorAll('#otp-inputs input');
                if(inputs.length > 0) inputs[0].focus();
              } else {
                document.getElementById('otp-error').innerText = data.error || 'Something went wrong';
                document.getElementById('otp-error').style.display = 'block';
              }
            })
            .catch(function(e) {
              btn.disabled = false;
              document.getElementById('otp-error').innerText = 'Network error. Try again.';
              document.getElementById('otp-error').style.display = 'block';
            });
          });
        }

        // Step 2: Handle OTP Input Navigation & Submission
        var otpInputs = Array.from(document.querySelectorAll('#otp-inputs input'));
        var verifyingText = document.getElementById('verifying-text');

        function submitOtp() {
          var code = otpInputs.map(function(i) { return i.value; }).join('');
          if (code.length !== 6) return;

          otpInputs.forEach(function(i) { i.disabled = true; });
          verifyingText.style.display = 'block';
          document.getElementById('verify-error').style.display = 'none';

          var formData = new FormData();
          formData.append('intent', 'verify_otp');
          formData.append('email', currentEmail);
          formData.append('code', code);

          fetch(window.location.pathname, { method: 'POST', body: formData })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if(data.success && data.token) {
              localStorage.setItem('pk_session', data.token);
              window.location.href = (data.redirect || "/apps/purrkins/dashboard") + "?session=" + data.token;
            } else {
              resetOtpForm(data.error || 'Invalid code');
            }
          })
          .catch(function(e) {
            resetOtpForm('Network error. Try again.');
          });
        }

        function resetOtpForm(errorMsg) {
          otpInputs.forEach(function(i) { i.disabled = false; i.value = ''; });
          verifyingText.style.display = 'none';
          document.getElementById('verify-error').innerText = errorMsg;
          document.getElementById('verify-error').style.display = 'block';
          otpInputs[0].focus();
        }

        otpInputs.forEach(function(input, index) {
          // Handle paste
          input.addEventListener('paste', function(e) {
            e.preventDefault();
            var pastedData = (e.clipboardData || window.clipboardData).getData('text');
            var numericData = pastedData.replace(/\\D/g, '').slice(0, 6);
            if (numericData.length > 0) {
              for (var i = 0; i < numericData.length; i++) {
                if (otpInputs[index + i]) {
                  otpInputs[index + i].value = numericData[i];
                }
              }
              var nextInput = otpInputs[index + numericData.length];
              if (nextInput) nextInput.focus();
              else if (numericData.length === 6) submitOtp();
            }
          });

          // Handle input
          input.addEventListener('input', function(e) {
            if (this.value.length === 1) {
              var nextInput = otpInputs[index + 1];
              if (nextInput) {
                nextInput.focus();
              } else {
                this.blur();
                submitOtp();
              }
            }
          });

          // Handle backspace
          input.addEventListener('keydown', function(e) {
            if (e.key === 'Backspace' && this.value.length === 0) {
              var prevInput = otpInputs[index - 1];
              if (prevInput) {
                prevInput.focus();
                prevInput.value = '';
              }
            }
          });
        });

        var backBtn = document.getElementById('otp-back-btn');
        if (backBtn) {
          backBtn.addEventListener('click', function(e) {
            e.preventDefault();
            verifyForm.style.display = 'none';
            emailForm.style.display = 'block';
            otpInputs.forEach(function(i) { i.value = ''; });
            document.getElementById('verify-error').style.display = 'none';
          });
        }
      })();
    </script>
  `;

  return new Response(liquidTemplate, {
    headers: {
      "Content-Type": "application/liquid",
    },
  });
};
