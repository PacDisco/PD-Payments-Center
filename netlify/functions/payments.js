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

// Constants
const APP_FEE = 250; // USD
const DEPOSIT_TARGET = 2500; // USD
const DEPOSIT_BUTTON_HIDE_AT_PAID = 2250; // Show deposit button if paid < 2250 (your rule)
const CARD_FEE_RATE = 0.035; // 3.5%

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const email = url.searchParams.get("email");
    const dealId = url.searchParams.get("dealId");
    const checkout = url.searchParams.get("checkout");

    if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
      return textResponse(
        500,
        "HubSpot token not configured. Please set HUBSPOT_PRIVATE_APP_TOKEN."
      );
    }

    // Stripe redirect flow
    if (checkout === "1") {
      return await handleStripeCheckout(event, url);
    }

    // If dealId present, render portal for that deal
    if (dealId) {
      const deal = await getDealById(dealId);
      if (!deal) {
        return htmlResponse(
          404,
          basicPage("Could not find that program", `<p>Deal not found.</p>`)
        );
      }
      deal.properties.email = email || deal.properties.email || "";
      return htmlResponse(200, renderDealPortal(deal));
    }

    // Otherwise we expect an email to look up deals
    if (!email) {
      return htmlResponse(
        400,
        basicPage(
          "Missing email",
          `<p>Please access this page via the portal form so we know which account to look up.</p>`
        )
      );
    }

    const contact = await findContactByEmail(email);
    if (!contact) {
      return htmlResponse(
        404,
        basicPage(
          "No account found",
          `<p>We couldn't find any records for <strong>${escapeHtml(
            email
          )}</strong>.</p>`
        )
      );
    }

    const deals = await getDealsForContact(contact.id, email);

    if (!deals || deals.length === 0) {
      return htmlResponse(
        404,
        basicPage(
          "No programs found",
          `<p>We found your contact (<strong>${escapeHtml(
            email
          )}</strong>) but no program payment records yet.</p>`
        )
      );
    }

    if (deals.length === 1) {
      return htmlResponse(200, renderDealPortal(deals[0]));
    }

    return htmlResponse(200, renderDealSelectionPage(deals, url, email));
  } catch (err) {
    console.error("Handler error:", err);
    return textResponse(500, "Unexpected error");
  }
};

/* =========================================================
   STRIPE CHECKOUT
========================================================= */

async function handleStripeCheckout(event, url) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return textResponse(500, "Stripe key not configured. Set STRIPE_SECRET_KEY.");
  }

  const dealId = url.searchParams.get("dealId");
  const type = url.searchParams.get("type"); // appfee | deposit | remaining | custom
  const email = url.searchParams.get("email") || "";

  if (!dealId) return textResponse(400, "Missing dealId.");

  const deal = await getDealById(dealId);
  if (!deal) return textResponse(404, "Deal not found.");

  const p = deal.properties || {};
  const programName = p.dealname || "Program Payment";

  const payments = parsePayments(p);
  const tuition = safeNumber(p.amount);

  const totalPaid =
    !isNaN(safeNumber(p.total_amount_paid))
      ? safeNumber(p.total_amount_paid)
      : payments.reduce((s, pay) => s + pay.amount, 0);

  const remaining = !isNaN(tuition) ? tuition - totalPaid : NaN;
  const depositRemaining = Math.max(0, DEPOSIT_TARGET - totalPaid);

  let base = 0;
  let label = "";

  if (type === "appfee") {
    base = APP_FEE;
    label = "Application Fee";
  } else if (type === "deposit") {
    base = depositRemaining;
    label = "Program Deposit";
  } else if (type === "custom") {
    const amt = safeNumber(url.searchParams.get("amount"));
    if (isNaN(amt)) return textResponse(400, "Invalid amount.");
    if (amt < APP_FEE) return textResponse(400, "Minimum payment is $250.");
    if (!isNaN(remaining) && amt > remaining)
      return textResponse(400, "Amount cannot exceed remaining balance.");
    base = amt;
    label = "Custom Payment";
  } else {
    base = remaining;
    label = "Remaining Program Balance";
  }

  if (!base || isNaN(base) || base <= 0) {
    return textResponse(400, "No balance due.");
  }

  const fee = base * CARD_FEE_RATE;
  const total = base + fee;

  // Cancel should return to the previous step (the deal portal)
  // Include email so the portal can preserve it if needed
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
          unit_amount: Math.round(total * 100),
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

/* =========================================================
   HUBSPOT HELPERS
========================================================= */

async function hubSpotFetch(path, options = {}) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("HubSpot error:", res.status, body);
    throw new Error(`HubSpot API error ${res.status}`);
  }

  return res.json();
}

