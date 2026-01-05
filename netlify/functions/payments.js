// netlify/functions/payments.js

const HUBSPOT_BASE = "https://api.hubapi.com";
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const PAYMENT_FIELDS = [
  "payment_1",
  "payment_2",
  "payment_3",
  "payment_4",
  "payment_5",
];

let contactEmailGlobal = null;

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const email = url.searchParams.get("email");
    const dealId = url.searchParams.get("dealId");
    const checkout = url.searchParams.get("checkout");

    contactEmailGlobal = email;

    if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
      return textResponse(500, "HubSpot token missing.");
    }

    /* ---------- STRIPE CHECKOUT ---------- */
    if (checkout === "1") {
      if (!process.env.STRIPE_SECRET_KEY) {
        return textResponse(500, "Stripe key missing.");
      }

      if (!dealId) return textResponse(400, "Missing dealId.");

      const deal = await getDealById(dealId);
      if (!deal) return textResponse(404, "Deal not found.");

      const p = deal.properties || {};
      const programName = p.dealname || "Program Payment";

      const programFee = safeNumber(p.amount);
      const totalPaid = safeNumber(p.total_amount_paid) || 0;
      const remaining = programFee - totalPaid;

      const depositTarget = 2500;
      const depositRemaining = Math.max(0, depositTarget - totalPaid);

      let type = url.searchParams.get("type");
      let baseAmount = 0;
      let label = "";

      if (type === "appfee") {
        baseAmount = 250;
        label = "Application Fee";
      } else if (type === "deposit") {
        baseAmount = depositRemaining;
        label = "Program Deposit";
      } else if (type === "custom") {
        const amt = safeNumber(url.searchParams.get("amount"));
        if (isNaN(amt) || amt < 250 || amt > remaining) {
          return textResponse(400, "Invalid custom amount.");
        }
        baseAmount = amt;
        label = "Custom Payment";
      } else {
        baseAmount = remaining;
        label = "Remaining Program Balance";
      }

      if (baseAmount <= 0) return textResponse(400, "No balance due.");

      const fee = baseAmount * 0.035;
      const totalWithFee = baseAmount + fee;

      const baseUrl = new URL(event.rawUrl);
      baseUrl.search = "";
      const cancelUrl = new URL(baseUrl.toString());
      cancelUrl.searchParams.set("dealId", dealId);
      if (email) cancelUrl.searchParams.set("email", email);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email || undefined,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: programName,
                description: `${label} – Deal ID: ${dealId}`,
              },
              unit_amount: Math.round(totalWithFee * 100),
            },
            quantity: 1,
          },
        ],
        success_url:
          "https://pacificdiscovery.org/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: cancelUrl.toString(),
        metadata: { dealId, paymentType: type || "remaining" },
      });

      return {
        statusCode: 302,
        headers: { Location: session.url },
        body: "",
      };
    }

    /* ---------- PAGE RENDER ---------- */
    if (dealId) {
      const deal = await getDealById(dealId);
      deal.properties.email = email;
      return htmlResponse(200, renderDealPortal(deal));
    }

    return textResponse(400, "Missing dealId.");
  } catch (e) {
    console.error(e);
    return textResponse(500, "Unexpected error.");
  }
};

/* ---------- RENDER ---------- */

