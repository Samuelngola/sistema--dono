const express = require('express');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── SERVIR FICHEIROS HTML ──
app.use(express.static(path.join(__dirname)));

// Ignorar node_modules no static
app.use((req, res, next) => {
  if (req.path.startsWith('/node_modules')) return res.status(404).send('Not found');
  next();
});

// ── CONFIG ──
const WA_NUMBER = process.env.WA_NUMBER || '244928708281';
const PROXYPAY_API_KEY = process.env.PROXYPAY_API_KEY || 'sandbox_key';
const PROXYPAY_ENTITY = process.env.PROXYPAY_ENTITY || '00000';
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.ADM_SECRET || 'dono2025';
const BASE_URL = process.env.BASE_URL || 'https://sistema-dono.onrender.com';
const PROXYPAY_ENV = process.env.PROXYPAY_ENV || 'sandbox';

const PROXYPAY_BASE = PROXYPAY_ENV === 'production'
  ? 'https://api.proxypay.co.ao'
  : 'https://api.sandbox.proxypay.co.ao';

// ── BASE DE DADOS EM MEMÓRIA + PERSISTÊNCIA SIMPLES ──
// Em produção usa uma base de dados real. Para começar funciona.
let DB = { clients: [], payments: [], activity: [] };

// ── TOKEN ENGINE ──
function generateToken(clientId, days, start) {
  const payload = {
    id: clientId,
    d: +days,
    s: new Date(start).getTime(),
    e: new Date(addDays(start, +days)).getTime()
  };
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString('base64url');
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function planLabel(days) {
  return +days === 365 ? 'Anual' : 'Trimestral';
}

function planValue(days) {
  return +days === 365 ? 22000 : 9900;
}

// ── PROXYPAY — CRIAR REFERÊNCIA ──
async function createProxyPayReference(amount, clientId, clientName, plan) {
  try {
    const fetch = (await import('node-fetch')).default;
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);

    const body = {
      amount: amount,
      end_datetime: endDate.toISOString(),
      custom_fields: {
        client_id: clientId,
        client_name: clientName,
        plan: plan
      }
    };

    const response = await fetch(`${PROXYPAY_BASE}/references`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Token ' + PROXYPAY_API_KEY
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.id) {
      return {
        success: true,
        reference: data.id,
        entity: PROXYPAY_ENTITY,
        amount: amount
      };
    }
    throw new Error(data.message || 'Erro ProxyPay');
  } catch (err) {
    console.error('ProxyPay error:', err.message);
    // Fallback — gera referência local se ProxyPay falhar
    const hash = clientId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const ref = String(100000000 + (hash * 7919) % 899999999).slice(0, 9);
    return {
      success: false,
      reference: ref,
      entity: PROXYPAY_ENTITY,
      amount: amount,
      fallback: true
    };
  }
}

