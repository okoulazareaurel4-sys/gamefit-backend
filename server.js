require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { RelyingParty } = require('openid');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const AI_PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase(); // 'anthropic' ou 'ollama'
const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

/* ============================================================
   DB — Turso (SQLite hébergé, persiste indépendamment du serveur
   web). Un blob JSON "data" par utilisateur (profils PC, favoris,
   bibliothèque perso) — même structure que celle utilisée côté
   navigateur.

   Sans TURSO_DATABASE_URL configurée, on retombe sur un fichier
   SQLite local (pratique pour développer en local — mais ⚠️ ce
   fallback local reste éphémère si déployé tel quel sur Render).
   ============================================================ */
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function dbGet(sql, args = []){
  const r = await db.execute({ sql, args });
  return r.rows[0] || null;
}
async function dbAll(sql, args = []){
  const r = await db.execute({ sql, args });
  return r.rows;
}
async function dbRun(sql, args = []){
  const r = await db.execute({ sql, args });
  return { lastInsertRowid: r.lastInsertRowid !== undefined ? Number(r.lastInsertRowid) : undefined, rowsAffected: r.rowsAffected };
}

async function initDb(){
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      steam_id TEXT UNIQUE,
      data TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'none',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Migration douce : ajoute les colonnes d'abonnement si la base existait déjà sans elles.
  const cols = (await dbAll("PRAGMA table_info(users)")).map(c => c.name);
  const migrations = [
    ['stripe_customer_id', "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT"],
    ['stripe_subscription_id', "ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT"],
    ['subscription_status', "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'none'"],
  ];
  for(const [col, sql] of migrations){
    if(!cols.includes(col)) await db.execute(sql);
  }
}

function isActiveSub(status){ return status === 'active' || status === 'trialing'; }

function defaultData(){
  return JSON.stringify({
    profiles: [{
      id: 'p_default', name: 'Mon PC', os: 'Windows 11',
      cpu: 'AMD Ryzen 5 3600', gpu: 'NVIDIA GTX 1660 Super',
      ram: '16', storage: 'SSD NVMe', res: '1920×1080'
    }],
    activeProfileId: 'p_default',
    favorites: [],
    library: []
  });
}

const app = express();
app.use(cors({ origin: FRONTEND_URL === '*' ? true : FRONTEND_URL }));

/* ============================================================
   STRIPE WEBHOOK — doit être déclaré AVANT express.json() car
   Stripe a besoin du corps brut (non parsé) pour vérifier la
   signature de la requête.
   ============================================================ */
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if(!stripe || !STRIPE_WEBHOOK_SECRET){
    return res.status(503).send('Stripe non configuré côté serveur.');
  }
  let event;
  try{
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  }catch(err){
    console.error('Signature webhook invalide :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try{
    if(event.type === 'checkout.session.completed'){
      const session = event.data.object;
      const userId = session.client_reference_id;
      if(userId){
        await dbRun('UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ? WHERE id = ?',
          [session.customer, session.subscription, 'active', userId]);
      }
    } else if(event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted'){
      const sub = event.data.object;
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      await dbRun('UPDATE users SET subscription_status = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?',
        [status, sub.id, sub.customer]);
    }
    res.json({ received: true });
  }catch(e){
    console.error(e);
    res.status(500).send('Erreur de traitement du webhook.');
  }
});

app.use(express.json({ limit: '10mb' }));

/* ============================================================
   AUTH — inscription / connexion classiques
   ============================================================ */
