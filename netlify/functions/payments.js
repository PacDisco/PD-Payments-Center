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

      // Get deal
      const deal = await getDealById(dealId);
      if (!deal) return textResponse(404, "Deal not found.");

      const p = deal.properties || {};
      const programName = p.dealname || "Program payment";

      // Base financials
      const programFee = safeNumber(p.amount);
      const totalPaidFromField = safeNumber(p.total_amount_paid);

      const payments = [];
      PAYMENT_FIELDS.forEach((key) => {
        const raw = p[key];
        if (!raw) return;
        const parts = raw.split(",").map((s) => s.trim());
        const amt = safeNumber(parts[0]);
        if (!isNaN(amt)) payments.push({ amount: amt });
      });

      const totalPaid = !isNaN(totalPaidFromField)
        ? totalPaidFromField
        : payments.reduce((sum, pay) => sum + pay.amount, 0);

      const remaining =
        !isNaN(programFee) && !isNaN(totalPaid) ? programFee - totalPaid : NaN;

      if (isNaN(remaining)) {
        return textResponse(
          400,
          "Unable to determine remaining balance for this program."
        );
      }

      const depositTarget = 2500;
      const depositRemaining = Math.max(0, depositTarget - totalPaid);

      // Determine payment type
      const type = url.searchParams.get("type") || "remaining"; // remaining | deposit | appfee | custom
      let baseAmount = 0;
      let descriptionLabel = "";

      if (type === "appfee") {
        baseAmount = 250;
        descriptionLabel = "Application Fee";
      } else if (type === "deposit") {
        baseAmount = depositRemaining;
        descriptionLabel = "Program Deposit";
      } else if (type === "custom") {
        const customRaw = url.searchParams.get("amount");
        const customAmount = safeNumber(customRaw);
        if (isNaN(customAmount)) {
          return textResponse(400, "Invalid custom payment amount.");
        }
        if (customAmount < 250) {
          return textResponse(
            400,
            "Minimum custom payment amount is $250 USD."
          );
        }
        if (customAmount - remaining > 0.01) {
          return textResponse(
            400,
            "Custom payment amount cannot exceed remaining balance."
          );
        }
        baseAmount = customAmount;
        descriptionLabel = "Custom Payment";
      } else {
        // Remaining balance
        baseAmount = remaining;
        descriptionLabel = "Remaining Program Balance";
      }

      if (isNaN(baseAmount) || baseAmount <= 0) {
        return textResponse(400, "There is no outstanding balance to pay.");
      }

      // 3.5% fee for ALL payments
      const feeAmount = baseAmount * 0.035;
      const totalWithFee = baseAmount + feeAmount;

      // Build cancel URL returning user to program payment page
      const baseUrl = new URL(event.rawUrl);
      baseUrl.search = "";
      const cancelUrl = new URL(baseUrl.toString());
      cancelUrl.searchParams.set("dealId", dealId);
      if (email) cancelUrl.searchParams.set("email", email);

      const description = `${descriptionLabel} – Deal ID: ${dealId}`;

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
                description,
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
          dealId: String(dealId),
          paymentType: type,
        },
      });

      return {
        statusCode: 302,
        headers: { Location: session.url },
        body: "",
      };
    }
    // ---------- END STRIPE CHECKOUT BRANCH ----------

    // If dealId is present → render page
    if (dealId) {
      const deal = await getDealById(dealId);
      if (!deal) return textResponse(404, "Could not find that program / deal.");
      deal.properties.email = email;

      const html = renderDealPortal(deal);
      return htmlResponse(200, html);
    }

    // If email missing
    if (!email) {
      return htmlResponse(
        400,
        basicPage(
          "Missing email",
          `<p>Please access this page via the portal form so we know which account to look up.</p>`
        )
      );
    }

    // Find contact
    const contact = await findContactByEmail(email);
    if (!contact) {
      return htmlResponse(
        404,
        basicPage(
          "No account found",
          `<p>No records for <strong>${escapeHtml(email)}</strong>.</p>`
        )
      );
    }

    // Get deals
    const deals = await getDealsForContact(contact.id);
    if (!deals || deals.length === 0) {
      return htmlResponse(
        404,
        basicPage(
          "No programs found",
          `<p>We found your contact but no program payment records yet.</p>`
        )
      );
    }

    // Single deal
    if (deals.length === 1) {
      const deal = deals[0];
      deal.properties.email = email;
      return htmlResponse(200, renderDealPortal(deal));
    }

    // Multiple deals → selection page
    return htmlResponse(200, renderDealSelectionPage(deals, url));
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
  const data = await hubSpotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }],
        },
      ],
      properties: ["email", "firstname", "lastname"],
      limit: 1,
    }),
  });

  if (!data.results?.length) return null;

  return { id: data.results[0].id, properties: data.results[0].properties };
}