// ── WEBHOOK PROXYPAY ──
app.post('/webhook/proxypay', async (req, res) => {
  console.log('ProxyPay webhook recebido:', JSON.stringify(req.body));

  try {
    const payment = req.body;
    const reference = payment.reference_id || payment.id;

    // Encontrar cliente pela referência
    const client = DB.clients.find(c => c.ref === reference);

    if (!client) {
      console.log('Cliente não encontrado para referência:', reference);
      return res.status(200).json({ status: 'ignored' });
    }

    // Activar acesso
    client.status = 'active';
    client.paidAt = today();

    // Gerar token
    const token = generateToken(client.id, client.plan, today());
    client.token = token;
    client.start = today();
    client.end = addDays(today(), client.plan);

    // Registar actividade
    DB.activity.unshift({
      date: today(),
      client: client.nome,
      action: 'Pagamento confirmado automaticamente',
      plan: planLabel(client.plan),
      valor: client.valor
    });

    // Enviar link por WhatsApp (via API ou link directo)
    const accessLink = `${BASE_URL}/sistema-dono.html?token=${token}`;
    console.log(`✅ Pagamento confirmado: ${client.nome} — Link: ${accessLink}`);

    // Confirmar pagamento na ProxyPay
    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(`${PROXYPAY_BASE}/payments/${payment.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Token ' + PROXYPAY_API_KEY }
      });
    } catch (e) {
      console.log('Erro ao confirmar pagamento ProxyPay:', e.message);
    }

    res.status(200).json({ status: 'ok', client: client.nome });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).json({ status: 'error', message: err.message });
  }
});

// ── API — GERAR REFERÊNCIA ──
app.post('/api/generate-reference', async (req, res) => {
  const { nome, tel, empresa, plan, codigo } = req.body;

  if (!nome || !tel || !plan) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  }

  const clientId = uid();
  const valor = planValue(plan);
  const inicio = today();
  const expira = addDays(inicio, +plan);

  // Criar referência ProxyPay
  const ppRef = await createProxyPayReference(valor, clientId, nome, planLabel(plan));

  const client = {
    id: clientId,
    nome, tel, empresa: empresa || '',
    plan: +plan,
    start: inicio,
    end: expira,
    token: '',
    ref: ppRef.reference,
    entity: ppRef.entity,
    valor,
    codigo: codigo || '',
    status: 'pending',
    created: today()
  };

  DB.clients.push(client);
  DB.activity.unshift({
    date: today(),
    client: nome,
    action: 'Referência gerada' + (ppRef.fallback ? ' (local)' : ' (ProxyPay)'),
    plan: planLabel(plan),
    valor
  });

  res.json({
    success: true,
    clientId,
    reference: ppRef.reference,
    entity: ppRef.entity,
    amount: valor,
    plan: planLabel(plan),
    proxypay: ppRef.success
  });
});

// ── API — CONFIRMAR PAGAMENTO MANUAL ──
app.post('/api/confirm-payment', (req, res) => {
  const { clientId, secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Não autorizado' });

  const idx = DB.clients.findIndex(c => c.id === clientId);
  if (idx < 0) return res.status(404).json({ error: 'Cliente não encontrado' });

  const client = DB.clients[idx];
  const token = generateToken(client.id, client.plan, today());
  client.status = 'active';
  client.token = token;
  client.start = today();
  client.end = addDays(today(), client.plan);
  client.paidAt = today();

  DB.activity.unshift({
    date: today(),
    client: client.nome,
    action: 'Pagamento confirmado manualmente',
    plan: planLabel(client.plan),
    valor: client.valor
  });

  const accessLink = `${BASE_URL}/sistema-dono.html?token=${token}`;

  res.json({
    success: true,
    token,
    accessLink,
    client: {
      nome: client.nome,
      tel: client.tel,
      plan: planLabel(client.plan),
      end: client.end
    }
  });
});

// ── API — GERAR LINK WHATSAPP ──
app.post('/api/send-access', (req, res) => {
  const { clientId, secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Não autorizado' });

  const client = DB.clients.find(c => c.id === clientId);
  if (!client || !client.token) return res.status(404).json({ error: 'Cliente não encontrado ou sem token' });

  const link = `${BASE_URL}/sistema-dono.html?token=${client.token}`;
  const msg = `Olá ${client.nome.split(' ')[0]}! ✅\n\nPagamento confirmado! O teu acesso ao *Sistema do Dono* está activo:\n\n🔗 ${link}\n\n📋 *Plano:* ${planLabel(client.plan)} — válido até ${client.end}\n\nGuarda este link — é o teu acesso pessoal. Qualquer questão estou aqui! 🚀`;
  const waUrl = `https://wa.me/${client.tel.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`;

  res.json({ success: true, waUrl, link });
});

// ── API — LISTAR CLIENTES ──
app.get('/api/clients', (req, res) => {
  const { secret } = req.query;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Não autorizado' });
  res.json({ clients: DB.clients, activity: DB.activity });
});

// ── API — RENOVAR ──
app.post('/api/renew', (req, res) => {
  const { clientId, plan, secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Não autorizado' });

  const idx = DB.clients.findIndex(c => c.id === clientId);
  if (idx < 0) return res.status(404).json({ error: 'Cliente não encontrado' });

  const client = DB.clients[idx];
  const token = generateToken(client.id, plan, today());
  client.plan = +plan;
  client.token = token;
  client.start = today();
  client.end = addDays(today(), +plan);
  client.valor = planValue(plan);
  client.status = 'active';

  DB.activity.unshift({
    date: today(),
    client: client.nome,
    action: 'Renovação activada',
    plan: planLabel(plan),
    valor: planValue(plan)
  });

  const accessLink = `${BASE_URL}/sistema-dono.html?token=${token}`;
  res.json({ success: true, token, accessLink, end: client.end });
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    clients: DB.clients.length,
    active: DB.clients.filter(c => c.status === 'active').length,
    time: new Date().toISOString()
  });
});

// ── ROTA PRINCIPAL ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'diagnostico-do-dono.html'));
});

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor Sistema do Dono online — porta ${PORT}`);
  console.log(`🌍 URL: ${BASE_URL}`);
  console.log(`💳 ProxyPay: ${PROXYPAY_ENV} — Entidade: ${PROXYPAY_ENTITY}`);
});