function signToken(user){
  return jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function authMiddleware(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Non authentifié' });
  try{
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  }catch(e){
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  try{
    const { username, password } = req.body || {};
    if(!username || !password || password.length < 4){
      return res.status(400).json({ error: 'Pseudo et mot de passe (4+ caractères) requis' });
    }
    const existing = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
    if(existing) return res.status(409).json({ error: 'Ce pseudo est déjà pris' });

    const hash = bcrypt.hashSync(password, 10);
    const info = await dbRun('INSERT INTO users (username, password_hash, data) VALUES (?, ?, ?)', [username, hash, defaultData()]);
    const user = { id: info.lastInsertRowid, username };
    res.json({ token: signToken(user), user: { username } });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de l'inscription." });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try{
    const { username, password } = req.body || {};
    const row = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if(!row || !row.password_hash || !bcrypt.compareSync(password || '', row.password_hash)){
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    res.json({ token: signToken(row), user: { username: row.username } });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try{
    const row = await dbGet('SELECT username, steam_id, data, subscription_status FROM users WHERE id = ?', [req.user.uid]);
    if(!row) return res.status(404).json({ error: 'Compte introuvable' });
    res.json({
      username: row.username,
      steamLinked: !!row.steam_id,
      data: JSON.parse(row.data),
      subscribed: isActiveSub(row.subscription_status),
      subscriptionStatus: row.subscription_status || 'none'
    });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.put('/api/me/data', authMiddleware, async (req, res) => {
  try{
    const { data } = req.body || {};
    if(!data) return res.status(400).json({ error: 'Données manquantes' });
    await dbRun('UPDATE users SET data = ? WHERE id = ?', [JSON.stringify(data), req.user.uid]);
    res.json({ ok: true });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur lors de la sauvegarde.' });
  }
});

/* ============================================================
   STEAM — vraie connexion OpenID + vraie synchro de bibliothèque
   via l'API publique Steam Web API.
   ============================================================ */
function steamRelyingParty(){
  return new RelyingParty(
    `${SELF_URL}/api/auth/steam/return`,
    SELF_URL,
    true, true, []
  );
}

app.get('/api/auth/steam', (req, res) => {
  const rp = steamRelyingParty();
  rp.authenticate('https://steamcommunity.com/openid', false, (err, authUrl) => {
    if(err || !authUrl) return res.status(500).send('Erreur de connexion à Steam.');
    res.redirect(authUrl);
  });
});

app.get('/api/auth/steam/return', async (req, res) => {
  const rp = steamRelyingParty();
  rp.verifyAssertion(req, async (err, result) => {
    if(err || !result || !result.authenticated){
      return res.redirect(`${FRONTEND_URL}/?steam_error=1`);
    }
    // claimedIdentifier ressemble à https://steamcommunity.com/openid/id/7656119xxxxxxxxxx
    const steamId = result.claimedIdentifier.split('/').pop();

    if(!STEAM_API_KEY){
      return res.redirect(`${FRONTEND_URL}/?steam_error=missing_api_key`);
    }

    try{
      const ownedRes = await fetch(
        `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`
      );
      const owned = await ownedRes.json();
      const games = (owned.response && owned.response.games) || [];

      // Trouve ou crée l'utilisateur lié à ce steamId
      let row = await dbGet('SELECT * FROM users WHERE steam_id = ?', [steamId]);
      if(!row){
        const username = 'steam_' + steamId.slice(-6);
        const info = await dbRun('INSERT INTO users (username, steam_id, data) VALUES (?, ?, ?)', [username, steamId, defaultData()]);
        row = { id: info.lastInsertRowid, username };
      }

      const dataRow = await dbGet('SELECT data FROM users WHERE id = ?', [row.id]);
      const data = JSON.parse(dataRow.data);
      const existingIds = new Set(data.library.map(g => g.id));
      games.forEach(g => {
        const id = 'steam_' + g.appid;
        if(existingIds.has(id)) return;
        data.library.push({
          id, name: g.name, genre: 'Steam · synchronisé', icon: '🎮',
          grad: 'linear-gradient(135deg,#20242e,#12151C)',
          store: `https://store.steampowered.com/app/${g.appid}`,
          custom: true, steamSynced: true,
          minCpu:4, recCpu:6, minGpu:4, recGpu:8, minRam:8, recRam:8
        });
      });
      await dbRun('UPDATE users SET data = ? WHERE id = ?', [JSON.stringify(data), row.id]);

      const token = signToken(row);
      res.redirect(`${FRONTEND_URL}/?steam_token=${token}&steam_games=${games.length}`);
    }catch(e){
      console.error(e);
      res.redirect(`${FRONTEND_URL}/?steam_error=sync_failed`);
    }
  });
});

/* ============================================================
   ABONNEMENT (Stripe) — GameFit Premium débloque SOS avec vraie IA
   (message + analyse de capture d'écran) et la recherche des vraies
   configs Steam. Le reste (comptes, sync Steam, comptes cloud) reste
   gratuit pour inciter à créer un compte.
   ============================================================ */
app.post('/api/billing/create-checkout-session', authMiddleware, async (req, res) => {
  if(!stripe || !STRIPE_PRICE_ID){
    return res.status(503).json({ error: "Abonnement non configuré côté serveur (STRIPE_SECRET_KEY / STRIPE_PRICE_ID manquants)." });
  }
  try{
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.uid]);
    if(!row) return res.status(404).json({ error: 'Compte introuvable' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: String(row.id),
      customer: row.stripe_customer_id || undefined,
      success_url: `${FRONTEND_URL}/?checkout=success`,
      cancel_url: `${FRONTEND_URL}/?checkout=cancel`,
    });
    res.json({ url: session.url });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: "Impossible de créer la session de paiement." });
  }
});

app.post('/api/billing/create-portal-session', authMiddleware, async (req, res) => {
  if(!stripe) return res.status(503).json({ error: 'Stripe non configuré côté serveur.' });
  try{
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.uid]);
    if(!row || !row.stripe_customer_id){
      return res.status(400).json({ error: "Pas encore d'abonnement à gérer pour ce compte." });
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${FRONTEND_URL}/`,
    });
    res.json({ url: portal.url });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: "Impossible d'ouvrir le portail d'abonnement." });
  }
});

async function requireSubscription(req, res, next){
  try{
    // Interrupteur de test : REQUIRE_SUBSCRIPTION=false laisse tout le monde utiliser
    // SOS-IA sans abonnement — pratique pour tester avant d'activer Stripe.
    // Remets-le à "true" (ou supprime la variable) une fois prêt à facturer pour de vrai.
    if(process.env.REQUIRE_SUBSCRIPTION === 'false'){
      return next();
    }
    const row = await dbGet('SELECT subscription_status FROM users WHERE id = ?', [req.user.uid]);
    if(!row || !isActiveSub(row.subscription_status)){
      return res.status(402).json({ error: 'subscription_required', message: "Cette fonctionnalité nécessite l'abonnement GameFit Premium." });
    }
    next();
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
}

/* ============================================================
   RECHERCHE INDÉPENDANTE — vraies configs via l'API publique Steam
   (fonctionnalité Premium : au lieu d'une estimation générique
   "moyenne" pour un jeu absent du catalogue, on va chercher les
   vraies configurations minimale/recommandée écrites par l'éditeur
   sur la fiche Steam du jeu, et on les convertit en paliers
   CPU/GPU compatibles avec le moteur de compatibilité de GameFit.

   Limite honnête : le texte des configs n'est pas standardisé
   d'un éditeur à l'autre, donc le "matching" reste une estimation
   — meilleure qu'un préréglage générique, mais pas une science exacte.
   ============================================================ */
function stripHtml(html){
  return (html||'').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
const CPU_TIER_KEYWORDS = [
  { re:/celeron|pentium/i, tier:1 },
  { re:/ryzen 9|i9/i, tier:11 },
  { re:/ryzen 7/i, tier:8 },
  { re:/ryzen 5/i, tier:6 },
  { re:/ryzen 3/i, tier:3 },
  { re:/i7/i, tier:8 },
  { re:/i5/i, tier:6 },
  { re:/i3/i, tier:3 },
];
const GPU_TIER_KEYWORDS = [
  { re:/rtx 4090/i, tier:18 }, { re:/rtx 4080|rx 7900/i, tier:16 },
  { re:/rx 7800/i, tier:14 }, { re:/rtx 3080|rtx 4070/i, tier:13 },
  { re:/rtx 3070|rtx 4060/i, tier:11 }, { re:/rx 6700/i, tier:10 },
  { re:/rtx 3060/i, tier:9 }, { re:/rx 6600|rtx 2060/i, tier:8 },
  { re:/gtx 1660|gtx 980\s*ti/i, tier:7 },
  { re:/rx 570|rx 580|gtx 1060|gtx 970/i, tier:6 },
  { re:/gtx 1650|gtx 960|rx 470|rx 480/i, tier:5 },
  { re:/gtx 1050|gtx 950|rx 460|rx 560/i, tier:4 },
  { re:/vega 10|iris xe|gtx 750/i, tier:3 },
  { re:/vega 8/i, tier:2 },
  { re:/uhd|intel hd/i, tier:1 },
];
function matchTier(text, list){
  for(const k of list){ if(k.re.test(text)) return k.tier; }
  return null;
}
function parseRequirementBlock(html){
  const text = stripHtml(html);
  const cpuTier = matchTier(text, CPU_TIER_KEYWORDS);
  const gpuTier = matchTier(text, GPU_TIER_KEYWORDS);
  const ramMatch = text.match(/(?:memory|ram)[^0-9]{0,20}(\d+)\s*gb/i);
  const ram = ramMatch ? parseInt(ramMatch[1], 10) : null;
  return { cpuTier, gpuTier, ram, text };
}

app.get('/api/games/lookup', authMiddleware, requireSubscription, async (req, res) => {
  const name = (req.query.name || '').trim();
  if(!name) return res.status(400).json({ error: 'Paramètre "name" manquant.' });

  try{
    const searchRes = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=us&l=english`);
    const search = await searchRes.json();
    const item = search.items && search.items[0];
    if(!item){
      return res.json({ found: false, message: "Jeu introuvable sur Steam." });
    }

    const detailsRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${item.id}&cc=us&l=english`);
    const details = await detailsRes.json();
    const entry = details[item.id];
    const pcReq = entry && entry.success && entry.data && entry.data.pc_requirements;
    if(!pcReq || (!pcReq.minimum && !pcReq.recommended)){
      return res.json({ found: true, hasRequirements: false, name: item.name, appid: item.id, store: `https://store.steampowered.com/app/${item.id}` });
    }

    const min = parseRequirementBlock(pcReq.minimum);
    const rec = parseRequirementBlock(pcReq.recommended || pcReq.minimum);

    const minCpu = min.cpuTier || 3;
    const minGpu = min.gpuTier || 3;
    const recCpu = rec.cpuTier || Math.min(minCpu + 2, 14);
    const recGpu = rec.gpuTier || Math.min(minGpu + 3, 16);
    const minRam = min.ram || 8;
    const recRam = rec.ram || Math.max(minRam, 8);

    res.json({
      found: true, hasRequirements: true,
      name: (entry.data && entry.data.name) || item.name,
      appid: item.id,
      store: `https://store.steampowered.com/app/${item.id}`,
      minCpu, recCpu, minGpu, recGpu, minRam, recRam,
      confidence: (min.cpuTier && min.gpuTier) ? 'élevée' : 'partielle',
    });
  }catch(e){
    console.error(e);
    res.status(502).json({ error: "Erreur lors de la recherche sur Steam." });
  }
});

