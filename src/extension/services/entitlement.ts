/**
 * Entitlement placeholder. The payment provider is undecided (the user, 4 Oct 2026: "do not
 * worry about payment code ... assume all sign ups are subscribed for now"), so every user is
 * subscribed. When a provider is chosen, the real check goes here; session/start is the only
 * caller. Nothing here touches Stripe or the subscriptions table.
 */

export async function isSubscribed(_userId: string): Promise<boolean> {
  return true;
}
