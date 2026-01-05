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

      // Get base financials
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

      const remaining = programFee - totalPaid;

      // Deposit rules
      const depositTarget = 2500;
      const depositRemaining = Math.max(0, depositTarget - totalPaid);

      // Determine charge type
      const type = url.searchParams.get("type"); // remaining | deposit | appfee
      let baseAmount = 0;
      let description = "";

      if (type === "appfee") {
        baseAmount = 250;
        description = "Application Fee";
      } else if (type === "deposit") {
        baseAmount = depositRemaining;
        description = "Program Deposit";
      } else {
        baseAmount = remaining;
        description = "Remaining Program Balance";
      }

      if (isNaN(baseAmount) || baseAmount <= 0) {
        return textResponse(400, "No outstanding balance to pay.");
      }

      // Add 3.5% fee to ALL payments
      const feeAmount = baseAmount * 0.035;
      const totalWithFee = baseAmount + feeAmount;

      // Build cancel URL returning user to program payment page
      const baseUrl = new URL(event.rawUrl);
      baseUrl.search = "";
      const cancelUrl = new URL(baseUrl.toString());
      cancelUrl.searchParams.set("dealId", dealId);
      if (email) cancelUrl.searchParams.set("email", email);

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
                description: `${description} (includes 3.5% transaction fee)`,
              },
              unit_amount: Math.round(totalWithFee * 100),
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
          `<p>We found your contact but no payment records yet.</p>`
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
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
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

  const dealIds = assocData.results?.map((r) => r.toObjectId).filter(Boolean) || [];
  if (!dealIds.length) return [];

  const batch = await hubSpotFetch("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS],
      inputs: dealIds.map((id) => ({ id })),
    }),
  });

  return batch.results?.map((d) => ({
    id: d.id,
    properties: { ...d.properties, email: contactEmailGlobal },
  })) ?? [];
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
        ${amountStr ? `<div class="program-amount">Program fee: ${amountStr}</div>` : ""}
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

  const remaining = programFee - totalPaid;

  const depositTarget = 2500;
  const depositRemaining = Math.max(0, depositTarget - totalPaid);

  const shouldShowAppFeeBtn = totalPaid === 0;
  const shouldShowDepositBtn = totalPaid > 0 && totalPaid < 2250;

  function feeBlock(base) {
    const fee = base * 0.035;
    const total = base + fee;
    return `
      <div style="margin-top:6px; font-size:0.85rem; color:#555;">
        Base: ${formatCurrency(base)}<br>
        Fee (3.5%): ${formatCurrency(fee)}<br>
        <strong>Total: ${formatCurrency(total)}</strong>
      </div>
    `;
  }

  const paymentRows =
    payments.length
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

  return stripeStylePage(
    "Payment Summary",
    `
    <div class="container">
      <h1>${escapeHtml(programName)}</h1>

      <div class="summary-grid">
        <div class="summary-card"><div class="label">Program fee</div><div class="value">${formatCurrency(programFee)}</div></div>
        <div class="summary-card"><div class="label">Paid so far</div><div class="value">${formatCurrency(totalPaid)}</div></div>
        <div class="summary-card highlight"><div class="label">Remaining Balance</div><div class="value">${formatCurrency(remaining)}</div></div>
      </div>

      ${
        shouldShowAppFeeBtn
          ? `
      <div style="margin:20px 0;">
        <a href="?checkout=1&type=appfee&dealId=${deal.id}&email=${p.email}"
           style="background:#3b82f6;color:white;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600;">
          Pay Application Fee
        </a>
        ${feeBlock(250)}
      </div>`
          : ""
      }

      ${
        shouldShowDepositBtn
          ? `
      <div style="margin:20px 0;">
        <a href="?checkout=1&type=deposit&dealId=${deal.id}&email=${p.email}"
           style="background:#10b981;color:white;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600;">
          Pay Deposit (${formatCurrency(depositRemaining)})
        </a>
        ${feeBlock(depositRemaining)}
      </div>`
          : ""
      }

      <div style="margin:20px 0;">
        <a href="?checkout=1&type=remaining&dealId=${deal.id}&email=${p.email}"
           style="background:#4f46e5;color:white;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600;">
          Pay Remaining Balance
        </a>
        ${feeBlock(remaining)}
      </div>

      <div class="section">
        <h2>Payment History</h2>
        <div class="table-wrapper">
          <table><thead><tr><th>Amount</th><th>Date</th><th>Transaction</th></tr></thead><tbody>${paymentRows}</tbody></table>
        </div>
      </div>
    </div>
  `
  );
}

/* ---------------- Utilities ---------------- */

function stripeStylePage(title, content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>
<style>
body{font-family:sans-serif;background:#f3f4f6;margin:0;}
.container{max-width:720px;margin:40px auto;padding:24px;background:white;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,0.1);}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:24px;}
.summary-card{padding:14px;border:1px solid #e5e7eb;border-radius:12px;}
.summary-card.highlight{border-color:#4f46e5;}
.label{text-transform:uppercase;font-size:0.7rem;color:#6b7280;margin-bottom:4px;}
.value{font-size:1.2rem;font-weight:600;}
.table-wrapper{margin-top:20px;}
table{width:100%;border-collapse:collapse;font-size:0.9rem;}
th,td{padding:10px;border-bottom:1px solid #e5e7eb;}
.empty-row{text-align:center;color:#aaa;}
</style></head><body>${content}</body></html>`;
}

function safeNumber(val) {
  const num = Number(val);
  return isNaN(num) ? NaN : num;
}

function formatCurrency(num) {
  if (isNaN(num)) return "—";
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textResponse(code, text) {
  return { statusCode: code, headers: { "Content-Type": "text/plain" }, body: text };
}

function htmlResponse(code, html) {
  return { statusCode: code, headers: { "Content-Type": "text/html" }, body: html };
}