/* ============================================================
   Fonctions d'appel IA — une par fournisseur. Le endpoint /api/sos
   choisit laquelle utiliser selon AI_PROVIDER.
   ============================================================ */
async function callAnthropic(system, message, image){
  if(!ANTHROPIC_API_KEY) throw { code: 'not_configured', message: 'ANTHROPIC_API_KEY non configurée côté serveur.' };

  const userContent = [];
  if(image && image.base64){
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType || 'image/png', data: image.base64 }
    });
  }
  userContent.push({ type: 'text', text: message || "Analyse cette capture d'écran des réglages et recommande le meilleur réglage pour chaque option visible." });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: image ? 900 : 500,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const json = await r.json();
  if(!r.ok) throw { code: 'provider_error', message: json.error && json.error.message };
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

async function callOllama(system, message, image){
  if(!OLLAMA_URL) throw { code: 'not_configured', message: "OLLAMA_URL non configurée côté serveur." };

  const userMessage = {
    role: 'user',
    content: message || "Analyse cette capture d'écran des réglages et recommande le meilleur réglage pour chaque option visible."
  };
  // Format Ollama : les images vont dans un tableau à part sur le message
  // (base64 brut, sans préfixe data:image/...), pas mêlées au texte comme Anthropic.
  if(image && image.base64){
    userMessage.images = [image.base64];
  }

  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [{ role: 'system', content: system }, userMessage]
    })
  });
  const json = await r.json();
  if(!r.ok) throw { code: 'provider_error', message: json.error };
  return (json.message && json.message.content) || '';
}

