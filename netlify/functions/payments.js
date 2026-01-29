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
const DEPOSIT_BUTTON_HIDE_AT_PAID = 2250; // Show deposit button if paid < 2250 (your rule)
const CARD_FEE_RATE = 0.035; // 3.5%

// First-payment success URL (Link A)
const SUCCESS_URL_FIRST_PAYMENT =
  "https://www.pacificdiscovery.org/student/payment/pay-now/payment-success";

// Repeat-payment success URL
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
          `<p>Please access this page via the portal form so we know which account to look up.</p>`
        )
      );
    }

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

    const deals = await getDealsForContact(contact.id, email);

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
  if (!process.env.STRIPE_SECRET_KEY) {
    return textResponse(500, "Stripe key not configured. Set STRIPE_SECRET_KEY.");
  }

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

  if (!base || isNaN(base) || base <= 0) {
    return textResponse(400, "No balance due.");
  }

  const fee = base * CARD_FEE_RATE;
  const total = base + fee;

  const baseUrl = new URL(event.rawUrl);
  baseUrl.search = "";
  const cancelUrl = new URL(baseUrl.toString());
  cancelUrl.searchParams.set("dealId", dealId);
  if (email) cancelUrl.searchParams.set("email", email);

  // ✅ FIXED SECTION (ONLY CHANGE)
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
   EVERYTHING BELOW IS UNCHANGED
========================================================= */

/* HubSpot helpers, UI rendering, styles, utils — unchanged from your file */
