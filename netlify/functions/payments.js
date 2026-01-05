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
      const payments = parsePayments(p);

      const tuition = num(p.amount);
      const totalPaid =
        !isNaN(num(p.total_amount_paid))
          ? num(p.total_amount_paid)
          : payments.reduce((s, p) => s + p.amount, 0);

      const remaining = tuition - totalPaid;
      const depositRemaining = Math.max(0, 2500 - totalPaid);

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
                name: p.dealname || "Program Payment",
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

<div class="payment-layout">
  <div class="actions">
    ${totalPaid === 0 ? presetButton(deal.id, "Pay Application Fee", "appfee", 250) : ""}
    ${totalPaid > 0 && totalPaid < 2250 ? presetButton(deal.id, "Pay Deposit", "deposit", depositRemaining) : ""}
    ${remaining > 0 ? presetButton(deal.id, "Pay Remaining Balance", "remaining", remaining) : "<strong>Paid in full</strong>"}
  </div>

  ${
    remaining > 0
      ? `
  <div class="custom-card">
    <h3>Make a Payment</h3>
    <p class="sub">Minimum $250, up to your remaining balance.</p>

    <input id="customAmount" type="number" min="250" max="${remaining}" step="0.01" placeholder="250.00">
    <div id="customError" class="error"></div>
    <div id="customCalc" class="calc"></div>

    <button id="customPayBtn" disabled onclick="customPay()">Make a Payment</button>
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
const input = document.getElementById('customAmount');
const calc = document.getElementById('customCalc');
const err = document.getElementById('customError');
const btn = document.getElementById('customPayBtn');
const MAX = ${remaining};

function fmt(n){ return '$' + n.toLocaleString('en-US',{minimumFractionDigits:2}); }

if(input){
  input.addEventListener('input',()=>{
    const v = parseFloat(input.value);
    err.textContent = '';
    calc.textContent = '';
    btn.disabled = true;

    if(isNaN(v)){
      err.textContent = 'Please enter an amount.';
      return;
    }
    if(v < 250){
      err.textContent = 'Minimum payment is $250.';
      return;
    }
    if(v > MAX){
      err.textContent = 'Amount cannot exceed your remaining balance.';
      return;
    }

    const fee = v * 0.035;
    calc.innerHTML =
      'Base ' + fmt(v) +
      ' | Fee ' + fmt(fee) +
      ' | <strong>Total ' + fmt(v+fee) + '</strong>';

    btn.disabled = false;
  });
}

function customPay(){
  const v = parseFloat(input.value);
  if(isNaN(v) || v < 250 || v > MAX) return;
  const p = new URLSearchParams(location.search);
  p.set('checkout','1');
  p.set('type','custom');
  p.set('amount',v.toFixed(2));
  location.search = p.toString();
}
</script>
`);
}

/* ================= HELPERS ================= */

function presetButton(dealId, label, type, amt) {
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
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<style>
body{font-family:system-ui;background:#f3f4f6;margin:0}
.container{max-width:820px;margin:40px auto;padding:24px;background:#fff;border-radius:18px}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}
.summary-card{border:1px solid #e5e7eb;border-radius:14px;padding:16px}
.summary-card.highlight{border-color:#4f46e5}
.label{text-transform:uppercase;font-size:.75rem;color:#6b7280;margin-bottom:4px}
.value{font-size:1.1rem;font-weight:600}
.payment-layout{display:grid;grid-template-columns:1fr 320px;gap:28px}
@media(max-width:900px){.payment-layout{grid-template-columns:1fr}}
.custom-card{border:1px solid #e5e7eb;border-radius:14px;padding:18px;background:#fafafa;position:sticky;top:24px}
@media(max-width:900px){.custom-card{position:static}}
.pay-block{margin-bottom:18px}
.fee{font-size:.85rem;color:#4b5563;margin-top:4px}
.calc{font-size:.85rem;color:#374151;margin:6px 0}
.error{font-size:.85rem;color:#b91c1c;margin:4px 0}
.btn{display:inline-block;padding:10px 18px;border-radius:999px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600}
button{padding:10px 14px;border-radius:10px;border:none;background:#111827;color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
.payment-disclaimer{margin:28px 0 16px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:.85rem;color:#4b5563}
table{width:100%;border-collapse:collapse}
th,td{padding:12px;border-bottom:1px solid #e5e7eb}
th{background:#f9fafb;font-size:.8rem}
.empty-row{text-align:center;color:#9ca3af}
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
