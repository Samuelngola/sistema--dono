# Sistema do Dono — Servidor

Servidor de gestão de acessos, pagamentos ProxyPay e tokens.

## Variáveis de ambiente (configurar no Render)

| Variável | Descrição | Exemplo |
|---|---|---|
| `WA_NUMBER` | Teu número WhatsApp | `244928708281` |
| `PROXYPAY_API_KEY` | API Key ProxyPay | `sk_live_...` |
| `PROXYPAY_ENTITY` | Entidade Multicaixa | `12345` |
| `PROXYPAY_ENV` | Ambiente ProxyPay | `sandbox` ou `production` |
| `ADMIN_SECRET` | Palavra-passe admin | `dono2025` |
| `BASE_URL` | URL do servidor no Render | `https://sistema-dono.onrender.com` |

## Endpoints

- `POST /api/generate-reference` — Gerar referência de pagamento
- `POST /api/confirm-payment` — Confirmar pagamento manualmente
- `POST /api/send-access` — Gerar link WhatsApp de acesso
- `GET /api/clients` — Listar todos os clientes
- `POST /api/renew` — Renovar acesso
- `POST /webhook/proxypay` — Webhook automático ProxyPay
- `GET /health` — Estado do servidor
