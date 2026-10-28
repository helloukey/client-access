// Server-side configuration. Read lazily so `next build` works without secrets present.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),

  stripeSecretKey: () => {
    const key = required("STRIPE_SECRET_KEY");
    // This exercise must only ever touch test mode.
    if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
      throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_...)");
    }
    return key;
  },
  stripeWebhookSecret: () => required("STRIPE_WEBHOOK_SECRET"),

  zohoClientId: () => required("ZOHO_CLIENT_ID"),
  zohoClientSecret: () => required("ZOHO_CLIENT_SECRET"),
  zohoRefreshToken: () => required("ZOHO_REFRESH_TOKEN"),
  // Data-centre specific: .com / .eu / .in / .com.au ... must match where the Zoho org lives.
  zohoAccountsUrl: () => process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com",
  zohoApiDomain: () => process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com",
  zohoPaidStage: () => process.env.ZOHO_PAID_STAGE || "Closed Won",
  // Optional API name of a custom single-line Deal field to store the Stripe PaymentIntent id.
  zohoPaymentIdField: () => process.env.ZOHO_PAYMENT_ID_FIELD || "",
  zohoSimulateDown: () => process.env.ZOHO_SIMULATE_DOWN === "true",

  appUrl: () => process.env.APP_URL || "http://localhost:3000",
  adminToken: () => required("ADMIN_TOKEN"),
};
