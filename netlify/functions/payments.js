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

    /* ================= STRIPE CHECKOUT ================= */
    if (checkout === "1") {
      if (!process.env.STRIPE_SECRET_KEY) {
        return textResponse(500, "Stripe key missing.");
      }
      if (!dealId) return textResponse(400, "Missing dealId.");

      const deal = await getDealById(dealId);
      if (!deal) return textResponse(404, "Deal not found.");

      const p = deal.properties;
      const programName = p.dealname || "Program Payment";

      const payments = parsePayments(p);
      const programFee = num(p.amount);
      const totalPaid =
        !isNaN(num(p.total_amount_paid))
          ? num(p.total_amount_paid)
          : payments.reduce((s, p) => s + p.amount, 0);

      const remaining = programFee - totalPaid;
      const depositTarget = 2500;
      const depositRemaining = Math.max(0, depositTarget - totalPaid);

      const type = url.searchParams.get("type");
      let base = 0;
      let label = "";

      if (type === "appfee") {
        base = 250;
        label = "Application Fee";
      } else if (type === "deposit") {
        base = depositRemaining;
        label = "Program Deposit";
      } else if (type === "custom") {
        const amt = num(url.searchParams.get("amount"));
        if (amt < 250 || amt > remaining) {
          return textResponse(400, "Invalid custom amount.");
        }
        base = amt;
        label = "Custom Payment";
      } else {
        base = remaining;
        label = "Remaining Program Balance";
      }

      if (base <= 0) return textResponse(400, "No balance due.");

      const fee = base * 0.035;
      const total = base + fee;

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

    /* ================= PAGE ================= */
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

async function hubSpotFetch(path) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
    },
  });

  if (!res.ok) throw new Error("HubSpot API error");
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
  const tuition = num(p.amount);
  const totalPaid =
    !isNaN(num(p.total_amount_paid))
      ? num(p.total_amount_paid)
      : payments.reduce((s, p) => s + p.amount, 0);

  const remaining = tuition - totalPaid;
  const depositRemaining = Math.max(0, 2500 - totalPaid);

  const rows =
    payments.length
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
  <div class="summary-card"><div class="label">Program Tuition</div><div class="value">${money(tuition)}</div></div>
  <div class="summary-card"><div class="label">Paid So Far</div><div class="value">${money(totalPaid)}</div></div>
  <div class="summary-card highlight"><div class="label">Remaining Balance</div><div class="value">${money(remaining)}</div></div>
</div>

<div class="payment-columns">
  <div>
    ${totalPaid === 0 ? paymentButton(deal.id, "Pay Application Fee", "appfee", 250) : ""}
    ${totalPaid > 0 && totalPaid < 2250 ? paymentButton(deal.id, "Pay Deposit", "deposit", depositRemaining) : ""}
    ${remaining > 0 ? paymentButton(deal.id, "Pay Remaining Balance", "remaining", remaining) : "<strong>Paid in full</strong>"}
  </div>

  ${
    remaining > 0
      ? `
  <div class="custom-card">
    <h3>Make a Payment</h3>
    <input id="amt" type="number" min="250" max="${remaining}" step="0.01">
    <button onclick="customPay()">Pay</button>
  </div>`
      : ""
  }
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

<script>
function customPay(){
  const v=parseFloat(document.getElementById('amt').value);
  if(v<250) return alert('Minimum $250');
  const p=new URLSearchParams(location.search);
  p.set('checkout','1');p.set('type','custom');p.set('amount',v.toFixed(2));
  location.search=p.toString();
}
</script>
`);
}

/* ================= HELPERS ================= */

function paymentButton(dealId, label, type, amt) {
  const fee = amt * 0.035;
  return `
<div class="pay-block">
  <a class="btn" href="?checkout=1&type=${type}&dealId=${dealId}">
    ${label} (${money(amt)})
  </a>
  <div class="fee">Base ${money(amt)} | Fee ${money(fee)} | <strong>Total ${money(amt + fee)}</strong></div>
</div>`;
}

function parsePayments(p) {
  const out = [];
  PAYMENT_FIELDS.forEach((k) => {
    if (!p[k]) return;
    const [a, t, d] = p[k].split(",").map((s) => s.trim());
    const amt = num(a);
    if (!isNaN(amt)) out.push({ amount: amt, txn: t, date: d });
  });
  return out;
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
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>
body{font-family:system-ui;background:#f3f4f6;margin:0}
.container{max-width:760px;margin:40px auto;padding:24px;background:#fff;border-radius:16px}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.summary-card{border:1px solid #e5e7eb;border-radius:12px;padding:14px}
.summary-card.highlight{border-color:#4f46e5}
.payment-columns{display:grid;grid-template-columns:1fr 300px;gap:24px}
@media(max-width:900px){.payment-columns{grid-template-columns:1fr}}
.custom-card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#fafafa}
.pay-block{margin-bottom:16px}
.fee{font-size:.85rem;color:#4b5563}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{padding:10px;border-bottom:1px solid #e5e7eb}
th{background:#f9fafb;font-size:.8rem}
.payment-disclaimer{margin:24px 0 12px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:.85rem;color:#4b5563}
.btn{display:inline-block;padding:8px 14px;border-radius:999px;background:#4f46e5;color:#fff;text-decoration:none}
</style></head>
<body><div class="container">${body}</div></body></html>`;
}

function textResponse(code, msg) {
  return { statusCode: code, body: msg };
}
function htmlResponse(code, html) {
  return { statusCode: code, headers: { "Content-Type": "text/html" }, body: html };
}
