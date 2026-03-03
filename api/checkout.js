const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { quoteId, paymentType } = req.body;

  if (!quoteId || !['deposit', 'balance'].includes(paymentType)) {
    return res.status(400).json({ error: 'Missing quoteId or invalid paymentType' });
  }

  // Fetch quote from Supabase using service role key (bypasses RLS)
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const supaRes = await fetch(
    `${supabaseUrl}/rest/v1/quotes?select=id,quote_data,client_name,project_name,quote_number,fee_included,status&id=eq.${encodeURIComponent(quoteId)}`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );

  const rows = await supaRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(404).json({ error: 'Quote not found' });
  }

  const quote = rows[0];
  const d = quote.quote_data;
  const feeIncluded = quote.fee_included !== false;
  const showFee = feeIncluded && d.svcFee > 0;

  // Calculate amounts (mirrors q.html logic)
  const deposit = d.deposit;
  const total = showFee ? d.total : d.total - d.svcFee;
  const balance = total - deposit;

  const amountDollars = paymentType === 'deposit' ? deposit : balance;
  const amountCents = Math.round(amountDollars * 100);

  if (amountCents <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Prevent double payment
  if (paymentType === 'deposit' && (quote.status === 'deposit_paid' || quote.status === 'paid')) {
    return res.status(400).json({ error: 'Deposit already paid' });
  }
  if (paymentType === 'balance' && quote.status === 'paid') {
    return res.status(400).json({ error: 'Already fully paid' });
  }

  const label = paymentType === 'deposit'
    ? `Production Deposit — ${d.depPct}% (${quote.project_name || 'Project'})`
    : `Remaining Balance (${quote.project_name || 'Project'})`;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const origin = req.headers.origin || 'https://bhp-quotes-app.vercel.app';

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: label,
            description: `Quote ${quote.quote_number || ''} — ${quote.client_name || ''}`.trim(),
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${origin}/q/${quoteId}?payment=success&type=${paymentType}`,
    cancel_url: `${origin}/q/${quoteId}?payment=cancelled`,
    metadata: {
      quoteId: quoteId,
      paymentType: paymentType,
    },
  });

  return res.status(200).json({ url: session.url });
};
