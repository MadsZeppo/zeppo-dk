const ordersBySessionId = new Map();

export async function findOrderBySessionId(sessionId) {
  return ordersBySessionId.get(sessionId) || null;
}

export async function saveOrderMapping(sessionId, wooOrder) {
  const stored = {
    sessionId,
    orderId: wooOrder.id,
    orderNumber: String(wooOrder.number || wooOrder.id),
    status: wooOrder.status,
    total: wooOrder.total,
    wooOrder,
    createdAt: new Date().toISOString(),
  };
  ordersBySessionId.set(sessionId, stored);
  return stored;
}
