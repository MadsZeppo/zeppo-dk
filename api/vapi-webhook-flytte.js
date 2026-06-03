import {
  getCallId,
  getCustomerPhone,
  getTranscript,
  isCallProcessed,
  markCallProcessed,
  sendSmsSikkert,
  validateVapiRequest,
} from './_vvs-shared.js';
import {
  buildFlytteCustomerSms,
  buildFlytteSms,
  defaultFlytteInfo,
  extractFlytteInfo,
} from './_flytte-shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!validateVapiRequest(req)) {
    console.warn('Flytte webhook afvist - ugyldig eller manglende secret');
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
      console.log(`Flytte duplikat - call ${callId} allerede behandlet`);
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (callId) markCallProcessed(callId);

    console.log('Flytte webhook modtaget:', {
      callId,
      transcriptLength: transcript.length,
      customerPhone,
    });

    let info;
    try {
      info = await extractFlytteInfo(transcript, customerPhone);
    } catch (err) {
      console.error('Flytte-ekstraktion fejlede:', err.message);
      info = defaultFlytteInfo(customerPhone);
      info.ekstra_noter = `EKSTRAKTION FEJLEDE: ${err.message} - ring kunde manuelt`;
    }

    console.log('Flytteopgave:', {
      navn: info.navn,
      telefon: info.telefon,
      flytte_fra_status: info.flytte_fra_status,
      flytte_til_status: info.flytte_til_status,
      boligtype_fra: info.boligtype_fra,
      boligtype_til: info.boligtype_til,
      antal_vaerelser: info.antal_vaerelser,
      hvornaar: info.hvornaar,
    });

    const leadSent = await sendSmsSikkert(process.env.VVS_NUMBER, buildFlytteSms(info), 'Flyttefirma');
    if (customerPhone) {
      await sendSmsSikkert(customerPhone, buildFlytteCustomerSms(info), 'Flyttekunde');
    }

    return res.status(200).json({ ok: true, leadSent });
  } catch (err) {
    console.error('Flytte webhook fejl:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
