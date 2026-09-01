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
