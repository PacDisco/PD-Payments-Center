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
      return textResponse(
        500,
        "HubSpot token missing. Set HUBSPOT_PRIVATE_APP_TOKEN in Netlify."
      );
    }

    /* ------------------ STRIPE CHECKOUT ------------------ */

    if (checkout === "1") {
      if (!process.env.STRIPE_SECRET_KEY) {
        return textResponse(
          500,
          "Stripe missing. Set STRIPE_SECRET_KEY in Netlify."
        );
      }

      if (!dealId) return textResponse(400, "Missing dealId.");

      const deal = await getDealById(dealId);
      if (!deal) return textResponse(404, "Deal not found.");

      const p = deal.properties || {};
      const programName = p.dealname || "Program Payment";

      const programFee = safeNumber(p.amount);
      const totalPaidField = safeNumber(p.total_amount_paid);

      const allPayments = [];
      PAYMENT_FIELDS.forEach((key) => {
        const raw = p[key];
        if (!raw) return;
        const parts = raw.split(",").map((s) => s.trim());
        const amt = safeNumber(parts[0]);
        if (!isNaN(amt)) allPayments.push({ amount: amt });
      });

      const totalPaid = !isNaN(totalPaidField)
        ? totalPaidField
        : allPayments.reduce((s, p) => s + p.amount, 0);

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
        const raw = url.searchParams.get("amount");
        const amt = safeNumber(raw);
        if (isNaN(amt)) return textResponse(400, "Invalid custom amount.");
        if (amt < 250) return textResponse(400, "Minimum custom payment is $250.");
        if (amt > remaining + 0.01)
          return textResponse(400, "Custom amount exceeds remaining balance.");
        baseAmount = amt;
        label = "Custom Payment";
      } else {
        type = "remaining";
        baseAmount = remaining;
        label = "Remaining Program Balance";
      }

      if (baseAmount <= 0) {
        return textResponse(400, "No outstanding balance.");
      }

      /* Add 3.5% fee */
      const fee = baseAmount * 0.035;
      const totalWithFee = baseAmount + fee;

      /* Cancel URL returns user back to payments page */
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
                description: `${label} (Deal ID: ${dealId})`,
              },
              unit_amount: Math.round(totalWithFee * 100),
            },
            quantity: 1,
          },
        ],
        success_url:
          "https://pacificdiscovery.org/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: cancelUrl.toString(),
        metadata: {
          dealId: dealId,
          paymentType: type,
        },
      });

      return {
        statusCode: 302,
        headers: { Location: session.url },
        body: "",
      };
    }

    /* ------------------ LOOKUP MODE ------------------ */

    if (dealId) {
      const deal = await getDealById(dealId);
      if (!deal) return textResponse(404, "Deal not found.");
      deal.properties.email = email;

      return htmlResponse(200, renderDealPortal(deal));
    }

    if (!email) {
      return htmlResponse(
        400,
        basicPage(
          "Missing Email",
          "<p>You must access this from the payment portal link.</p>"
        )
      );
    }

    const contact = await findContactByEmail(email);
    if (!contact) {
      return htmlResponse(
        404,
        basicPage("Not Found", `<p>No records for ${escapeHtml(email)}</p>`)
      );
    }

    const deals = await getDealsForContact(contact.id);
    if (!deals.length) {
      return htmlResponse(
        404,
        basicPage(
          "No Programs",
          "<p>Your account exists, but no program payments found.</p>"
        )
      );
    }

    if (deals.length === 1) {
      deals[0].properties.email = email;
      return htmlResponse(200, renderDealPortal(deals[0]));
    }

    return htmlResponse(200, renderDealSelectionPage(deals, url));
  } catch (err) {
    console.error(err);
    return textResponse(500, "Unexpected Error");
  }
};

/* ---------------------------------------------------
   HUBSPOT HELPERS
--------------------------------------------------- */

async function hubSpotFetch(path, options = {}) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    console.error("HubSpot error", res.status);
    throw new Error("HubSpot error");
  }

  return res.json();
}

async function findContactByEmail(email) {
  const data = await hubSpotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
      ],
      properties: ["email"],
      limit: 1,
    }),
  });

  return data.results?.[0]
    ? { id: data.results[0].id, properties: data.results[0].properties }
    : null;
}