async function findContactByEmail(email) {
  const body = {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
    ],
    properties: ["email", "firstname", "lastname"],
    limit: 1,
  };

  const data = await hubSpotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!data.results || data.results.length === 0) return null;
  return { id: data.results[0].id, properties: data.results[0].properties || {} };
}

async function getDealsForContact(contactId, email) {
  const assoc = await hubSpotFetch(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`
  );

  const dealIds =
    assoc.results?.map((r) => r.toObjectId).filter(Boolean) || [];

  if (dealIds.length === 0) return [];

  const batch = await hubSpotFetch("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS],
      inputs: dealIds.map((id) => ({ id })),
    }),
  });

  return (
    batch.results?.map((d) => ({
      id: d.id,
      properties: {
        ...(d.properties || {}),
        email,
      },
    })) || []
  );
}

async function getDealById(dealId) {
  const data = await hubSpotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=${encodeURIComponent(
      ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS].join(",")
    )}`
  );

  if (!data || !data.id) return null;
  return { id: data.id, properties: data.properties || {} };
}

/* =========================================================
   UI: Deal Selection
========================================================= */

function renderDealSelectionPage(deals, currentUrl, email) {
  const baseUrl = new URL(currentUrl);
  baseUrl.search = ""; // keep same function path

  const cards = deals
    .map((deal) => {
      const p = deal.properties || {};
      const name = p.dealname || "Program";

      const amount = safeNumber(p.amount);
      const amountStr = isNaN(amount)
        ? ""
        : `$${amount.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`;

      const link = new URL(baseUrl.toString());
      link.searchParams.set("dealId", deal.id);
      link.searchParams.set("email", email);

      return `
        <a href="${link.toString()}" class="program-card">
          <div class="program-name">${escapeHtml(name)}</div>
          ${amountStr ? `<div class="program-amount">Program tuition: ${amountStr}</div>` : ""}
          <div class="program-view">View payments →</div>
        </a>
      `;
    })
    .join("");

  return stripeStylePage(
    "Select a Program",
    `
      <div class="container">
        <h1>Select your program</h1>
        <p>More than one active program is associated with your account. Please choose which one you'd like to view.</p>
        <div class="program-grid">${cards}</div>
      </div>
    `
  );
}

/* =========================================================
   UI: Deal Portal
========================================================= */

