import {
  buildCustomerSms,
  buildVvsSms,
  defaultInfo,
  extractBookingInfo,
  getCallId,
  getCustomerPhone,
  getSaesonKontekst,
  isCallProcessed,
  markCallProcessed,
  sendSmsSikkert,
  validateVapiRequest,
  validerAdresseMedDawa
} from './_vvs-shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!validateVapiRequest(req)) {
    console.warn('Webhook afvist - ugyldig eller manglende secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;
    if (body.message?.type !== 'end-of-call-report') {
      return res.status(200).json({ ok: true });
    }

    const message = body.message;
    const callId = getCallId(message);
    const transcript = message?.transcript || '';
    const customerPhone = getCustomerPhone(message);

    if (callId && isCallProcessed(callId)) {
      console.log(`Duplikat - call ${callId} allerede behandlet`);
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (callId) markCallProcessed(callId);

    const saesonKontekst = getSaesonKontekst();

    let info;
    try {
      info = await extractBookingInfo(transcript, customerPhone, saesonKontekst);
    } catch (err) {
      console.error('Ekstraktion fejlede:', err.message);
      info = defaultInfo(customerPhone, saesonKontekst);
      info.ekstra_noter = `EKSTRAKTION FEJLEDE: ${err.message} — installatør skal ringe kunde manuelt`;
    }

    try {
      info = await validerAdresseMedDawa(info, transcript);
    } catch (err) {
      console.error('DAWA fejlede:', err.message);
      info.adresse_status = 'USIKKER';
      info.adresse_note = `DAWA-validering fejlede: ${err.message}`;
    }

    console.log('Booking:', {
      prioritet: info.prioritet,
      akut_niveau: info.akut_niveau,
      kategori: info.kategori,
      adresse_status: info.adresse_status,
      vicevaert: info.vicevaert_relevant,
      kemikalier: info.kemikalier_brugt,
    });

    const vvsSent = await sendSmsSikkert(process.env.VVS_NUMBER, buildVvsSms(info), 'VVS-mester');
    if (customerPhone) {
      await sendSmsSikkert(customerPhone, buildCustomerSms(info), 'Kunde');
    }

    return res.status(200).json({ ok: true, vvsSent });
  } catch (err) {
    console.error('Webhook fejl:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