async function getDealsForContact(contactId) {
  const assoc = await hubSpotFetch(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`
  );

  const ids = assoc.results?.map((r) => r.toObjectId) || [];
  if (!ids.length) return [];

  const batch = await hubSpotFetch("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS],
      inputs: ids.map((id) => ({ id })),
    }),
  });

  return (
    batch.results?.map((d) => ({
      id: d.id,
      properties: { ...d.properties, email: contactEmailGlobal },
    })) || []
  );
}

async function getDealById(id) {
  const data = await hubSpotFetch(
    `/crm/v3/objects/deals/${id}?properties=${encodeURIComponent(
      ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS].join(",")
    )}`
  );
  return data?.id ? { id: data.id, properties: data.properties } : null;
}

/* ---------------------------------------------------
   UI RENDERING
--------------------------------------------------- */

function renderDealPortal(deal) {
  const p = deal.properties;
  const programFee = safeNumber(p.amount);
  const totalPaidField = safeNumber(p.total_amount_paid);

  const payments = [];
  PAYMENT_FIELDS.forEach((key) => {
    const raw = p[key];
    if (!raw) return;
    const parts = raw.split(",").map((s) => s.trim());
    const amt = safeNumber(parts[0]);
    if (!isNaN(amt)) {
      payments.push({
        amount: amt,
        txn: parts[1],
        date: parts[2],
      });
    }
  });

  const totalPaid = !isNaN(totalPaidField)
    ? totalPaidField
    : payments.reduce((s, p) => s + p.amount, 0);

  const remaining = programFee - totalPaid;

  const depositTarget = 2500;
  const depositRemaining = Math.max(0, depositTarget - totalPaid);

  const showAppFee = totalPaid === 0;
  const showDeposit = totalPaid > 0 && totalPaid < 2250;
  const hasRemaining = remaining > 0;

  const rows =
    payments.length > 0
      ? payments
          .map(
            (p) => `
      <tr>
        <td>${formatCurrency(p.amount)}</td>
        <td>${escapeHtml(p.date || "")}</td>
        <td>${escapeHtml(p.txn || "")}</td>
      </tr>
    `
          )
          .join("")
      : `<tr><td colspan="3" class="empty-row">No payments yet.</td></tr>`;

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
          <div class="value">${formatCurrency(programFee)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Paid So Far</div>
          <div class="value">${formatCurrency(totalPaid)}</div>
        </div>
        <div class="summary-card highlight">
          <div class="label">Remaining Balance</div>
          <div class="value">${formatCurrency(remaining)}</div>
        </div>
      </div>

      <!-- TWO-COLUMN PAYMENT AREA -->
      <div class="payment-columns">

        <!-- LEFT COLUMN -->
        <div class="payment-left-column">

          ${
            showAppFee
              ? `
        <div class="button-block">
          <a class="btn btn-blue"
             href="?checkout=1&type=appfee&dealId=${encodedDeal}&email=${encodedEmail}">
            Pay Application Fee
          </a>
          ${feeBox(250)}
        </div>`
              : ""
          }

          ${
            showDeposit && hasRemaining
              ? `
        <div class="button-block">
          <a class="btn btn-green"
             href="?checkout=1&type=deposit&dealId=${encodedDeal}&email=${encodedEmail}">
            Pay Deposit (${formatCurrency(depositRemaining)})
          </a>
          ${feeBox(depositRemaining)}
        </div>`
              : ""
          }

          ${
            hasRemaining
              ? `
        <div class="button-block">
          <a class="btn btn-purple"
             href="?checkout=1&type=remaining&dealId=${encodedDeal}&email=${encodedEmail}">
            Pay Remaining Balance
          </a>
          ${feeBox(remaining)}
        </div>`
              : `
        <div class="button-block">
          <div class="paid-message">Your balance is fully paid.</div>
        </div>`
          }

        </div>

        <!-- RIGHT COLUMN: CUSTOM PAYMENT CARD -->
        ${
          hasRemaining
            ? `
        <div class="payment-right-column">
          <div class="custom-payment-card"
               id="custom-payment-section"
               data-remaining="${remaining}">

            <h3 class="custom-title">Make a Payment</h3>
            <p class="custom-description">
              Choose an amount to pay toward your remaining balance.<br>
              Minimum $250, up to your remaining balance.
            </p>

            <form id="custom-payment-form">
              <label for="custom-amount">Amount in USD</label>
              <input type="number"
                     id="custom-amount"
                     min="250"
                     max="${remaining}"
                     step="0.01"
                     placeholder="250.00"
                     required/>
              <button class="btn btn-dark small-btn" type="submit">
                Make a Payment
              </button>
            </form>

            <div id="custom-fee-summary" class="fee-breakdown small"></div>
            <div id="custom-error" class="error-message"></div>

          </div>
        </div>`
            : ""
        }

      </div>

      <div class="section">
        <h2>Payment History</h2>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Amount</th>
                <th>Date</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>

    ${hasRemaining ? customPaymentScript() : ""}
  `
  );
}

/* ---------------------------------------------------
   UI HELPERS
--------------------------------------------------- */

function feeBox(base) {
  const fee = base * 0.035;
  const total = base + fee;
  return `
    <div class="fee-breakdown">
      <div>Base: ${formatCurrency(base)}</div>
      <div>Fee (3.5%): ${formatCurrency(fee)}</div>
      <div><strong>Total: ${formatCurrency(total)}</strong></div>
    </div>
  `;
}

