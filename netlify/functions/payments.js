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

/* =========================================================
   NETLIFY HANDLER
========================================================= */

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
      return handleStripeCheckout(event, url);
    }

    /* ================= ENTRY ================= */
    if (!email && !dealId) {
      return textResponse(400, "Missing email.");
    }

    /* ================= DEAL VIEW ================= */
    if (dealId) {
      const deal = await getDealById(dealId);
      if (!deal) return textResponse(404, "Deal not found.");
      deal.properties.email = email;
      return htmlResponse(200, renderDealPortal(deal));
    }

    /* ================= LOOK UP DEALS BY EMAIL ================= */
    const contact = await findContactByEmail(email);
    if (!contact) {
      return htmlResponse(404, basicPage("No account found",
        `<p>No records found for <strong>${escape(email)}</strong>.</p>`));
    }

    const deals = await getDealsForContact(contact.id, email);

    if (deals.length === 0) {
      return htmlResponse(404, basicPage("No programs found",
        `<p>No payment records found for this account.</p>`));
    }

    if (deals.length === 1) {
      return htmlResponse(200, renderDealPortal(deals[0]));
    }

    return htmlResponse(200, renderDealSelection(deals, email));
  } catch (err) {
    console.error(err);
    return textResponse(500, "Unexpected error.");
  }
};

/* =========================================================
   STRIPE
========================================================= */

async function handleStripeCheckout(event, url) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return textResponse(500, "Stripe key missing.");
  }

  const dealId = url.searchParams.get("dealId");
  const type = url.searchParams.get("type");
  const email = url.searchParams.get("email");

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
      return textResponse(400, "Invalid amount.");
    }
    base = amt;
    label = "Custom Payment";
  } else {
    base = remaining;
    label = "Remaining Balance";
  }

  if (base <= 0) return textResponse(400, "No balance due.");

  const fee = base * 0.035;
  const total = base + fee;

  const baseUrl = new URL(event.rawUrl);
  baseUrl.search = "";

  const cancelUrl = new URL(baseUrl.toString());
  cancelUrl.searchParams.set("email", email);
  cancelUrl.searchParams.set("dealId", dealId);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email || undefined,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: p.dealname || "Program Payment",
            description: `${label} – Deal ID ${dealId}`,
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
    },
  });

  if (!res.ok) throw new Error("HubSpot API error");
  return res.json();
}

async function findContactByEmail(email) {
  const body = {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
    ],
    properties: ["email"],
    limit: 1,
  };

  const data = await hubSpotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return data.results?.[0]
    ? { id: data.results[0].id }
    : null;
}

async function getDealsForContact(contactId, email) {
  const assoc = await hubSpotFetch(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`
  );

  const ids = assoc.results.map((r) => r.toObjectId);

  if (!ids.length) return [];

  const batch = await hubSpotFetch("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS],
      inputs: ids.map((id) => ({ id })),
    }),
  });

  return batch.results.map((d) => ({
    id: d.id,
    properties: { ...d.properties, email },
  }));
}

async function getDealById(dealId) {
  const data = await hubSpotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=${encodeURIComponent(
      ["dealname", "amount", "total_amount_paid", ...PAYMENT_FIELDS].join(",")
    )}`
  );
  return { id: data.id, properties: data.properties || {} };
}

/* =========================================================
   UI – DEAL SELECTION
========================================================= */

function renderDealSelection(deals, email) {
  const cards = deals
    .map(
      (d) => `
<a class="program-card" href="?email=${encodeURIComponent(
        email
      )}&dealId=${d.id}">
  <div class="name">${escape(d.properties.dealname || "Program")}</div>
  <div class="view">View payments →</div>
</a>`
    )
    .join("");

  return page(`
<h1>Select your program</h1>
<p>More than one program is associated with your account.</p>
<div class="program-grid">${cards}</div>
`);
}

/* =========================================================
   UI – PAYMENT PORTAL
========================================================= */

/* (renderDealPortal, helpers, page(), etc. unchanged from previous message) */