async function getDealsForContact(contactId) {
  const assocData = await hubSpotFetch(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`
  );

  const dealIds =
    assocData.results?.map((r) => r.toObjectId).filter(Boolean) || [];
  if (!dealIds.length) return [];

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
      properties: { ...d.properties, email: contactEmailGlobal },
    })) ?? []
  );
}

async function getDealById(dealId) {
  const data = await hubSpotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=${encodeURIComponent(
      ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS].join(",")
    )}`
  );

  if (!data?.id) return null;

  return { id: data.id, properties: data.properties };
}

/* ---------------- Rendering ---------------- */

function renderDealSelectionPage(deals, currentUrl) {
  const baseUrl = new URL(currentUrl);
  baseUrl.search = "";

  const cards = deals
    .map((deal) => {
      const p = deal.properties;
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
            ? `<div class="program-amount">Program tuition: ${amountStr}</div>`
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
      <h1>Select your program</h1>
      <p>Please choose the program you'd like to view payments for.</p>
      <div class="program-grid">${cards}</div>
    </div>
  `
  );
}

function renderDealPortal(deal) {
  const p = deal.properties;
  const programName = p.dealname || "Your Program";

  const programFee = safeNumber(p.amount);
  const totalPaidFromField = safeNumber(p.total_amount_paid);

  const payments = [];
  PAYMENT_FIELDS.forEach((key) => {
    const raw = p[key];
    if (!raw) return;
    const parts = raw.split(",").map((s) => s.trim());
    const amt = safeNumber(parts[0]);
    if (!isNaN(amt)) {
      payments.push({ amount: amt, date: parts[2], txn: parts[1] });
    }
  });

  const totalPaid = !isNaN(totalPaidFromField)
    ? totalPaidFromField
    : payments.reduce((s, p) => s + p.amount, 0);

  const remaining =
    !isNaN(programFee) && !isNaN(totalPaid) ? programFee - totalPaid : NaN;

  const depositTarget = 2500;
  const depositRemaining = Math.max(0, depositTarget - totalPaid);

  const shouldShowAppFeeBtn = totalPaid === 0;
  const shouldShowDepositBtn = totalPaid > 0 && totalPaid < 2250;
  const hasRemaining = !isNaN(remaining) && remaining > 0;

  function feeBlock(base) {
    if (isNaN(base) || base <= 0) return "";
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

  const paymentRows =
    payments.length > 0
      ? payments
          .map(
            (pay) => `
      <tr>
        <td>${formatCurrency(pay.amount)}</td>
        <td>${escapeHtml(pay.date || "")}</td>
        <td>${escapeHtml(pay.txn || "")}</td>
      </tr>`
          )
          .join("")
      : `<tr><td colspan="3" class="empty-row">No payments yet.</td></tr>`;

  const encodedDealId = encodeURIComponent(deal.id);
  const encodedEmail = encodeURIComponent(p.email || "");

  const content = `
    <div class="container">
      <h1>${escapeHtml(programName)}</h1>

      <div class="summary-grid">
        <div class="summary-card">
          <div class="label">Program Tuition</div>
          <div class="value">${formatCurrency(programFee)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Paid so far</div>
          <div class="value">${formatCurrency(totalPaid)}</div>
        </div>
        <div class="summary-card highlight">
          <div class="label">Remaining Balance</div>
          <div class="value">${formatCurrency(remaining)}</div>
        </div>
      </div>

      ${
        shouldShowAppFeeBtn
          ? `
      <div class="button-block">
        <a href="?checkout=1&type=appfee&dealId=${encodedDealId}&email=${encodedEmail}"
           class="btn btn-blue">
          Pay Application Fee
        </a>
        ${feeBlock(250)}
      </div>`
          : ""
      }

      ${
        shouldShowDepositBtn && hasRemaining
          ? `
      <div class="button-block">
        <a href="?checkout=1&type=deposit&dealId=${encodedDealId}&email=${encodedEmail}"
           class="btn btn-green">
          Pay Deposit (${formatCurrency(depositRemaining)})
        </a>
        ${feeBlock(depositRemaining)}
      </div>`
          : ""
      }

      ${
        hasRemaining
          ? `
      <div class="button-block">
        <a href="?checkout=1&type=remaining&dealId=${encodedDealId}&email=${encodedEmail}"
           class="btn btn-purple">
          Pay Remaining Balance
        </a>
        ${feeBlock(remaining)}
      </div>`
          : `
      <div class="button-block">
        <div class="paid-message">
          Your balance is fully paid. No further payment is due.
        </div>
      </div>`
      }

      ${
        hasRemaining
          ? `
      <div class="custom-payment-wrapper">
        <div class="custom-payment-card" id="custom-payment-section"
             data-remaining="${remaining.toFixed(2)}">

          <h3 class="custom-title">Make a Payment</h3>
          <p class="custom-description">
            Choose an amount to pay toward your remaining balance.<br>
            Minimum $250, up to your remaining balance.
          </p>

          <form id="custom-payment-form">
            <label for="custom-amount">Amount in USD</label>
            <input 
              id="custom-amount" 
              name="amount" 
              type="number" 
              step="0.01" 
              min="250"
              max="${remaining.toFixed(2)}"
              placeholder="250.00" 
              required
            />
            <button type="submit" class="btn btn-dark small-btn">
              Make a Payment
            </button>
          </form>

          <div id="custom-fee-summary" class="fee-breakdown small"></div>
          <div id="custom-error" class="error-message"></div>

        </div>
      </div>
      `
          : ""
      }

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
            <tbody>${paymentRows}</tbody>
          </table>
        </div>
      </div>
    </div>

    ${
      hasRemaining
        ? `<script>
    (function() {
      const section = document.getElementById('custom-payment-section');
      if (!section) return;
      const remaining = parseFloat(section.dataset.remaining || '0') || 0;
      const form = document.getElementById('custom-payment-form');
      const input = document.getElementById('custom-amount');
      const feeSummary = document.getElementById('custom-fee-summary');
      const errorEl = document.getElementById('custom-error');

      function formatCurrency(num) {
        if (isNaN(num)) return '—';
        return '$' + num.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
      }

      function updateSummary() {
        const val = parseFloat(input.value || '0');
        errorEl.textContent = '';
        if (isNaN(val) || val <= 0) {
          feeSummary.textContent = '';
          return;
        }
        const base = val;
        const fee = base * 0.035;
        const total = base + fee;
        feeSummary.innerHTML =
          '<div>Base: ' + formatCurrency(base) + '</div>' +
          '<div>Fee (3.5%): ' + formatCurrency(fee) + '</div>' +
          '<div><strong>Total: ' + formatCurrency(total) + '</strong></div>';
      }

      input.addEventListener('input', updateSummary);

      form.addEventListener('submit', function(e) {
        e.preventDefault();
        errorEl.textContent = '';
        const val = parseFloat(input.value || '0');

        if (isNaN(val)) {
          errorEl.textContent = 'Please enter a valid amount.';
          return;
        }
        if (val < 250) {
          errorEl.textContent = 'Minimum payment is $250 USD.';
          return;
        }
        if (val - remaining > 0.01) {
          errorEl.textContent = 'Amount cannot exceed remaining balance.';
          return;
        }

        const params = new URLSearchParams(window.location.search);
        params.set('checkout', '1');
        params.set('type', 'custom');
        params.set('amount', val.toFixed(2));
        window.location.search = params.toString();
      });

      updateSummary();
    })();
    </script>`
        : ""
    }
  `;

  return stripeStylePage("Payment Summary", content);
}

/* ---------------- Utilities ---------------- */

function stripeStylePage(title, content) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
        "Segoe UI", sans-serif;
      background:#f3f4f6;
      margin:0;
    }
    .container {
      max-width: 720px;
      margin: 40px auto;
      padding: 24px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 18px 45px rgba(15,23,42,0.12);
    }
    h1 { margin: 0 0 12px; font-size: 1.6rem; }
    h2 { margin-top: 24px; margin-bottom: 8px; font-size: 1.1rem; }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .summary-card {
      padding: 14px;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      background: #fff;
    }
    .summary-card.highlight {
      border-color:#4f46e5;
      background: radial-gradient(circle at top left, #eef2ff, #f9fafb);
    }
    .label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color:#6b7280;
      margin-bottom: 4px;
    }
    .value {
      font-size: 1.1rem;
      font-weight: 600;
      color:#111827;
    }

    .button-block { margin: 18px 0; }
    .btn {
      display:inline-block;
      padding: 10px 18px;
      border-radius: 999px;
      text-decoration:none;
      font-weight:600;
      font-size:0.95rem;
      border:none;
      cursor:pointer;
    }
    .btn-blue { background:#3b82f6; color:white; }
    .btn-green { background:#10b981; color:white; }
    .btn-purple { background:#4f46e5; color:white; }
    .btn-dark { background:#111827; color:white; }
    .small-btn { padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; }

    .fee-breakdown {
      margin-top: 6px;
      font-size: 0.85rem;
      color:#4b5563;
      line-height:1.4;
    }
    .fee-breakdown.small { font-size:0.8rem; }

    .section { margin-top: 24px; }

    .table-wrapper {
      margin-top: 10px;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      overflow: hidden;
      background:#fff;
    }
    table { width:100%; border-collapse: collapse; font-size:0.9rem; }
    th, td {
      padding: 10px 12px;
      border-bottom:1px solid #e5e7eb;
      text-align:left;
    }
    th {
      background:#f9fafb;
      font-size:0.8rem;
      text-transform:uppercase;
      letter-spacing:0.06em;
      color:#4b5563;
    }
    .empty-row { text-align:center; color:#9ca3af; font-style:italic; }

    .program-grid {
      display:grid;
      grid-template-columns:1fr;
      gap:12px;
    }
    .program-card {
      display:block;
      padding:14px 16px;
      border-radius:12px;
      border:1px solid #e5e7eb;
      background:#fff;
      text-decoration:none;
      color:inherit;
      transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
    }
    .program-card:hover {
      transform: translateY(-1px);
      border-color:#4f46e5;
      box-shadow:0 12px 24px rgba(15,23,42,0.12);
    }

    label {
      display:block;
      font-size:0.9rem;
      margin-bottom:4px;
      color:#374151;
    }
    input[type="number"] {
      width:100%;
      padding:8px 10px;
      border-radius:8px;
      border:1px solid #d1d5db;
      font-size:0.95rem;
      box-sizing:border-box;
      margin-bottom:8px;
    }
    input[type="number"]:focus {
      outline:none;
      border-color:#4f46e5;
      box-shadow:0 0 0 1px #4f46e5;
    }
    .error-message {
      color:#b91c1c;
      font-size:0.8rem;
      margin-top:4px;
    }
    .paid-message {
      font-size:0.95rem;
      color:#16a34a;
      font-weight:500;
    }

    /* Right-side custom payment block */
    .custom-payment-wrapper {
      display: flex;
      justify-content: flex-end;
      margin-top: 30px;
    }

    .custom-payment-card {
      width: 280px;
      padding: 18px;
      border-radius: 14px;
      border: 1px solid #e5e7eb;
      background: #fafafa;
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
    }

    .custom-title {
      margin: 0 0 8px 0;
      font-size: 1.05rem;
      font-weight: 600;
    }

    .custom-description {
      margin: 0 0 14px 0;
      font-size: 0.85rem;
      color: #4b5563;
    }

    /* Responsive: full-width on mobile */
    @media (max-width: 768px) {
      .container {
        margin:16px;
        padding:18px;
      }

      .custom-payment-wrapper {
        justify-content: center;
      }

      .custom-payment-card {
        width: 100%;
      }
    }
  </style>
</head>
<body>
${content}
</body>
</html>`;
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

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textResponse(code, text) {
  return {
    statusCode: code,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: text,
  };
}

function htmlResponse(code, html) {
  return {
    statusCode: code,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
}

function basicPage(title, contentHtml) {
  return stripeStylePage(
    title,
    `<div class="container"><h1>${escapeHtml(title)}</h1>${contentHtml}</div>`
  );
}
