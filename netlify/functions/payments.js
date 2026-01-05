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

      const programFee = number(p.amount);
      const totalPaid = number(p.total_amount_paid);
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
        const amt = number(url.searchParams.get("amount"));
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

    /* ================= PAGE RENDER ================= */
    if (!dealId) return textResponse(400, "Missing dealId.");

    const deal = await getDealById(dealId);
    if (!deal) return textResponse(404, "Deal not found.");
    deal.properties.email = email;

    return htmlResponse(200, renderDealPortal(deal));
  } catch (err) {
    console.error(err);
    return textResponse(500, "Unexpected error.");
  }
};

/* ================= HUBSPOT HELPERS ================= */

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
    throw new Error("HubSpot API error");
  }

  return res.json();
}

async function getDealById(dealId) {
  const data = await hubSpotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=${encodeURIComponent(
      ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS].join(",")
    )}`
  );

  return {
    id: data.id,
    properties: data.properties || {},
  };
}

/* ================= UI ================= */

function renderDealPortal(deal) {
  const p = deal.properties;
  const tuition = number(p.amount);
  const paid = number(p.total_amount_paid);
  const remaining = tuition - paid;

  const depositTarget = 2500;
  const depositRemaining = Math.max(0, depositTarget - paid);

  return page(`
    <h1>${escape(p.dealname || "Program")}</h1>

    <div class="grid">
      <div>
        <p><strong>Program Tuition:</strong> ${money(tuition)}</p>
        <p><strong>Paid:</strong> ${money(paid)}</p>
        <p><strong>Remaining:</strong> ${money(remaining)}</p>

        ${
          paid === 0
            ? button("Pay Application Fee", `?checkout=1&type=appfee&dealId=${deal.id}`, 250)
            : ""
        }

        ${
          paid > 0 && paid < 2250
            ? button(
                `Pay Deposit (${money(depositRemaining)})`,
                `?checkout=1&type=deposit&dealId=${deal.id}`,
                depositRemaining
              )
            : ""
        }

        ${
          remaining > 0
            ? button(
                "Pay Remaining Balance",
                `?checkout=1&type=remaining&dealId=${deal.id}`,
                remaining
              )
            : "<p><strong>Fully paid</strong></p>"
        }
      </div>

      ${
        remaining > 0
          ? `
      <div class="card">
        <h3>Make a Payment</h3>
        <input id="amt" type="number" min="250" max="${remaining}" step="0.01">
        <button onclick="pay()">Pay</button>
        <div id="calc"></div>
      </div>`
          : ""
      }
    </div>

    <!-- ✅ NEW DISCLAIMER -->
    <div class="disclaimer">
      <em>
        A 3.5% transaction fee is applied to all credit card payments.
        To pay by wire transfer or ACH without the transaction fee,
        <a href="https://www.pacificdiscovery.org/student/payment/pay-now/wire-transfer-payment" target="_blank">
          click here to view wire transfer payment instructions
        </a>.
      </em>
    </div>

    <script>
      function pay(){
        const v = parseFloat(document.getElementById('amt').value);
        if(v < 250) return alert('Minimum $250');
        const p = new URLSearchParams(location.search);
        p.set('checkout','1');
        p.set('type','custom');
        p.set('amount',v.toFixed(2));
        location.search = p.toString();
      }
    </script>
  `);
}

/* ================= HTML ================= */

function page(body) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<style>
body{font-family:system-ui;background:#f3f4f6;margin:0}
h1{margin-top:0}
.grid{display:grid;grid-template-columns:1fr 300px;gap:24px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:#fafafa;padding:16px;border-radius:12px;border:1px solid #e5e7eb}
button{padding:8px 12px;margin-top:8px}
.disclaimer{margin-top:24px;font-size:.85rem;color:#4b5563;border-top:1px solid #e5e7eb;padding-top:12px}
</style>
</head>
<body>
<div style="max-width:720px;margin:40px auto;background:#fff;padding:24px;border-radius:16px">
${body}
</div>
</body>
</html>
`;
}

/* ================= HELPERS ================= */

function button(label, href, amt) {
  const fee = amt * 0.035;
  return `
    <p>
      <a href="${href}">${label}</a><br>
      Base: ${money(amt)} | Fee: ${money(fee)} | <strong>Total: ${money(
    amt + fee
  )}</strong>
    </p>
  `;
}

function number(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function money(v) {
  return "$" + v.toFixed(2);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function textResponse(code, msg) {
  return { statusCode: code, body: msg };
}

function htmlResponse(code, html) {
  return {
    statusCode: code,
    headers: { "Content-Type": "text/html" },
    body: html,
  };
}
