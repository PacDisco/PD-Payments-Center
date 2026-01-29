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
const APP_FEE = 250;
const DEPOSIT_TARGET = 2500;
const DEPOSIT_BUTTON_HIDE_AT_PAID = 2250;
const CARD_FEE_RATE = 0.035;

// Success URLs
const SUCCESS_URL_FIRST_PAYMENT =
  "https://www.pacificdiscovery.org/student/payment/pay-now/payment-success";

const SUCCESS_URL_REPEAT_PAYMENT =
  "https://www.pacificdiscovery.org/student/payment/pay-now/payment-received";

const PAY_LATER_URL =
  "https://www.pacificdiscovery.org/student/payment/pay-now/payment-success";

/* =========================================================
   HANDLER
========================================================= */

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const email = url.searchParams.get("email");
    const dealId = url.searchParams.get("dealId");
    const checkout = url.searchParams.get("checkout");

    if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
      return textResponse(500, "HubSpot token not configured.");
    }

    if (checkout === "1") {
      return await handleStripeCheckout(event, url);
    }

    if (dealId) {
      const deal = await getDealById(dealId);
      if (!deal) {
        return htmlResponse(
          404,
          basicPage("Deal not found", "<p>Program not found.</p>")
        );
      }
      deal.properties.email = email || "";
      return htmlResponse(200, renderDealPortal(deal));
    }

    if (!email) {
      return htmlResponse(
        400,
        basicPage("Missing email", "<p>Email is required.</p>")
      );
    }

    const contact = await findContactByEmail(email);
    if (!contact) {
      return htmlResponse(
        404,
        basicPage("No account found", `<p>${escapeHtml(email)}</p>`)
      );
    }

    const deals = await getDealsForContact(contact.id, email);
    if (!deals.length) {
      return htmlResponse(
        404,
        basicPage("No programs found", "<p>No programs yet.</p>")
      );
    }

    if (deals.length === 1) {
      return htmlResponse(200, renderDealPortal(deals[0]));
    }

    return htmlResponse(200, renderDealSelectionPage(deals, url, email));
  } catch (err) {
    console.error(err);
    return textResponse(500, "Unexpected error");
  }
};

/* =========================================================
   STRIPE CHECKOUT
========================================================= */

async function handleStripeCheckout(event, url) {
  const dealId = url.searchParams.get("dealId");
  const type = url.searchParams.get("type");
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

  const remaining = tuition - totalPaid;
  if (remaining <= 0) return textResponse(400, "No balance due.");

  const base = remaining;
  const fee = base * CARD_FEE_RATE;
  const total = base + fee;

  const cancelUrl = new URL(event.rawUrl);
  cancelUrl.search = "";
  cancelUrl.searchParams.set("dealId", dealId);
  if (email) cancelUrl.searchParams.set("email", email);

  const isFirstPayment = totalPaid === 0;

  const successUrl = isFirstPayment
    ? `${SUCCESS_URL_FIRST_PAYMENT}?session_id={CHECKOUT_SESSION_ID}`
    : `${SUCCESS_URL_REPEAT_PAYMENT}?session_id={CHECKOUT_SESSION_ID}`;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl.toString(),
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: programName },
          unit_amount: Math.round(total * 100),
        },
        quantity: 1,
      },
    ],
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
  const data = await hubSpotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      limit: 1,
    }),
  });
  return data.results?.[0] || null;
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
    `/crm/v3/objects/deals/${dealId}?properties=${PAYMENT_FIELDS.join(",")}`
  );
  return data?.id ? { id: data.id, properties: data.properties } : null;
}

/* =========================================================
   UTILS
========================================================= */

function parsePayments(p) {
  return PAYMENT_FIELDS.map((k) => p[k])
    .filter(Boolean)
    .map((raw) => {
      const [amount] = raw.split(",");
      return { amount: safeNumber(amount) };
    });
}

function safeNumber(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function htmlResponse(statusCode, html) {
  return { statusCode, headers: { "Content-Type": "text/html" }, body: html };
}

function textResponse(statusCode, text) {
  return { statusCode, headers: { "Content-Type": "text/plain" }, body: text };
}

function basicPage(title, body) {
  return `<h1>${escapeHtml(title)}</h1>${body}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
