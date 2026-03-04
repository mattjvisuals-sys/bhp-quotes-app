const Stripe = require('stripe');

// Disable Vercel's default body parsing so we get the raw body for signature verification
module.exports.config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function updateQuoteStatus(quoteId, status) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  return fetch(
    `${supabaseUrl}/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        status: status,
        updated_at: new Date().toISOString(),
      }),
    }
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const rawBody = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const session = event.data.object;
  const quoteId = session.metadata?.quoteId;
  const paymentType = session.metadata?.paymentType;

  if (quoteId) {
    if (event.type === 'checkout.session.completed') {
      if (session.payment_status === 'paid') {
        // Immediate payment (card) — mark as paid
        const newStatus = paymentType === 'balance' ? 'paid' : 'deposit_paid';
        await updateQuoteStatus(quoteId, newStatus);
      } else if (session.payment_status === 'unpaid') {
        // Delayed payment (ACH) — mark as processing
        const newStatus = paymentType === 'balance' ? 'ach_balance_processing' : 'ach_deposit_processing';
        await updateQuoteStatus(quoteId, newStatus);
      }
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      // ACH payment cleared
      const newStatus = paymentType === 'balance' ? 'paid' : 'deposit_paid';
      await updateQuoteStatus(quoteId, newStatus);
    } else if (event.type === 'checkout.session.async_payment_failed') {
      // ACH payment failed — revert to previous status
      const newStatus = paymentType === 'balance' ? 'deposit_paid' : 'sent';
      await updateQuoteStatus(quoteId, newStatus);
    }
  }

  return res.status(200).json({ received: true });
};
