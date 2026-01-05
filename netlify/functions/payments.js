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

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const email = url.searchParams.get("email");
    const dealId = url.searchParams.get("dealId");
    const checkout = url.searchParams.get("checkout");

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

      const programFee = num(p.amount);
      const payments = parsePayments(p);
      const totalPaid =
        !isNaN(num(p.total_amount_paid))
          ? num(p.total_amount_paid)
          : payments.reduce((s, p) => s + p.amount, 0);

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
        const amt = num(url.searchParams.get("amount"));
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
      const total = baseAmount + fee;

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

    /* ---------- PAGE ---------- */
    if (!dealId) return textResponse(400, "Missing dealId.");

    const deal = await getDealById(dealId);
    deal.properties.email = email;

    return htmlResponse(200, renderDealPortal(deal));
  } catch (err) {
    console.error(err);
    return textResponse(500, "Unexpected error.");
  }
};

/* ================= HUBSPOT ================= */

async function hubSpotFetch(path, options = {}) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("HubSpot error:", body);
    throw new Error("HubSpot error");
  }

  return res.json();
}

async function getDealById(dealId) {
  const data = await hubSpotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=${encodeURIComponent(
      ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS].join(",")
    )}`
  );

  return { id: data.id, properties: data.properties || {} };
}

/* ================= UI ================= */

function renderDealPortal(deal) {
  const p = deal.properties;
  const payments = parsePayments(p);
  const programFee = num(p.amount);
  const totalPaid =
    !isNaN(num(p.total_amount_paid))
      ? num(p.total_amount_paid)
      : payments.reduce((s, p) => s + p.amount, 0);

  const remaining = programFee - totalPaid;
  const depositTarget = 2500;
  const depositRemaining = Math.max(0, depositTarget - totalPaid);

  const rows =
    payments.length > 0
      ? payments
          .map(
            (p) => `
<tr>
  <td>${money(p.amount)}</td>
  <td>${escape(p.date || "")}</td>
  <td>${escape(p.txn || "")}</td>
</tr>`
          )
          .join("")
      : `<tr><td colspan="3" class="empty-row">No payments recorded yet.</td></tr>`;

  return page(`
<h1>${escape(p.dealname || "Program")}</h1>

<div class="summary-grid">
  <div class="summary-card"><div class="label">Program Tuition</div><div class="value">${money(programFee)}</div></div>
  <div class="summary-card"><div class="label">Paid So Far</div><div class="value">${money(totalPaid)}</div></div>
  <div class="summary-card highlight"><div class="label">Remaining Balance</div><div class="value">${money(remaining)}</div></div>
</div>

<div class="payment-disclaimer">
  <em>
    A 3.5% transaction fee is applied to all credit card payments.
    To pay by wire transfer or ACH without the transaction fee,
    <a href="https://www.pacificdiscovery.org/student/payment/pay-now/wire-transfer-payment" target="_blank">
      click here to view wire transfer payment instructions
    </a>.
  </em>
</div>

<h2>Payment History</h2>
<table>
<thead><tr><th>Amount</th><th>Date</th><th>Transaction ID</th></tr></thead>
<tbody>${rows}</tbody>
</table>
`);
}

/* ================= HELPERS ================= */

function parsePayments(p) {
  const payments = [];
  PAYMENT_FIELDS.forEach((k) => {
    if (!p[k]) return;
    const [amount, txn, date] = p[k].split(",").map((s) => s.trim());
    const a = num(amount);
    if (!isNaN(a)) payments.push({ amount: a, txn, date });
  });
  return payments;
}

function num(v) {
  const n = Number(v);
  return isNaN(n) ? NaN : n;
}

function money(v) {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2 });
}

function escape(s) {
  return String(s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function page(body) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<style>
body{font-family:system-ui;background:#f3f4f6;margin:0}
.container{max-width:760px;margin:40px auto;padding:24px;background:#fff;border-radius:16px}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.summary-card{border:1px solid #e5e7eb;border-radius:12px;padding:14px}
.summary-card.highlight{border-color:#4f46e5}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{padding:10px;border-bottom:1px solid #e5e7eb;text-align:left}
th{background:#f9fafb;font-size:.8rem}
.empty-row{text-align:center;color:#9ca3af}
.payment-disclaimer{margin:24px 0 12px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:.85rem;color:#4b5563}
</style>
</head>
<body>
<div class="container">${body}</div>
</body>
</html>`;
}

function textResponse(code, msg) {
  return { statusCode: code, body: msg };
}
function htmlResponse(code, html) {
  return { statusCode: code, headers: { "Content-Type": "text/html" }, body: html };
}
