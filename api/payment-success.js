module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { quoteId, paymentType } = req.body;
    if (!quoteId || !['deposit', 'balance'].includes(paymentType)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const newStatus = paymentType === 'balance' ? 'paid' : 'deposit_paid';

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
    return res.status(500).json({ error: err.message });
  }
};