/* ============================================================
   SOS — vraie IA (Anthropic ou Ollama selon AI_PROVIDER), avec
   contexte PC + jeu + spoiler
   ============================================================ */
app.post('/api/sos', authMiddleware, requireSubscription, async (req, res) => {
  const { message, game, pcProfile, spoilerLevel, image } = req.body || {};
  if(!message && !image) return res.status(400).json({ error: 'Message ou image manquant' });

  const spoilerText = { hint: 'un petit indice seulement', explain: 'une explication générale sans tout révéler', full: 'la solution complète' }[spoilerLevel] || 'un indice mesuré';

  const system = `Tu es SOS, l'assistant gaming intégré à l'application GameFit. Tu réponds en français, de façon concrète et actionnable.
Règles :
- Si le jeu ou l'info nécessaire n'est pas claire, dis-le honnêtement et demande une précision plutôt que d'inventer.
- Pour les questions de type "je suis bloqué" sur une mission/un boss, respecte le niveau de spoiler demandé : ${spoilerText}.
- Pour les questions de performance/FPS, utilise le profil PC fourni pour personnaliser les conseils de réglages.
- Reste concis (quelques phrases ou une petite liste), pas de longue dissertation.
${image ? `- Une capture d'écran des réglages du jeu est jointe. Identifie chaque option visible (résolution, ombres, textures, anti-aliasing, VSync, upscaling, distance d'affichage, etc.) et donne une recommandation précise pour CHACUNE d'elles, adaptée au profil PC de l'utilisateur. Si un texte est illisible ou coupé sur l'image, dis-le plutôt que d'inventer l'option. Présente la réponse sous forme de petite liste "option → réglage recommandé (pourquoi)".` : ''}
${game ? `Jeu concerné : ${game}.` : "Aucun jeu n'a été précisé par l'utilisateur."}
${pcProfile ? `Profil PC de l'utilisateur : ${JSON.stringify(pcProfile)}.` : ''}`;

  try{
    const reply = AI_PROVIDER === 'ollama'
      ? await callOllama(system, message, image)
      : await callAnthropic(system, message, image);
    res.json({ reply: reply || "Je n'ai pas pu générer de réponse cette fois-ci." });
  }catch(e){
    console.error(e);
    if(e && e.code === 'not_configured') return res.status(503).json({ error: e.message });
    return res.status(502).json({ error: `Erreur côté fournisseur IA (${AI_PROVIDER})`, detail: e && e.message });
  }
});

/* ============================================================
   ADMIN — statistiques d'utilisation, protégées par une clé secrète
   (ADMIN_KEY dans .env). Ouvre simplement l'URL dans un navigateur
   avec ?key=TA_CLE pour voir les chiffres.
   ============================================================ */
app.get('/api/admin/stats', async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  if(!ADMIN_KEY){
    return res.status(503).json({ error: "ADMIN_KEY non configurée côté serveur — ajoute-la dans .env pour activer ce endpoint." });
  }
  if(req.query.key !== ADMIN_KEY){
    return res.status(401).json({ error: 'Clé admin invalide ou manquante (?key=...)' });
  }
  try{
    const count = async (sql) => (await dbGet(sql)).c;
    const stats = {
      total_comptes: await count('SELECT COUNT(*) as c FROM users'),
      nouveaux_7_jours: await count("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now','-7 days')"),
      nouveaux_30_jours: await count("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now','-30 days')"),
      abonnes_premium_actifs: await count("SELECT COUNT(*) as c FROM users WHERE subscription_status IN ('active','trialing')"),
      comptes_lies_a_steam: await count('SELECT COUNT(*) as c FROM users WHERE steam_id IS NOT NULL'),
      genere_le: new Date().toISOString(),
    };
    res.json(stats);
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur lors du calcul des statistiques.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GameFit backend en écoute sur le port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Erreur au démarrage (initDb) :', e);
    process.exit(1);
  });
