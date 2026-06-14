# Realtime Order Create

Endpoint til den egenbyggede OpenAI Realtime + Cartesia voice-agent:

```bash
curl -X POST "http://localhost:3000/api/orders/create" \
  -H "Content-Type: application/json" \
  -H "x-zeppo-secret: DEV_SECRET" \
  -d '{
    "session_id": "test_123",
    "confirmed_by_customer": true,
    "customer": {
      "name": "Test Testesen",
      "phone": "12345678"
    },
    "items": [
      {
        "product": "peberoni",
        "quantity": 1
      },
      {
        "product": "pepsi maks",
        "quantity": 2
      }
    ],
    "delivery_type": "pickup",
    "pickup_time_text": "om 30 minutter",
    "notes": ""
  }'
```

Forventet:

- `peberoni` matcher `Pepperoni` med WooCommerce `product_id` 123.
- `pepsi maks` matcher `Pepsi Max` med WooCommerce `product_id` 126.
- Første request opretter ordren i WooCommerce.
- Næste request med samme `session_id` returnerer samme ordre uden at oprette en dublet.

Agenten må kun kalde endpointet efter kunden eksplicit har bekræftet opsummeringen.
