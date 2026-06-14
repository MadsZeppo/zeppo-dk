import {
  getCallId,
  getCustomerPhone,
  getTranscript,
  isCallProcessed,
  markCallProcessed,
  sendSmsSikkert,
  validateVapiRequest,
} from '../api/_vvs-shared.js';
import {
  buildLaasesmedSms,
  defaultLaasesmedInfo,
  extractLaasesmedInfo,
} from '../api/_laasesmed-shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!validateVapiRequest(req)) {
    console.warn('Låsesmed webhook afvist - ugyldig eller manglende secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;
    if (body.message?.type !== 'end-of-call-report') {
      return res.status(200).json({ ok: true });
    }

    const message = body.message;
    const callId = getCallId(message);
    const transcript = getTranscript(message);
    const customerPhone = getCustomerPhone(message);

    if (callId && isCallProcessed(callId)) {
      console.log(`Låsesmed duplikat - call ${callId} allerede behandlet`);
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (callId) markCallProcessed(callId);

    console.log('Låsesmed webhook modtaget:', {
      callId,
      transcriptLength: transcript.length,
      customerPhone,
    });

    let info;
    try {
      info = await extractLaasesmedInfo(transcript, customerPhone);
    } catch (err) {
      console.error('Låsesmed-ekstraktion fejlede:', err.message);
      info = defaultLaasesmedInfo(customerPhone);
      info.ekstra_noter = `EKSTRAKTION FEJLEDE: ${err.message} - ring kunde manuelt`;
    }

    console.log('Låsesmed-sag:', {
      navn: info.navn,
      telefon: info.telefon,
      adresse: info.adresse,
      by: info.by,
      kategori: info.kategori,
      prioritet: info.prioritet,
    });

    const leadSent = await sendSmsSikkert(process.env.VVS_NUMBER, buildLaasesmedSms(info), 'Låsesmed');

    return res.status(200).json({ ok: true, leadSent });
  } catch (err) {
    console.error('Låsesmed webhook fejl:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
