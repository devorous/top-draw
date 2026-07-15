/**
 * @fileoverview Stripe supporter-subscription endpoints.
 *
 * POST /api/stripe/create-checkout-session — start a subscription checkout
 * POST /api/stripe/create-portal-session   — open the Stripe billing portal
 * POST /api/stripe/webhook                 — Stripe event webhook (raw body)
 *
 * The webhook is the source of truth for supporter status: it writes
 * `supporterUntil` (subscription period end + grace) onto the user document.
 * Live presence updates are pushed via the notifier registered by index.js
 * with `setSupporterChangeNotifier`.
 *
 * Stripe is optional — without STRIPE_SECRET_KEY all endpoints return 503.
 */

import Stripe from 'stripe';
import { ObjectId } from 'mongodb';
import { getDB } from './db.js';
import { getRequestUser } from './authUser.js';
import { corsHeaders, writeJson, readRequestBody } from './httpUtils.js';
import { getStripeSecretKey, getStripeWebhookSecret, getStripePriceId, getStripeOnetimePriceId, isStripeEnabled } from './config.js';

const CORS_HEADERS = corsHeaders('POST, OPTIONS');

// Keep gold flowing briefly past the paid period so a slow renewal invoice
// doesn't visibly strip cosmetics before the payment settles.
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

// Supporter time granted per one-time purchase.
const ONETIME_SUPPORT_MS = 31 * 24 * 60 * 60 * 1000;

const WEBHOOK_BODY_LIMIT = 256 * 1024;

let stripeClient = null;
let notifySupporterChange = null;

function json(res, status, body) {
  writeJson(res, status, body, CORS_HEADERS);
}

function getStripe() {
  if (!isStripeEnabled()) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(getStripeSecretKey());
  }
  return stripeClient;
}

/**
 * Register a callback invoked as (userId: string, isSupporter: boolean) when a
 * webhook changes a user's supporter status, so live sessions get gold
 * immediately instead of at next login.
 */
export function setSupporterChangeNotifier(fn) {
  notifySupporterChange = typeof fn === 'function' ? fn : null;
}

function getAppBaseUrl(req) {
  const fromEnv = process.env.PUBLIC_APP_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return host ? `${proto}://${host}` : 'https://ddraw.ca';
}

/**
 * Reads the raw request body as a Buffer. Stripe signature verification hashes
 * the exact bytes on the wire, so this must NOT go through readRequestBody
 * (which decodes to a UTF-8 string).
 */
function readRawBody(req, maxBytes = WEBHOOK_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * POST /api/stripe/create-checkout-session
 * Auth required. Body: { type?: 'monthly' | 'once' } (default 'monthly').
 * Creates (or reuses) a Stripe customer for the account and returns { url }
 * for the hosted checkout page — subscription mode for monthly, payment mode
 * for a one-time contribution (grants ONETIME_SUPPORT_MS of supporter time).
 */
export async function handleCreateCheckoutSession(req, res) {
  const stripe = getStripe();
  const db = getDB();
  if (!stripe || !db) return json(res, 503, { error: 'Payments not available' });

  let type = 'monthly';
  try {
    const raw = await readRequestBody(req, 4096);
    if (raw) type = JSON.parse(raw).type === 'once' ? 'once' : 'monthly';
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const priceId = type === 'once' ? getStripeOnetimePriceId() : getStripePriceId();
  if (!priceId) {
    return json(res, 503, { error: type === 'once' ? 'One-time support not configured' : 'Payments not configured' });
  }

  const me = await getRequestUser(req, { projection: { _id: 1, username: 1, email: 1, stripeCustomerId: 1 } });
  if (!me) return json(res, 401, { error: 'Authentication required' });

  try {
    let customerId = me.stripeCustomerId || null;
    if (customerId) {
      // A customer deleted in the Stripe dashboard leaves a dangling id here;
      // fall through and create a fresh one instead of failing checkout.
      const existing = await stripe.customers.retrieve(customerId).catch(() => null);
      if (!existing || existing.deleted) customerId = null;
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: me.email || undefined,
        name: me.username,
        metadata: { userId: String(me._id), username: me.username }
      });
      customerId = customer.id;
      await db.collection('users').updateOne(
        { _id: new ObjectId(me._id) },
        { $set: { stripeCustomerId: customerId } }
      );
    }

    const baseUrl = getAppBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: type === 'once' ? 'payment' : 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: String(me._id),
      ...(type === 'once' ? {} : { subscription_data: { metadata: { userId: String(me._id) } } }),
      metadata: { userId: String(me._id), supportType: type },
      success_url: `${baseUrl}/?supporter=success`,
      cancel_url: `${baseUrl}/?supporter=cancelled`
    });

    json(res, 200, { url: session.url });
  } catch (err) {
    console.error('[Stripe] create-checkout-session failed:', err);
    json(res, 500, { error: 'Failed to start checkout' });
  }
}

/**
 * POST /api/stripe/create-portal-session
 * Auth required. Returns { url } for the Stripe billing portal (cancel /
 * update payment method). Requires the account to have a Stripe customer.
 */
