import twilio from 'twilio';
import { sendSmsSikkert } from '../api/_vvs-shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method not allowed');
  }

  const twilioSignature = req.headers['x-twilio-signature'];
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (authToken && twilioSignature) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const url = `${protocol}://${host}${req.url}`;
    const valid = twilio.validateRequest(authToken, twilioSignature, url, req.body);
    if (!valid) {
      console.warn('SMS webhook afvist - ugyldig Twilio signature');
      return res.status(403).send('Forbidden');
    }
  }

  try {
    const fraNummer = req.body.From;
    const besked = req.body.Body;

    await sendSmsSikkert(
      process.env.VVS_NUMBER,
      `📩 RETTELSE FRA KUNDE\n\nFra: ${fraNummer}\n\n"${besked}"`,
      'Rettelse til VVS'
    );

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Tak. Vi har sendt din besked videre til installatøren. - Dansk VVS Teknik</Message></Response>`);
  } catch (err) {
    console.error('SMS fejl:', err.message);
    return res.status(500).send('Fejl');
  }
}
