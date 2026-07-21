# HydroPulse - Système d'Arrosage Intelligent Connecté

Ce projet est un système d'arrosage automatique et connecté pour 6 plantes distinctes. Il permet de surveiller l'humidité du sol en temps réel et de configurer/déclencher l'arrosage depuis un dashboard web premium.

L'architecture est divisée en 3 parties :
1.  **`/backend`** : Serveur Express + WebSockets (TypeScript) à héberger sur **Railway**, connecté à une base de données PostgreSQL.
2.  **`/frontend`** : Application web React + Vite (Vanilla CSS) à héberger sur **Vercel**, affichant les données en temps réel.
3.  **`/firmware`** : Code source C++/Arduino pour la carte **ESP32** (géré avec PlatformIO).

---

## 🛠️ Guide d'Installation Locale

### 1. Backend (Express & PostgreSQL)
1. Rendez-vous dans le dossier `/backend`.
2. Installez les dépendances :
   ```bash
   npm install
   ```
3. Créez un fichier `.env` en vous basant sur `.env.example` et ajoutez l'URL de votre base de données PostgreSQL (locale ou Railway) :
   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/plantwatering?schema=public"
   ```
4. Générez le client Prisma et appliquez les migrations de base de données :
   ```bash
   npx prisma db push
   ```
5. Lancez le serveur de développement :
   ```bash
   npm run dev
   ```
   *Le serveur démarrera sur `http://localhost:3001` et initialisera automatiquement les 6 plantes par défaut dans la base de données si elle est vide.*

### 2. Frontend (React / Vite)
1. Rendez-vous dans le dossier `/frontend`.
2. Installez les dépendances :
   ```bash
   npm install
   ```
3. Lancez l'application en local :
   ```bash
   npm run dev
   ```
   *L'application s'ouvrira sur `http://localhost:3000` et se connectera automatiquement au serveur local.*

### 3. Firmware (ESP32)
1. Ouvrez le dossier `/firmware` dans VS Code avec l'extension **PlatformIO**.
2. Dans `/firmware/src/main.cpp` :
   * Modifiez `ssid` et `password` avec vos identifiants Wi-Fi.
   * Modifiez `ws_host` avec l'adresse IP de votre ordinateur (ou l'URL finale Railway en production).
3. Connectez l'ESP32 en USB et téléversez le code.
4. Utilisez le moniteur série (vitesse `115200`) pour suivre l'état de connexion.

---

## 🚀 Guide de Déploiement en Production

### 1. Base de données & Backend (Railway)
1. Créez un projet sur **Railway** et ajoutez un service **PostgreSQL**.
2. Créez un nouveau service sur Railway lié à votre dépôt GitHub pour le dossier `/backend`.
3. Configurez les variables d'environnement sur Railway :
   * `DATABASE_URL` : (Lié automatiquement par Railway à votre service PostgreSQL).
   * `PORT` : `3001` (ou laissez Railway affecter son port par défaut).
4. Railway exécutera automatiquement la commande `npm run build` puis `npm start`.

### 2. Frontend (Vercel)
1. Créez un nouveau projet sur **Vercel** lié à votre dépôt GitHub.
2. Définissez le dossier racine (`Root Directory`) sur `frontend`.
3. Déployez !
4. Dans `frontend/src/App.tsx`, mettez à jour la constante de production avec l'URL de votre serveur Railway déployé :
   ```typescript
   const backendUrl = isProd 
     ? 'https://votredomaine-railway.up.railway.app'
     : ...
   ```

---

## 📐 Câblage Matériel (Rappel)
*   **Capteurs d'humidité (Analogiques)** :
    *   VCC (3.3V) & GND : Bus commun (guirlande avec connecteurs Wago) reliés aux broches 3.3V/GND de l'ESP32.
    *   Données (AOUT) : Raccordements individuels sur les GPIO 32, 33, 34, 35, 36, 39 de l'ESP32.
*   **Relais pour Pompes (Output)** :
    *   Commandes (IN) : Raccordements individuels sur les GPIO 13, 14, 15, 19, 21, 22 de l'ESP32.