function renderDealPortal(deal) {
  const p = deal.properties || {};
  const programName = p.dealname || "Your Program";

  const tuition = safeNumber(p.amount);
  const payments = parsePayments(p);

  const totalPaid =
    !isNaN(safeNumber(p.total_amount_paid))
      ? safeNumber(p.total_amount_paid)
      : payments.reduce((sum, pay) => sum + pay.amount, 0);

  const remaining =
    !isNaN(tuition) && !isNaN(totalPaid) ? tuition - totalPaid : NaN;

  const depositRemaining = Math.max(0, DEPOSIT_TARGET - totalPaid);

  const paymentRows =
    payments.length > 0
      ? payments
          .map(
            (pay) => `
            <tr>
              <td>${formatCurrency(pay.amount)}</td>
              <td>${escapeHtml(pay.date || "")}</td>
              <td class="mono">${escapeHtml(pay.txn || "")}</td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="3" class="empty-row">No payments have been recorded yet.</td></tr>`;

  const showAppFee = totalPaid === 0;
  const showDeposit = totalPaid > 0 && totalPaid < DEPOSIT_BUTTON_HIDE_AT_PAID;
  const showRemaining = !isNaN(remaining) && remaining > 0;

  const email = p.email || "";

  const body = `
    <div class="container">
      <div class="header-row">
        <div>
          <h1>${escapeHtml(programName)}</h1>
          <p class="subtitle">Payment overview for your program.</p>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card">
          <div class="label">Program Tuition</div>
          <div class="value">${formatCurrency(tuition)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Paid so far</div>
          <div class="value">${formatCurrency(totalPaid)}</div>
        </div>
        <div class="summary-card highlight">
          <div class="label">Remaining balance</div>
          <div class="value">${formatCurrency(remaining)}</div>
        </div>
      </div>

      <div class="payment-layout">
        <div class="actions">
          ${showAppFee ? renderPayBlock("Pay Application Fee", "appfee", APP_FEE, deal.id, email) : ""}
          ${showDeposit ? renderPayBlock("Pay Deposit", "deposit", depositRemaining, deal.id, email) : ""}
          ${showRemaining ? renderPayBlock("Pay Remaining Balance", "remaining", remaining, deal.id, email) : `<div class="paid-in-full">Your balance is fully paid.</div>`}
        </div>

        ${
          showRemaining
            ? `
          <div class="custom-card">
            <h3>Make a Payment</h3>
            <p class="sub">Minimum $250, up to your remaining balance.</p>

            <input id="customAmount" type="number" min="${APP_FEE}" max="${remaining}" step="0.01" placeholder="250.00" />
            <div id="customError" class="error"></div>
            <div id="customCalc" class="calc"></div>

            <button id="customPayBtn" disabled type="button">Make a Payment</button>
          </div>
        `
            : ""
        }
      </div>

      <!-- INFO CALLOUT DISCLAIMER -->
      <div class="payment-disclaimer info">
        <strong>Payment note:</strong>
        A 3.5% transaction fee is applied to all credit card payments.
        To pay by wire transfer or ACH without the transaction fee,
        <a href="https://www.pacificdiscovery.org/student/payment/pay-now/wire-transfer-payment" target="_blank" rel="noopener noreferrer">
          click here to view wire transfer payment instructions
        </a>.
      </div>

      <div class="section">
        <h2>Payment history</h2>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Amount</th>
                <th>Date</th>
                <th>Transaction ID</th>
              </tr>
            </thead>
            <tbody>${paymentRows}</tbody>
          </table>
        </div>
      </div>
    </div>

    ${showRemaining ? renderCustomPaymentScript(deal.id, email, remaining) : ""}
  `;

  return stripeStylePage("Payment Summary", body);
}

function renderPayBlock(label, type, amount, dealId, email) {
  const base = safeNumber(amount);
  const fee = base * CARD_FEE_RATE;
  const total = base + fee;

  const href = `?checkout=1&type=${encodeURIComponent(type)}&dealId=${encodeURIComponent(
    dealId
  )}&email=${encodeURIComponent(email)}`;

  return `
    <div class="pay-block">
      <a class="btn" href="${href}">
        ${escapeHtml(label)} (${formatCurrency(base)})
      </a>
      <div class="fee">
        Base ${formatCurrency(base)} | Fee ${formatCurrency(fee)} | <strong>Total ${formatCurrency(
    total
  )}</strong>
      </div>
    </div>
  `;
}

function renderCustomPaymentScript(dealId, email, remaining) {
  return `<script>
(function(){
  const MIN = ${APP_FEE};
  const MAX = ${Number(remaining)};
  const RATE = ${CARD_FEE_RATE};

  const input = document.getElementById('customAmount');
  const calc  = document.getElementById('customCalc');
  const err   = document.getElementById('customError');
  const btn   = document.getElementById('customPayBtn');

  function fmt(n){
    return '$' + n.toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2});
  }

  function setState(message, html, enabled){
    err.textContent = message || '';
    calc.innerHTML = html || '';
    btn.disabled = !enabled;
  }

  function validateAndRender(){
    const v = parseFloat(input.value);
    if (Number.isNaN(v)) return setState('Please enter an amount.', '', false);
    if (v < MIN) return setState('Minimum payment is $250.', '', false);
    if (v > MAX) return setState('Amount cannot exceed your remaining balance.', '', false);

    const fee = v * RATE;
    const total = v + fee;
    setState('', 'Base ' + fmt(v) + ' | Fee ' + fmt(fee) + ' | <strong>Total ' + fmt(total) + '</strong>', true);
  }

  input.addEventListener('input', validateAndRender);
  validateAndRender();

  btn.addEventListener('click', function(){
    const v = parseFloat(input.value);
    if (Number.isNaN(v) || v < MIN || v > MAX) return;

    const qs = new URLSearchParams();
    qs.set('checkout','1');
    qs.set('type','custom');
    qs.set('amount', v.toFixed(2));
    qs.set('dealId', '${String(dealId)}');
    qs.set('email', '${String(email || "")}');
    window.location.search = qs.toString();
  });
})();
</script>`;
}

/* =========================================================
   PAYMENT PARSING
========================================================= */

function parsePayments(p) {
  const payments = [];

  PAYMENT_FIELDS.forEach((key) => {
    const raw = p[key];
    if (!raw) return;

    // Expected: "amount, txnId, date"
    const parts = raw.split(",").map((s) => s.trim());
    if (!parts[0]) return;

    const amount = safeNumber(parts[0]);
    const txn = parts[1] || "";
    const date = parts[2] || "";

    if (!isNaN(amount)) payments.push({ amount, txn, date });
  });

  return payments;
}

/* =========================================================
   HTML SHELL + STYLES
========================================================= */

function stripeStylePage(title, innerHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
        "Segoe UI", sans-serif;
      color: #0f172a;
      background-color: #f8fafc;
    }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, #eff6ff, #f9fafb);
    }
    .container {
      max-width: 820px;
      margin: 40px auto;
      padding: 24px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12);
    }
    h1 {
      margin: 0 0 4px;
      font-size: 1.5rem;
      font-weight: 650;
      color: #0f172a;
    }
    h2 {
      font-size: 1.1rem;
      margin: 0 0 12px;
      font-weight: 650;
      color: #111827;
    }
    .subtitle {
      margin: 0 0 20px;
      color: #6b7280;
      font-size: 0.95rem;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 22px;
    }
    .summary-card {
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid #e5e7eb;
      background: linear-gradient(to bottom right, #ffffff, #f9fafb);
    }
    .summary-card.highlight {
      border-color: #4f46e5;
      background: radial-gradient(circle at top left, #eef2ff, #f9fafb);
    }
    .label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .value {
      font-size: 1.15rem;
      font-weight: 700;
      color: #111827;
    }

    .payment-layout {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 28px;
      align-items: start;
      margin-top: 8px;
    }
    @media (max-width: 900px) {
      .payment-layout {
        grid-template-columns: 1fr;
      }
    }

    .pay-block {
      margin-bottom: 18px;
    }
    .btn {
      display: inline-block;
      padding: 10px 18px;
      border-radius: 999px;
      background: #4f46e5;
      color: #fff;
      text-decoration: none;
      font-weight: 650;
      font-size: 0.95rem;
    }
    .fee {
      margin-top: 6px;
      font-size: 0.86rem;
      color: #4b5563;
    }

    .custom-card {
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 18px;
      background: #fafafa;
      position: sticky;
      top: 24px;
    }
    @media (max-width: 900px) {
      .custom-card {
        position: static;
      }
    }
    .custom-card h3 {
      margin: 0 0 6px;
      font-size: 1.05rem;
    }
    .custom-card .sub {
      margin: 0 0 10px;
      color: #6b7280;
      font-size: 0.9rem;
    }
    .custom-card input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #d1d5db;
      font-size: 1rem;
      outline: none;
    }
    .custom-card input:focus {
      border-color: #4f46e5;
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.14);
    }
    .custom-card button {
      margin-top: 10px;
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: none;
      background: #111827;
      color: #fff;
      font-weight: 650;
      cursor: pointer;
    }
    .custom-card button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .error {
      margin-top: 6px;
      font-size: 0.86rem;
      color: #b91c1c;
      min-height: 1.1em;
    }
    .calc {
      margin-top: 6px;
      font-size: 0.86rem;
      color: #374151;
      min-height: 1.1em;
    }

    /* Info callout */
    .payment-disclaimer.info {
      margin: 28px 0 20px;
      padding: 14px 16px;
      border-radius: 12px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e3a8a;
      font-size: 0.92rem;
      line-height: 1.45;
    }
    .payment-disclaimer.info a {
      color: #1d4ed8;
      font-weight: 650;
      text-decoration: underline;
    }

    .table-wrapper {
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      overflow: hidden;
      background: #ffffff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    thead {
      background: #f9fafb;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
    }
    th {
      font-weight: 650;
      color: #4b5563;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    tbody tr:last-child td {
      border-bottom: none;
    }
    .empty-row {
      text-align: center;
      color: #9ca3af;
      font-style: italic;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
        "Liberation Mono", "Courier New", monospace;
      font-size: 0.82rem;
    }

    /* Deal selection cards */
    .program-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      margin-top: 16px;
    }
    .program-card {
      display: block;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      background: #ffffff;
      text-decoration: none;
      color: inherit;
      transition: box-shadow 0.15s ease, transform 0.15s ease,
        border-color 0.15s ease;
    }
    .program-card:hover {
      transform: translateY(-1px);
      border-color: #4f46e5;
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.12);
    }
    .program-name {
      font-weight: 650;
      margin-bottom: 4px;
    }
    .program-amount {
      color: #6b7280;
      font-size: 0.92rem;
      margin-bottom: 8px;
    }
    .program-view {
      color: #4f46e5;
      font-weight: 650;
      font-size: 0.92rem;
    }

    .paid-in-full {
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      background: #f9fafb;
      color: #111827;
      font-weight: 650;
    }
  </style>
</head>
<body>
  ${innerHtml}
</body>
</html>`;
}

/* =========================================================
   SIMPLE PAGES + RESPONSES
========================================================= */

function basicPage(title, contentHtml) {
  return stripeStylePage(
    title,
    `<div class="container"><h1>${escapeHtml(title)}</h1>${contentHtml}</div>`
  );
}

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
}

function textResponse(statusCode, text) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: text,
  };
}

/* =========================================================
   UTILS
========================================================= */

function safeNumber(val) {
  if (val === null || val === undefined || val === "") return NaN;
  const num = Number(val);
  return isNaN(num) ? NaN : num;
}

function num(val) {
  const n = Number(val);
  return isNaN(n) ? NaN : n;
}

function formatCurrency(n) {
  if (isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
