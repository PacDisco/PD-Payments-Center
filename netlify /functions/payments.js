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
        "HubSpot token not configured. Please set HUBSPOT_PRIVATE_APP_TOKEN in Netlify."
      );
    }

    // ---------- STRIPE CHECKOUT BRANCH ----------
    // When ?checkout=1 is present, create a Stripe Checkout Session
    if (checkout === "1") {
      if (!process.env.STRIPE_SECRET_KEY) {
        return textResponse(
          500,
          "Stripe is not configured. Please set STRIPE_SECRET_KEY in Netlify."
        );
      }

      if (!dealId) {
        return textResponse(400, "Missing dealId for checkout.");
      }

      // Get the deal so we can re-calculate the remaining balance securely
      const deal = await getDealById(dealId);
      if (!deal) {
        return textResponse(404, "Could not find that program / deal for checkout.");
      }

      const p = deal.properties || {};
      const programName = p.dealname || "Program payment";

      const programFee = safeNumber(p.amount);
      const totalPaidFromField = safeNumber(p.total_amount_paid);

      // Parse individual payment fields as fallback for total paid
      const payments = [];
      PAYMENT_FIELDS.forEach((key) => {
        const raw = p[key];
        if (!raw) return;
        const parts = raw.split(",").map((s) => s.trim());
        if (!parts[0]) return;
        const amt = safeNumber(parts[0]);
        if (!isNaN(amt)) {
          payments.push({ amount: amt });
        }
      });

      const totalPaid = !isNaN(totalPaidFromField)
        ? totalPaidFromField
        : payments.reduce((sum, pay) => sum + pay.amount, 0);

      const remaining =
        !isNaN(programFee) && !isNaN(totalPaid) ? programFee - totalPaid : NaN;

      if (isNaN(remaining) || remaining <= 0) {
        return textResponse(
          400,
          "There is no outstanding balance to pay for this program."
        );
      }

      // 3.5% card transaction fee
      const fee = remaining * 0.035;
      const totalWithFee = remaining + fee;

      // Build cancel URL that returns user to the same program payment page
      const baseUrl = new URL(event.rawUrl);
      baseUrl.search = ""; // clear existing query
      const cancelUrl = new URL(baseUrl.toString());
      cancelUrl.searchParams.set("dealId", dealId);
      if (email) cancelUrl.searchParams.set("email", email);

      // Create Stripe Checkout Session (USD, live key from STRIPE_SECRET_KEY)
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: email || undefined,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: programName,
                description: "Program payment including card transaction fee (3.5%)",
              },
              unit_amount: Math.round(totalWithFee * 100), // cents
            },
            quantity: 1,
          },
        ],
        success_url:
          "https://pacificdiscovery.org/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: cancelUrl.toString(),
      });

      return {
        statusCode: 302,
        headers: {
          Location: session.url,
        },
        body: "",
      };
    }
    // ---------- END STRIPE CHECKOUT BRANCH ----------

    // If dealId is present → render the payment portal for that deal
    if (dealId) {
      const deal = await getDealById(dealId);
      if (!deal) {
        return textResponse(404, "Could not find that program / deal.");
      }

      deal.properties.email = email;

      const html = renderDealPortal(deal);
      return htmlResponse(200, html);
    }

    // Otherwise we expect an email
    if (!email) {
      return htmlResponse(
        400,
        basicPage(
          "Missing email",
          `<p>Please access this page via the portal form so we know which account to look up.</p>`
        )
      );
    }

    // 1) Find contact by email
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

    // 2) Get deals associated with that contact
    const deals = await getDealsForContact(contact.id);

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
      const deal = deals[0];
      deal.properties.email = email;

      const html = renderDealPortal(deal);
      return htmlResponse(200, html);
    }

    // Multiple deals → show selection page
    const selectionHtml = renderDealSelectionPage(deals, url);
    return htmlResponse(200, selectionHtml);
  } catch (err) {
    console.error(err);
    return textResponse(500, "Unexpected error");
  }
};

/* ----------------- HubSpot helpers ----------------- */

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
    const body = await res.text();
    console.error("HubSpot error:", res.status, body);
    throw new Error(`HubSpot API error: ${res.status}`);
  }
  return res.json();
}

async function findContactByEmail(email) {
  const body = {
    filterGroups: [
      {
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      },
    ],
    properties: ["email", "firstname", "lastname"],
    limit: 1,
  };

  const data = await hubSpotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!data.results || data.results.length === 0) return null;

  const contact = data.results[0];
  return { id: contact.id, properties: contact.properties || {} };
}