function customPaymentScript() {
  return `
<script>
(function(){
  const section = document.getElementById('custom-payment-section');
  if(!section) return;

  const max = parseFloat(section.dataset.remaining);
  const input = document.getElementById('custom-amount');
  const form = document.getElementById('custom-payment-form');
  const feeBox = document.getElementById('custom-fee-summary');
  const err = document.getElementById('custom-error');

  function fmt(n){
    return '$' + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  }

  function update(){
    err.textContent = '';
    const v = parseFloat(input.value || '0');
    if(!v || v < 250){ feeBox.textContent = ''; return; }
    if(v > max){ feeBox.textContent=''; return; }
    const fee = v * 0.035;
    const total = v + fee;
    feeBox.innerHTML = 
      '<div>Base: '+fmt(v)+'</div>'+
      '<div>Fee (3.5%): '+fmt(fee)+'</div>'+
      '<div><strong>Total: '+fmt(total)+'</strong></div>';
  }

  form.addEventListener('submit', e=>{
    e.preventDefault();
    err.textContent='';
    const v = parseFloat(input.value || '0');
    if(v < 250){ err.textContent='Minimum payment is $250.'; return; }
    if(v > max){ err.textContent='Amount exceeds remaining balance.'; return; }

    const params = new URLSearchParams(window.location.search);
    params.set('checkout','1');
    params.set('type','custom');
    params.set('amount',v.toFixed(2));
    window.location.search = params.toString();
  });

  input.addEventListener('input',update);
})();
</script>
`;
}

/* ---------------------------------------------------
   PAGE WRAPPER
--------------------------------------------------- */

function stripePage(title, body) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>

/* Base Styles */
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Segoe UI", sans-serif;
  background: #f3f4f6;
  margin: 0;
}
.container {
  max-width: 720px;
  margin: 40px auto;
  padding: 24px;
  background: white;
  border-radius: 16px;
  box-shadow: 0 18px 45px rgba(15,23,42,0.12);
}
h1 { margin: 0 0 12px; font-size: 1.6rem; }

/* Summary Cards */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit,minmax(160px,1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.summary-card {
  padding: 14px;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  background: white;
}
.summary-card.highlight {
  border-color: #4f46e5;
  background: radial-gradient(circle at top left,#eef2ff,#f9fafb);
}
.label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #6b7280;
  margin-bottom: 4px;
}
.value {
  font-size: 1.1rem;
  font-weight: 600;
}

/* Payment columns */
.payment-columns {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 24px;
  align-items: start;
  margin-top: 20px;
}
.payment-left-column {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.payment-right-column {
  display: flex;
  justify-content: flex-end;
}

/* Buttons */
.button-block { margin-bottom: 10px; }
.btn {
  display: inline-block;
  padding: 10px 18px;
  border-radius: 999px;
  font-weight: 600;
  text-decoration: none;
  color: white;
}
.btn-blue { background: #3b82f6; }
.btn-green { background: #10b981; }
.btn-purple { background: #4f46e5; }
.btn-dark { background:#111827; }
.small-btn { padding: 8px 12px; border-radius: 8px; }

/* Custom Payment Card */
.custom-payment-card {
  width: 100%;
  padding: 18px;
  border-radius: 14px;
  border: 1px solid #e5e7eb;
  background: #fafafa;
  box-shadow: 0 4px 12px rgba(0,0,0,0.05);
}
.custom-title {
  margin: 0 0 8px;
  font-size: 1.05rem;
  font-weight: 600;
}
.custom-description {
  margin: 0 0 14px;
  font-size: 0.85rem;
  color: #4b5563;
}
label { display: block; margin-bottom: 5px; font-size: 0.9rem; }
input[type="number"]{
  width: 100%;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  font-size: 0.95rem;
  margin-bottom: 8px;
}
input:focus {
  outline: none;
  border-color: #4f46e5;
  box-shadow: 0 0 0 1px #4f46e5;
}
.error-message { color:#b91c1c; font-size: 0.85rem; }

/* Fee breakdown */
.fee-breakdown {
  margin-top: 6px;
  font-size: 0.85rem;
  color:#4b5563;
}
.fee-breakdown.small { font-size:0.8rem; }

/* History table */
.table-wrapper {
  margin-top: 20px;
  border-radius: 12px;
  border:1px solid #e5e7eb;
  overflow: hidden;
}
table { width:100%; border-collapse: collapse; }
th,td {
  padding:10px;
  border-bottom:1px solid #e5e7eb;
}
th {
  background:#f9fafb;
  font-size:0.8rem;
  color:#4b5563;
  text-transform: uppercase;
  letter-spacing:0.06em;
}
.empty-row {
  text-align:center;
  color:#9ca3af;
  font-style:italic;
}

/* Mobile Responsive */
@media(max-width:900px){
  .payment-columns {
    grid-template-columns: 1fr;
  }
  .payment-right-column {
    justify-content: center;
  }
}

</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/* ---------------------------------------------------
   UTILITIES
--------------------------------------------------- */

function safeNumber(val) {
  const n = Number(val);
  return isNaN(n) ? NaN : n;
}

function formatCurrency(n) {
  return isNaN(n)
    ? "—"
    : "$" +
        n.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textResponse(code, msg) {
  return {
    statusCode: code,
    headers: { "Content-Type": "text/plain" },
    body: msg,
  };
}

function htmlResponse(code, html) {
  return {
    statusCode: code,
    headers: { "Content-Type": "text/html" },
    body: html,
  };
}

function basicPage(title, html) {
  return stripePage(title, `<div class="container">${html}</div>`);
}
