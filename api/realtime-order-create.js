import { resolveOrderItems } from '../lib/menuResolver.js';
import { findOrderBySessionId, saveOrderMapping } from '../lib/orderStore.js';
import { createWooCommerceOrder, WooCommerceError } from '../lib/woocommerce.js';

function clean(value) {
  return String(value || '').trim();
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return '';
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (/^\d{8}$/.test(cleaned)) return `+45${cleaned}`;
  return cleaned;
}

function toPositiveInteger(value) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function splitName(name) {
  const parts = clean(name).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
  };
}

function orderError(status, code, error, messageForAgent, extra = {}) {
  return {
    status,
    body: {
      ok: false,
      error,
      code,
      message_for_agent: messageForAgent,
      ...extra,
    },
  };
}

function validateSecret(req) {
  const expected = clean(process.env.ZEPPO_ORDER_SECRET);
  const provided = clean(req.headers?.['x-zeppo-secret']);
  return Boolean(expected && provided && provided === expected);
}

function validateInput(body) {
  if (!clean(body?.session_id)) {
    return orderError(400, 'VALIDATION_ERROR', 'session_id mangler', 'Der mangler et sessions-id på ordren.');
  }

  if (body?.confirmed_by_customer !== true) {
    return orderError(
      400,
      'ORDER_NOT_CONFIRMED',
      'confirmed_by_customer skal være true',
      'Jeg skal lige have kunden til at bekræfte ordren først.'
    );
  }

  const customer = body.customer || {};
  if (!normalizePhone(customer.phone)) {
    return orderError(400, 'VALIDATION_ERROR', 'customer.phone mangler', 'Jeg mangler kundens telefonnummer fra opkaldet.');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return orderError(400, 'VALIDATION_ERROR', 'items skal være et array med mindst én vare', 'Jeg mangler varerne i ordren.');
  }

  for (const item of body.items) {
    if (!clean(item?.product) || !toPositiveInteger(item?.quantity)) {
      return orderError(400, 'VALIDATION_ERROR', 'Alle items skal have product og positiv quantity', 'Jeg mangler en vare eller et antal.');
    }
  }

  const deliveryType = clean(body.delivery_type).toLowerCase();
  if (!['pickup', 'delivery'].includes(deliveryType)) {
    return orderError(400, 'VALIDATION_ERROR', 'delivery_type skal være pickup eller delivery', 'Jeg skal vide om kunden henter selv eller skal have levering.');
  }

  if (deliveryType === 'delivery' && !clean(customer.address)) {
    return orderError(400, 'ADDRESS_REQUIRED', 'Adresse mangler ved levering', 'Hvad er adressen?');
  }

  return null;
}

function buildCustomerNote(input) {
  const deliveryLabel = input.delivery_type === 'delivery' ? 'Levering' : 'Afhentning';
  return [
    'AI telefonordre',
    `Type: ${deliveryLabel}`,
    clean(input.pickup_time_text) ? `Tid: ${clean(input.pickup_time_text)}` : '',
    clean(input.notes) ? `Noter: ${clean(input.notes)}` : '',
  ].filter(Boolean).join('\n');
}

function buildAddress(customer) {
  return {
    first_name: splitName(customer.name).firstName,
    last_name: splitName(customer.name).lastName,
    phone: normalizePhone(customer.phone),
    email: 'ordre@zeppo.dk',
    address_1: clean(customer.address),
    city: clean(customer.city),
    postcode: clean(customer.postcode),
    country: 'DK',
  };
}

