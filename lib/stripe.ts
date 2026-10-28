import Stripe from "stripe";
import { env } from "@/lib/env";

let stripe: Stripe | undefined;

export function stripeClient(): Stripe {
  // API version is pinned by the SDK version in package.json.
  stripe ??= new Stripe(env.stripeSecretKey());
  return stripe;
}