async function getDealsForContact(contactId) {
  const assocData = await hubSpotFetch(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`
  );

  const dealIds =
    assocData.results?.map((r) => r.toObjectId).filter(Boolean) || [];

  if (dealIds.length === 0) return [];

  const body = {
    properties: [
      "dealname",
      "amount",
      "total_amount_paid",
      ...PAYMENT_FIELDS,
    ],
    inputs: dealIds.map((id) => ({ id })),
  };

  const batch = await hubSpotFetch("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return (
    batch.results?.map((d) => ({
      id: d.id,
      properties: {
        ...d.properties,
        email: contactEmailGlobal,
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

/* ----------------- Back Button Renderer ----------------- */

function renderBackLink() {
  return `
    <div style="margin-bottom:16px;">
      <a href="javascript:window.history.back()" 
         style="color:#4f46e5; font-size:0.9rem; text-decoration:none;">
         ← Back
      </a>
    </div>
  `;
}

/* ----------------- Rendering: Deal Selection ----------------- */

function renderDealSelectionPage(deals, currentUrl) {
  const baseUrl = new URL(currentUrl);
  baseUrl.search = "";

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
      link.searchParams.set("email", p.email || "");

      return `
      <a href="${link.toString()}" class="program-card">
        <div class="program-name">${escapeHtml(name)}</div>
        ${
          amountStr
            ? `<div class="program-amount">Program fee: ${amountStr}</div>`
            : ""
        }
        <div class="program-view">View payments →</div>
      </a>`;
    })
    .join("");

  return stripeStylePage(
    "Select a Program",
    `
    <div class="container">
      ${renderBackLink()}

      <h1>Select your program</h1>
      <p>More than one active program is associated with your account. Please choose which one you'd like to view.</p>

      <div class="program-grid">${cards}</div>
    </div>
  `
  );
}

/* ----------------- Rendering: Payment Summary ----------------- */

function renderDealPortal(deal) {
  const p = deal.properties || {};
  const programName = p.dealname || "Your Program";

  const programFee = safeNumber(p.amount);
  const totalPaidFromField = safeNumber(p.total_amount_paid);

  const payments = [];

  PAYMENT_FIELDS.forEach((key) => {
    const raw = p[key];
    if (!raw) return;

    const parts = raw.split(",").map((s) => s.trim());
    if (!parts[0]) return;

    const amount = safeNumber(parts[0]);
    const txn = parts[1] || "";
    const date = parts[2] || "";

    if (!isNaN(amount)) payments.push({ amount, txn, date });
  });

  const totalPaid = !isNaN(totalPaidFromField)
    ? totalPaidFromField
    : payments.reduce((sum, pay) => sum + pay.amount, 0);

  const remaining =
    !isNaN(programFee) && !isNaN(totalPaid) ? programFee - totalPaid : NaN;

  const fee =
    !isNaN(remaining) && remaining > 0 ? remaining * 0.035 : NaN;
  const totalWithFee =
    !isNaN(remaining) && !isNaN(fee) ? remaining + fee : NaN;

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

  const shouldShowPayButton =
    !isNaN(remaining) && remaining > 0.01 && !isNaN(totalWithFee);

  const body = `
    <div class="container">

      ${renderBackLink()}

      <h1>${escapeHtml(programName)}</h1>
      <p class="subtitle">Payment overview for your program.</p>

      <div class="summary-grid">
        <div class="summary-card">
          <div class="label">Program fee</div>
          <div class="value">${formatCurrency(programFee)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Paid so far</div>
          <div class="value">${formatCurrency(totalPaid)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Remaining balance</div>
          <div class="value">${formatCurrency(remaining)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Card transaction fee (3.5%)</div>
          <div class="value">${formatCurrency(fee)}</div>
        </div>
        <div class="summary-card highlight">
          <div class="label">Total to pay by card</div>
          <div class="value">${formatCurrency(totalWithFee)}</div>
        </div>
      </div>

      ${
        shouldShowPayButton
          ? `
      <!-- PAY BALANCE BUTTON VIA STRIPE -->
      <div style="margin: 20px 0 28px;">
        <a 
          href="?checkout=1&dealId=${encodeURIComponent(
            deal.id
          )}&email=${encodeURIComponent(p.email || "")}"
          style="
            display:inline-block;
            padding:12px 20px;
            background:#4f46e5;
            color:white;
            text-decoration:none;
            border-radius:8px;
            font-weight:600;
            font-size:0.95rem;
          "
        >
          Pay Remaining Balance (with 3.5% card fee)
        </a>
      </div>`
          : `
      <div style="margin: 20px 0 28px; color:#16a34a; font-weight:500;">
        Your balance is fully paid. No further payment is due.
      </div>`
      }

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
  `;

  return stripeStylePage("Payment Summary", body);
}

/* ----------------- HTML Shell ----------------- */

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
      max-width: 720px;
      margin: 40px auto;
      padding: 24px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12);
    }
    a {
      cursor: pointer;
    }

    h1 {
      margin: 0 0 4px;
      font-size: 1.5rem;
      font-weight: 600;
      color: #0f172a;
    }
    h2 {
      font-size: 1.1rem;
      margin: 0 0 12px;
      font-weight: 600;
      color: #111827;
    }
    .subtitle {
      margin: 0 0 20px;
      color: #6b7280;
      font-size: 0.9rem;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }

    .summary-card {
      padding: 14px 16px;
      border-radius: 12px;
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
      font-size: 1.1rem;
      font-weight: 600;
      color: #111827;
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
      font-weight: 500;
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
      font-size: 0.8rem;
    }

    .program-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
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

    @media (max-width: 640px) {
      .container {
        margin: 16px;
        padding: 18px;
      }
    }
  </style>
</head>
<body>
  ${innerHtml}
</body>
</html>`;
}

/* ----------------- Utils ----------------- */

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

function safeNumber(val) {
  if (val === null || val === undefined || val === "") return NaN;
  const num = Number(val);
  return isNaN(num) ? NaN : num;
}

function formatCurrency(num) {
  if (isNaN(num)) return "—";
  return `$${num.toLocaleString("en-US", {
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
