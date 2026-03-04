module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { quoteId, paymentType } = req.body;

    if (!quoteId || !['deposit', 'balance'].includes(paymentType)) {
      return res.status(400).json({ error: 'Missing quoteId or invalid paymentType' });
    }

    // Fetch quote from Supabase
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

    // Calculate amounts (mirrors checkout.js logic)
    const deposit = d.deposit;
    const total = showFee ? d.total : d.total - d.svcFee;
    const balance = total - deposit;

    const amountDollars = paymentType === 'deposit' ? deposit : balance;

    if (amountDollars <= 0) {
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

    // Get PayPal access token
    const mode = process.env.PAYPAL_MODE || 'sandbox';
    const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET).toString('base64');

    const tokenRes = await fetch(base + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(500).json({ error: 'Failed to authenticate with PayPal' });
    }

    // Create PayPal order
    const orderRes = await fetch(base + '/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + tokenData.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: quoteId,
          description: label,
          custom_id: JSON.stringify({ quoteId, paymentType }),
          amount: {
            currency_code: 'USD',
            value: amountDollars.toFixed(2),
          },
        }],
      }),
    });

    const order = await orderRes.json();
    if (!order.id) {
      console.error('PayPal order creation failed:', order);
      return res.status(500).json({ error: 'Failed to create PayPal order' });
    }

    return res.status(200).json({ orderId: order.id });
  } catch (err) {
    console.error('PayPal create error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
