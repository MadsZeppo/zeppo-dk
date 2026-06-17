import { createClient } from '@supabase/supabase-js';

function clean(value) {
  return String(value || '').trim();
}

const supabaseUrl = clean(process.env.SUPABASE_URL);
const supabaseServiceRoleKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

export const supabaseEnabled = Boolean(supabaseUrl && supabaseServiceRoleKey);

export const supabase = supabaseEnabled
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    })
  : null;

function logDisabledOnce() {
  if (logDisabledOnce.didLog) return;
  logDisabledOnce.didLog = true;
  console.warn('[Supabase] disabled: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing');
}

async function runSupabase(operation, fallback = null) {
  if (!supabaseEnabled) {
    logDisabledOnce();
    return fallback;
  }

  try {
    return await operation();
  } catch (error) {
    console.error('[Supabase] unexpected error:', error);
    return fallback;
  }
}

export async function findCustomerByPhone(phoneNumber) {
  const phone = clean(phoneNumber);
  if (!phone) return null;

  return runSupabase(async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('twilio_phone_number', phone)
      .eq('active', true)
      .maybeSingle();

    if (error) console.error('[Supabase] findCustomerByPhone:', error);
    return data || null;
  });
}

export async function findCustomerById(customerId) {
  const id = clean(customerId);
  if (!id) return null;

  return runSupabase(async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('active', true)
      .maybeSingle();

    if (error) console.error('[Supabase] findCustomerById:', error);
    return data || null;
  });
}

export async function findCustomerByName(name) {
  const customerName = clean(name);
  if (!customerName) return null;

  return runSupabase(async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .ilike('name', customerName)
      .eq('active', true)
      .limit(1)
      .maybeSingle();

    if (error) console.error('[Supabase] findCustomerByName:', error);
    return data || null;
  });
}

export async function findOrCreateCustomer({
  name,
  type = 'pizzaria',
  twilio_phone_number,
  contact_email,
  contact_phone,
} = {}) {
  const customerName = clean(name);
  if (!customerName) return null;

  return runSupabase(async () => {
    const phone = clean(twilio_phone_number);
    if (phone) {
      const byPhone = await findCustomerByPhone(phone);
      if (byPhone) return byPhone;
    }

    const byName = await findCustomerByName(customerName);
    if (byName) return byName;

    const insertPayload = {
      name: customerName,
      type,
      pricing_plan: 'trial',
      monthly_price_dkk: 0,
      active: true,
    };

    if (phone) insertPayload.twilio_phone_number = phone;
    if (clean(contact_email)) insertPayload.contact_email = clean(contact_email);
    if (clean(contact_phone)) insertPayload.contact_phone = clean(contact_phone);

    const { data, error } = await supabase
      .from('customers')
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      console.error('[Supabase] findOrCreateCustomer:', error);
      return null;
    }

    return data;
  });
}

export async function createCall({ customer_id, caller_number }) {
  return runSupabase(async () => {
    const { data, error } = await supabase
      .from('calls')
      .insert({ customer_id, caller_number, status: 'in_progress' })
      .select()
      .single();

    if (error) {
      console.error('[Supabase] createCall:', error);
      return null;
    }

    return data;
  });
}

export async function updateCall(callId, updates) {
  const id = clean(callId);
  if (!id) return;

  await runSupabase(async () => {
    const { error } = await supabase
      .from('calls')
      .update(updates)
      .eq('id', id);

    if (error) console.error('[Supabase] updateCall:', error);
  });
}

export async function createOrder(orderData) {
  return runSupabase(async () => {
    const { data, error } = await supabase
      .from('orders')
      .insert(orderData)
      .select()
      .single();

    if (error) {
      console.error('[Supabase] createOrder:', error);
      return null;
    }

    return data;
  });
}

export async function createBooking(bookingData) {
  return runSupabase(async () => {
    const { data, error } = await supabase
      .from('bookings')
      .insert(bookingData)
      .select()
      .single();

    if (error) {
      console.error('[Supabase] createBooking:', error);
      return null;
    }

    return data;
  });
}

export function logSystemEvent({ customer_id, call_id, level = 'info', source, message, metadata = {} }) {
  if (!supabaseEnabled) {
    logDisabledOnce();
    return;
  }

  supabase
    .from('system_logs')
    .insert({ customer_id, call_id, level, source, message, metadata })
    .then(({ error }) => {
      if (error) console.error('[Supabase] logSystemEvent:', error);
    });
}
