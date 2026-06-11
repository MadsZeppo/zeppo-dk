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

    console.log('Demo lead modtaget - SMS deaktiveret:', {
      name,
      company,
      phone,
      email,
      message: message || 'Ingen besked'
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Demo lead fejl:', { message: error.message });
    return res.status(500).json({
      ok: false,
      error: error.message || 'Kunne ikke sende forespørgsel'
    });
  }
}