function renderDealPortal(deal) {
  const p = deal.properties;
  const programFee = safeNumber(p.amount);
  const totalPaid = safeNumber(p.total_amount_paid) || 0;
  const remaining = programFee - totalPaid;

  const depositTarget = 2500;
  const depositRemaining = Math.max(0, depositTarget - totalPaid);

  const encodedDeal = encodeURIComponent(deal.id);
  const encodedEmail = encodeURIComponent(p.email || "");

  return stripePage(
    "Payment Summary",
    `
<div class="container">
  <h1>${escapeHtml(p.dealname || "Program")}</h1>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">Program Tuition</div>
      <div class="value">${fmt(programFee)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Paid So Far</div>
      <div class="value">${fmt(totalPaid)}</div>
    </div>
    <div class="summary-card highlight">
      <div class="label">Remaining Balance</div>
      <div class="value">${fmt(remaining)}</div>
    </div>
  </div>

  <div class="payment-columns">

    <div class="payment-left-column">
      ${
        totalPaid === 0
          ? `<div class="button-block">
              <a class="btn btn-blue" href="?checkout=1&type=appfee&dealId=${encodedDeal}&email=${encodedEmail}">
                Pay Application Fee
              </a>
              ${feeBox(250)}
            </div>`
          : ""
      }

      ${
        totalPaid > 0 && totalPaid < 2250
          ? `<div class="button-block">
              <a class="btn btn-green" href="?checkout=1&type=deposit&dealId=${encodedDeal}&email=${encodedEmail}">
                Pay Deposit (${fmt(depositRemaining)})
              </a>
              ${feeBox(depositRemaining)}
            </div>`
          : ""
      }

      ${
        remaining > 0
          ? `<div class="button-block">
              <a class="btn btn-purple" href="?checkout=1&type=remaining&dealId=${encodedDeal}&email=${encodedEmail}">
                Pay Remaining Balance
              </a>
              ${feeBox(remaining)}
            </div>`
          : `<div class="paid-message">Your balance is fully paid.</div>`
      }
    </div>

    ${
      remaining > 0
        ? `
    <div class="payment-right-column">
      <div class="custom-payment-card" id="custom-payment-section" data-remaining="${remaining}">
        <h3>Make a Payment</h3>
        <p>Minimum $250, up to remaining balance.</p>
        <form id="custom-payment-form">
          <input type="number" id="custom-amount" min="250" max="${remaining}" step="0.01" required />
          <button class="btn btn-dark small-btn">Make a Payment</button>
        </form>
        <div id="custom-fee-summary" class="fee-breakdown small"></div>
        <div id="custom-error" class="error-message"></div>
      </div>
    </div>`
        : ""
    }

  </div>

  <!-- ✅ ONLY NEW ADDITION -->
  <div class="payment-disclaimer">
    <em>
      A 3.5% transaction fee is applied to all credit card payments.
      To pay by wire transfer or ACH without the transaction fee,
      <a href="https://www.pacificdiscovery.org/student/payment/pay-now/wire-transfer-payment"
         target="_blank" rel="noopener noreferrer">
        click here to view wire transfer payment instructions
      </a>.
    </em>
  </div>

  <div class="section">
    <h2>Payment History</h2>
  </div>
</div>

${remaining > 0 ? customPaymentScript() : ""}
`
  );
}

/* ---------- HELPERS ---------- */

function feeBox(base) {
  const fee = base * 0.035;
  return `<div class="fee-breakdown">
    Base: ${fmt(base)}<br>
    Fee (3.5%): ${fmt(fee)}<br>
    <strong>Total: ${fmt(base + fee)}</strong>
  </div>`;
}

function customPaymentScript() {
  return `<script>
(function(){
  const s=document.getElementById('custom-payment-section');
  if(!s) return;
  const max=parseFloat(s.dataset.remaining);
  const i=document.getElementById('custom-amount');
  const f=document.getElementById('custom-fee-summary');
  const e=document.getElementById('custom-error');

  i.addEventListener('input',()=>{
    const v=parseFloat(i.value||0);
    if(v<250||v>max){f.textContent='';return;}
    const fee=v*0.035;
    f.innerHTML='Base: $'+v.toFixed(2)+'<br>Fee (3.5%): $'+fee.toFixed(2)+'<br><strong>Total: $'+(v+fee).toFixed(2)+'</strong>';
  });

  document.getElementById('custom-payment-form').onsubmit=function(ev){
    ev.preventDefault();
    const v=parseFloat(i.value||0);
    if(v<250||v>max){e.textContent='Invalid amount.';return;}
    const p=new URLSearchParams(location.search);
    p.set('checkout','1');p.set('type','custom');p.set('amount',v.toFixed(2));
    location.search=p.toString();
  };
})();
</script>`;
}

/* ---------- PAGE ---------- */

function stripePage(title, body) {
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui;background:#f3f4f6;margin:0}
.container{max-width:720px;margin:40px auto;padding:24px;background:#fff;border-radius:16px}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.summary-card{border:1px solid #e5e7eb;border-radius:12px;padding:14px}
.summary-card.highlight{border-color:#4f46e5}
.payment-columns{display:grid;grid-template-columns:1fr 280px;gap:24px;margin-top:20px}
@media(max-width:900px){.payment-columns{grid-template-columns:1fr}}
.btn{display:inline-block;padding:10px 18px;border-radius:999px;color:#fff;text-decoration:none}
.btn-blue{background:#3b82f6}.btn-green{background:#10b981}.btn-purple{background:#4f46e5}.btn-dark{background:#111827}
.custom-payment-card{border:1px solid #e5e7eb;border-radius:14px;padding:18px;background:#fafafa}
.payment-disclaimer{margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:.85rem;color:#4b5563}
.payment-disclaimer a{color:#4f46e5}
</style>
</head><body>${body}</body></html>`;
}

/* ---------- UTILS ---------- */

function fmt(n) {
  return isNaN(n)
    ? "—"
    : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2 });
}
function safeNumber(v) {
  const n = Number(v);
  return isNaN(n) ? NaN : n;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function textResponse(code, msg) {
  return { statusCode: code, headers: { "Content-Type": "text/plain" }, body: msg };
}
function htmlResponse(code, html) {
  return { statusCode: code, headers: { "Content-Type": "text/html" }, body: html };
}