export async function handleCreatePortalSession(req, res) {
  const stripe = getStripe();
  const db = getDB();
  if (!stripe || !db) return json(res, 503, { error: 'Payments not available' });

  const me = await getRequestUser(req, { projection: { _id: 1, stripeCustomerId: 1 } });
  if (!me) return json(res, 401, { error: 'Authentication required' });
  if (!me.stripeCustomerId) return json(res, 400, { error: 'No support purchases on this account' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: me.stripeCustomerId,
      return_url: getAppBaseUrl(req)
    });
    json(res, 200, { url: session.url });
  } catch (err) {
    console.error('[Stripe] create-portal-session failed:', err);
    json(res, 500, { error: 'Failed to open billing portal' });
  }
}

/**
 * Resolve the ddraw user id a Stripe object belongs to: metadata first (set at
 * checkout time), then the stored stripeCustomerId mapping.
 */
async function resolveUserId(db, { metadataUserId, customerId }) {
  if (metadataUserId && ObjectId.isValid(metadataUserId)) return metadataUserId;
  if (customerId) {
    const user = await db.collection('users').findOne(
      { stripeCustomerId: customerId },
      { projection: { _id: 1 } }
    );
    if (user) return String(user._id);
  }
  return null;
}

/**
 * Extend a user's supporterUntil to `candidate` if that's later than what they
 * already have. Never reduces: one-time credit and subscription periods stack
 * as "whichever horizon is furthest", so a cancelled subscription can't wipe
 * remaining one-time supporter time (and vice versa).
 */
async function extendSupporterUntil(db, userId, candidate) {
  const user = await db.collection('users').findOne(
    { _id: new ObjectId(userId) },
    { projection: { supporterUntil: 1 } }
  );
  const existing = user?.supporterUntil ? new Date(user.supporterUntil).getTime() : 0;
  const supporterUntil = candidate.getTime() > existing ? candidate : new Date(existing);

  await db.collection('users').updateOne(
    { _id: new ObjectId(userId) },
    { $set: { supporterUntil } }
  );
  const active = supporterUntil.getTime() > Date.now();
  console.log(`[Stripe] Supporter status for user ${userId}: ${active ? 'active' : 'inactive'} until ${supporterUntil.toISOString()}`);
  notifySupporterChange?.(userId, active);
}

/** Period end (seconds epoch) from a subscription object, item-level first (newer API versions). */
function subscriptionPeriodEnd(subscription) {
  return subscription?.items?.data?.[0]?.current_period_end ?? subscription?.current_period_end ?? null;
}

/**
 * POST /api/stripe/webhook
 * Verifies the Stripe signature against the raw body, then updates
 * `supporterUntil` from the subscription lifecycle events.
 */
export async function handleStripeWebhook(req, res) {
  const stripe = getStripe();
  const db = getDB();
  const webhookSecret = getStripeWebhookSecret();
  if (!stripe || !db || !webhookSecret) return json(res, 503, { error: 'Payments not available' });

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.warn('[Stripe] Webhook signature verification failed:', err.message);
    return json(res, 400, { error: 'Invalid signature' });
  }

  // Idempotency: Stripe retries deliveries, so record processed event ids and
  // ack duplicates without reapplying them (unique index on eventId).
  try {
    await db.collection('stripe_events').insertOne({ eventId: event.id, type: event.type, receivedAt: new Date() });
  } catch (err) {
    if (err?.code === 11000) return json(res, 200, { received: true, duplicate: true });
    throw err;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status && session.payment_status !== 'paid') break;
        const userId = await resolveUserId(db, {
          metadataUserId: session.metadata?.userId || session.client_reference_id,
          customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id
        });
        if (!userId) break;

        if (session.mode === 'payment') {
          // One-time support: stack on top of whatever supporter time remains.
          const user = await db.collection('users').findOne(
            { _id: new ObjectId(userId) },
            { projection: { supporterUntil: 1 } }
          );
          const existing = user?.supporterUntil ? new Date(user.supporterUntil).getTime() : 0;
          const base = Math.max(Date.now(), Number.isFinite(existing) ? existing : 0);
          await extendSupporterUntil(db, userId, new Date(base + ONETIME_SUPPORT_MS));
        } else if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(
            typeof session.subscription === 'string' ? session.subscription : session.subscription.id
          );
          const periodEnd = subscriptionPeriodEnd(subscription);
          if (periodEnd) await extendSupporterUntil(db, userId, new Date(periodEnd * 1000 + GRACE_MS));
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = await resolveUserId(db, {
          metadataUserId: subscription.metadata?.userId,
          customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id
        });
        if (!userId) break;
        const periodEnd = subscriptionPeriodEnd(subscription);
        if (!periodEnd) break;
        // Renewals move the horizon forward; cancel_at_period_end keeps the
        // already-paid horizon. Extend-only, so this can't clobber one-time
        // supporter credit that reaches further out.
        await extendSupporterUntil(db, userId, new Date(periodEnd * 1000 + GRACE_MS));
        break;
      }

      // customer.subscription.deleted is intentionally not handled: the paid
      // period (+ grace) was already granted by the events above and simply
      // runs out on its own. Truncating here would also wipe any stacked
      // one-time supporter credit.

      default:
        break;
    }
  } catch (err) {
    console.error(`[Stripe] Webhook handler failed for ${event.type}:`, err);
    // Release the event id so Stripe's retry isn't swallowed as a duplicate.
    await db.collection('stripe_events').deleteOne({ eventId: event.id }).catch(() => {});
    return json(res, 500, { error: 'Webhook processing failed' });
  }

  json(res, 200, { received: true });
}
