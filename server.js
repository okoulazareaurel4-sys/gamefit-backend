require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
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
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

/* ============================================================
   DB — un blob JSON "data" par utilisateur (profils PC, favoris,
   bibliothèque perso). Simple et suffisant pour la V1 en ligne :
   c'est la même structure que celle déjà utilisée côté navigateur.
   ============================================================ */
const db = new Database('gamefit.db');
db.exec(`
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
const existingCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
[
  ['stripe_customer_id', "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT"],
  ['stripe_subscription_id', "ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT"],
  ['subscription_status', "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'none'"],
].forEach(([col, sql]) => { if(!existingCols.includes(col)) db.exec(sql); });

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
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => {
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
        db.prepare('UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ? WHERE id = ?')
          .run(session.customer, session.subscription, 'active', userId);
      }
    } else if(event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted'){
      const sub = event.data.object;
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      db.prepare('UPDATE users SET subscription_status = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?')
        .run(status, sub.id, sub.customer);
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

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if(!username || !password || password.length < 4){
    return res.status(400).json({ error: 'Pseudo et mot de passe (4+ caractères) requis' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if(existing) return res.status(409).json({ error: 'Ce pseudo est déjà pris' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, data) VALUES (?, ?, ?)')
    .run(username, hash, defaultData());
  const user = { id: info.lastInsertRowid, username };
  res.json({ token: signToken(user), user: { username } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if(!row || !row.password_hash || !bcrypt.compareSync(password || '', row.password_hash)){
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  res.json({ token: signToken(row), user: { username: row.username } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT username, steam_id, data, subscription_status FROM users WHERE id = ?').get(req.user.uid);
  if(!row) return res.status(404).json({ error: 'Compte introuvable' });
  res.json({
    username: row.username,
    steamLinked: !!row.steam_id,
    data: JSON.parse(row.data),
    subscribed: isActiveSub(row.subscription_status),
    subscriptionStatus: row.subscription_status || 'none'
  });
});

app.put('/api/me/data', authMiddleware, (req, res) => {
  const { data } = req.body || {};
  if(!data) return res.status(400).json({ error: 'Données manquantes' });
  db.prepare('UPDATE users SET data = ? WHERE id = ?').run(JSON.stringify(data), req.user.uid);
  res.json({ ok: true });
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
      let row = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
      if(!row){
        const username = 'steam_' + steamId.slice(-6);
        const info = db.prepare('INSERT INTO users (username, steam_id, data) VALUES (?, ?, ?)')
          .run(username, steamId, defaultData());
        row = { id: info.lastInsertRowid, username };
      }

      const data = JSON.parse(db.prepare('SELECT data FROM users WHERE id = ?').get(row.id).data);
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
      db.prepare('UPDATE users SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);

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
   (message + analyse de capture d'écran), la partie qui a un coût
   réel (appels API Claude). Le reste (comptes, sync Steam, comptes
   cloud) reste gratuit pour inciter à créer un compte.
   ============================================================ */
app.post('/api/billing/create-checkout-session', authMiddleware, async (req, res) => {
  if(!stripe || !STRIPE_PRICE_ID){
    return res.status(503).json({ error: "Abonnement non configuré côté serveur (STRIPE_SECRET_KEY / STRIPE_PRICE_ID manquants)." });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if(!row) return res.status(404).json({ error: 'Compte introuvable' });

  try{
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
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if(!row || !row.stripe_customer_id){
    return res.status(400).json({ error: "Pas encore d'abonnement à gérer pour ce compte." });
  }
  try{
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

function requireSubscription(req, res, next){
  const row = db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(req.user.uid);
  if(!row || !isActiveSub(row.subscription_status)){
    return res.status(402).json({ error: 'subscription_required', message: "Cette fonctionnalité nécessite l'abonnement GameFit Premium." });
  }
  next();
}

/* ============================================================
   SOS — vraie IA (Claude API), avec contexte PC + jeu + spoiler
   ============================================================ */
app.post('/api/sos', authMiddleware, requireSubscription, async (req, res) => {
  if(!ANTHROPIC_API_KEY){
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée côté serveur.' });
  }
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

  const userContent = [];
  if(image && image.base64){
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType || 'image/png', data: image.base64 }
    });
  }
  userContent.push({ type: 'text', text: message || "Analyse cette capture d'écran des réglages et recommande le meilleur réglage pour chaque option visible." });

  try{
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
    if(!r.ok){
      console.error(json);
      return res.status(502).json({ error: 'Erreur côté API Claude', detail: json.error && json.error.message });
    }
    const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    res.json({ reply: text || "Je n'ai pas pu générer de réponse cette fois-ci." });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur en appelant Claude.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`GameFit backend en écoute sur le port ${PORT}`);
});
