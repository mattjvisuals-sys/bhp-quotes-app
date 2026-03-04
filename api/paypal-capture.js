module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { orderId, quoteId, paymentType } = req.body;

    if (!orderId || !quoteId || !['deposit', 'balance'].includes(paymentType)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

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

    // Capture the approved order
    const captureRes = await fetch(base + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + tokenData.access_token,
        'Content-Type': 'application/json',
      },
    });

    const captureData = await captureRes.json();

    if (captureData.status !== 'COMPLETED') {
      console.error('PayPal capture failed:', captureData);
      return res.status(400).json({ error: 'Payment not completed' });
    }

    // Update quote status in Supabase
    const newStatus = paymentType === 'balance' ? 'paid' : 'deposit_paid';
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    await fetch(
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
          status: newStatus,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    return res.status(200).json({ ok: true, status: newStatus });
  } catch (err) {
    console.error('PayPal capture error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
