import twilio from 'twilio';

function clean(value) {
  return String(value || '').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const name = clean(req.body?.name);
    const company = clean(req.body?.company);
    const phone = clean(req.body?.phone);
    const email = clean(req.body?.email);
    const message = clean(req.body?.message);

    if (!name || !company || !phone || !email) {
      return res.status(400).json({ ok: false, error: 'Mangler påkrævede felter' });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_NUMBER;
    const to = process.env.VVS_NUMBER;

    if (!accountSid || !authToken || !from || !to) {
      console.error('Mangler Twilio env vars til demo lead');
      return res.status(500).json({ ok: false, error: 'Server mangler SMS-konfiguration' });
    }

    const client = twilio(accountSid, authToken);
    await client.messages.create({
      from,
      to,
      body: `NY DEMO FORESPØRGSEL\n\nNavn: ${name}\nFirma: ${company}\nTlf: ${phone}\nEmail: ${email}\n\n${message || 'Ingen besked'}`
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Demo lead fejl:', error);
    return res.status(500).json({ ok: false, error: 'Kunne ikke sende forespørgsel' });
  }
}