export function buildWooCommerceOrder(input, resolvedItems) {
  const customer = input.customer || {};
  const deliveryType = clean(input.delivery_type).toLowerCase();
  const isDelivery = deliveryType === 'delivery';
  const billing = buildAddress(customer);
  const payload = {
    status: 'processing',
    payment_method: 'cod',
    payment_method_title: isDelivery ? 'Betaling ved levering' : 'Betaling ved afhentning',
    set_paid: false,
    billing,
    line_items: resolvedItems.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
    })),
    customer_note: buildCustomerNote({ ...input, delivery_type: deliveryType }),
    meta_data: [
      { key: '_zeppo_session_id', value: clean(input.session_id) },
      { key: '_zeppo_source', value: 'realtime_voice_agent' },
      { key: '_delivery_type', value: deliveryType },
      { key: '_pickup_time_text', value: clean(input.pickup_time_text) },
      { key: '_raw_voice_order', value: JSON.stringify(input) },
    ],
  };

  if (isDelivery) {
    payload.shipping = {
      first_name: billing.first_name,
      last_name: billing.last_name,
      address_1: billing.address_1,
      city: billing.city,
      postcode: billing.postcode,
      country: billing.country,
    };
  }

  return payload;
}

function successResponse(order, resolvedItems, extra = {}) {
  const orderNumber = String(order.number || order.orderNumber || order.id || order.orderId);
  return {
    ok: true,
    order_id: order.id || order.orderId,
    order_number: orderNumber,
    status: order.status,
    total: order.total,
    items: resolvedItems.map((item) => ({
      product_id: item.productId,
      name: item.canonicalName,
      quantity: item.quantity,
    })),
    message_for_agent: `Perfekt, din ordre er oprettet. Ordrenummeret er ${orderNumber}.`,
    ...extra,
  };
}

export default async function createRealtimeOrderHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
      message_for_agent: 'Der skete en teknisk fejl med ordreoprettelsen.',
    });
  }

  if (!validateSecret(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      message_for_agent: 'Der skete en teknisk fejl med ordreoprettelsen.',
    });
  }

  try {
    const input = req.body || {};
    const validationError = validateInput(input);
    if (validationError) return res.status(validationError.status).json(validationError.body);

    const normalizedItems = input.items.map((item) => ({
      product: clean(item.product),
      quantity: toPositiveInteger(item.quantity),
    }));
    const resolvedItems = resolveOrderItems(normalizedItems);
    const failedItem = resolvedItems.find((item) => !item.ok);
    if (failedItem) {
      return res.status(400).json({
        ok: false,
        error: 'Kunne ikke matche produkt',
        code: 'NO_MENU_MATCH',
        spoken_product: failedItem.spokenProduct,
        message_for_agent: 'Jeg er ikke helt sikker på hvilken vare du mener. Kan du sige den igen?',
      });
    }

    const sessionId = clean(input.session_id);
    const existing = await findOrderBySessionId(sessionId);
    if (existing) {
      return res.status(200).json(successResponse(existing.wooOrder || existing, resolvedItems, { idempotent: true }));
    }

    const wooPayload = buildWooCommerceOrder(input, resolvedItems);
    const wooOrder = await createWooCommerceOrder(wooPayload);
    await saveOrderMapping(sessionId, wooOrder);

    console.log('[orders] woo_order_created', {
      session_id: sessionId,
      order_id: wooOrder.id,
      order_number: wooOrder.number,
      item_count: resolvedItems.length,
    });

    return res.status(200).json(successResponse(wooOrder, resolvedItems));
  } catch (error) {
    if (error.code === 'CONFIG_MISSING') {
      return res.status(500).json({
        ok: false,
        error: error.message,
        code: 'CONFIG_MISSING',
        message_for_agent: 'Der mangler opsætning til ordreoprettelsen.',
      });
    }

    if (error instanceof WooCommerceError) {
      console.error('[orders] woocommerce_error', {
        code: error.code,
        status: error.status,
        message: error.message,
        body: error.body,
      });
      return res.status(502).json({
        ok: false,
        error: error.message || 'WooCommerce API error',
        code: error.code || 'WOOCOMMERCE_ERROR',
        woo_status: error.status,
        woo_body: error.body,
        message_for_agent: 'Jeg kunne ikke oprette ordren automatisk lige nu. Jeg sender den videre manuelt.',
      });
    }

    console.error('[orders] unexpected_error', error);
    return res.status(500).json({
      ok: false,
      error: 'Unexpected backend error',
      code: 'INTERNAL_ERROR',
      message_for_agent: 'Jeg kunne ikke oprette ordren automatisk lige nu. Jeg sender den videre manuelt.',
    });
  }
}
