# GameFit Backend

Le petit serveur qui rend GameFit "vraiment en ligne" :
- **Comptes cloud** (inscription/connexion avec mot de passe, au lieu d'un compte local au navigateur)
- **Vraie synchro Steam** (connexion officielle Steam + récupération de ta bibliothèque de jeux via l'API Steam)
- **SOS avec une vraie IA** (les questions dans SOS sont envoyées à Claude au lieu du moteur à mots-clés), y compris l'**analyse de captures d'écran de réglages** : Claude regarde la photo et recommande un réglage pour chaque option visible (résolution, ombres, textures, anti-aliasing, VSync...), adapté au profil PC de l'utilisateur.

⚠️ Epic Games, Xbox et PlayStation n'ont pas d'API publique permettant à une app tierce de lire ta bibliothèque — ce backend ne le propose donc que pour Steam. Pour les autres, l'appli garde le lien de connexion officiel + l'import manuel.

## 1. Installer

```bash
npm install
cp .env.example .env
```

Puis remplis `.env` :
- `JWT_SECRET` : une longue chaîne aléatoire (ex : `openssl rand -hex 32`)
- `STEAM_API_KEY` : clé gratuite sur https://steamcommunity.com/dev/apikey (nécessite un compte Steam avec un domaine — tu peux mettre `localhost` en test)
- `ANTHROPIC_API_KEY` : ta clé sur https://console.anthropic.com/
- `FRONTEND_URL` : l'URL où sera hébergé ton `index.html` (ex : `https://tonsite.netlify.app`). En local, l'URL locale que tu utilises pour ouvrir le fichier.
- `SELF_URL` : l'URL publique de CE serveur une fois déployé (nécessaire pour que Steam sache où renvoyer l'utilisateur après connexion).

## 2. Lancer en local

```bash
npm start
```

Le serveur écoute par défaut sur `http://localhost:3001`.

## 3. Déployer pour de vrai

Ce serveur est un Node/Express classique — tu peux le déployer sur n'importe quel hébergeur qui supporte Node.js, par exemple :
- **Render.com** (gratuit pour débuter) : "New Web Service" → connecte ton repo → `npm install` / `npm start`
- **Railway.app** : pareil, détection automatique
- Un VPS (OVH, Hetzner...) avec `pm2` pour garder le process actif

Une fois déployé, mets à jour :
- `SELF_URL` dans `.env` avec l'URL publique du serveur
- `FRONTEND_URL` avec l'URL où tu héberges `index.html`
- Dans `index.html`, renseigne cette même URL de serveur dans **Compte → URL du serveur (backend)**

## 4. Configurer l'abonnement Premium (Stripe)

GameFit Premium débloque **SOS avec vraie IA** (texte + analyse de capture d'écran) — la seule partie qui a un coût réel par utilisation (appels à l'API Claude). Tout le reste (comptes, sync Steam, comptes cloud) reste gratuit.

1. Crée un compte sur https://dashboard.stripe.com/register (mode Test au début, pas besoin de vraie entreprise pour tester).
2. Dans **Produits**, crée un produit "GameFit Premium" avec un **prix récurrent mensuel** (ex : 2000 FCFA/mois ou l'équivalent). Copie son **Price ID** (commence par `price_...`) → `STRIPE_PRICE_ID` dans `.env`.
3. Dans **Développeurs → Clés API**, copie la clé secrète → `STRIPE_SECRET_KEY`.
4. Dans **Développeurs → Webhooks**, ajoute un endpoint pointant vers `https://TON_BACKEND/api/billing/webhook`, coche les événements `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copie le "Signing secret" → `STRIPE_WEBHOOK_SECRET`.
5. Une fois prêt en conditions réelles, passe ton compte Stripe en mode **Live** et remplace les clés Test par les clés Live.

Tant que ces variables restent vides, SOS-IA répond simplement par une erreur claire invitant à configurer l'abonnement — rien ne casse.


- Les mots de passe sont hashés (bcrypt) — jamais stockés en clair.
- `STEAM_API_KEY` et `ANTHROPIC_API_KEY` ne doivent **jamais** être mises dans le frontend (`index.html`) — elles restent uniquement dans `.env` côté serveur, c'est tout l'intérêt de ce backend.
- La base de données est un simple fichier SQLite (`gamefit.db`) créé automatiquement au premier lancement. Pense à le sauvegarder si tu as des utilisateurs.
