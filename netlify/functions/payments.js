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
const DEPOSIT_BUTTON_HIDE_AT_PAID = 2250;
const CARD_FEE_RATE = 0.035;

// Success URLs
const SUCCESS_URL_FIRST_PAYMENT =
  "https://www.pacificdiscovery.org/student/payment/pay-now/payment-success";

const SUCCESS_URL_REPEAT_PAYMENT =
  "https://www.pacificdiscovery.org/student/payment/pay-now/payment-received";

// Pay later URL
const PAY_LATER_URL =
  "https://www.pacificdiscovery.org/student/payment/pay-now/payment-success";

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

    if (checkout === "1") {
      return await handleStripeCheckout(event, url);
    }

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

    if (!email) {
      return htmlResponse(
        400,
        basicPage(
          "Missing email",
          `<p>Please access this page via the portal form.</p>`
        )
      );
    }

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

    const deals = await getDealsForContact(contact.id, email);
    if (!deals.length) {
      return htmlResponse(
        404,
        basicPage("No programs found", `<p>No payment records found.</p>`)
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

  if (!base || base <= 0) {
    return textResponse(400, "No balance due.");
  }

  const fee = base * CARD_FEE_RATE;
  const total = base + fee;

  const baseUrl = new URL(event.rawUrl);
  baseUrl.search = "";
  const cancelUrl = new URL(baseUrl.toString());
  cancelUrl.searchParams.set("dealId", dealId);
  if (email) cancelUrl.searchParams.set("email", email);

  // ✅ FIRST PAYMENT = NO PAYMENTS MADE AT ALL
  const isFirstPayment = totalPaid === 0;

  const successUrl = isFirstPayment
    ? `${SUCCESS_URL_FIRST_PAYMENT}?session_id={CHECKOUT_SESSION_ID}`
    : `${SUCCESS_URL_REPEAT_PAYMENT}?session_id={CHECKOUT_SESSION_ID}`;

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
    success_url: successUrl,
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
   PAYMENT PARSING
========================================================= */

function parsePayments(p) {
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

  return payments;
}

/* =========================================================
   UTILITIES
========================================================= */

function safeNumber(val) {
  if (val === null || val === undefined || val === "") return NaN;
  const num = Number(val);
  return isNaN(num) ? NaN : num;
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

function basicPage(title, contentHtml) {
  return `<div><h1>${escapeHtml(title)}</h1>${contentHtml}</div>`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
