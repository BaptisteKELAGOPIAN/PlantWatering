import { useState, useEffect, useRef } from 'react';
import { 
  Droplet, 
  Pencil, 
  History, 
  Wifi, 
  WifiOff, 
  Power, 
  Activity, 
  CheckCircle2, 
  AlertTriangle,
  RotateCcw,
  Save,
  X,
  Gauge,
  Lock,
  Key,
  ShieldCheck
} from 'lucide-react';

interface Telemetry {
  id: string;
  moisture: number;
  createdAt: string;
}

interface WateringLog {
  id: string;
  duration: number;
  mode: string;
  createdAt: string;
}

interface Plant {
  id: number;
  pinNumber: number;
  name: string;
  moistureMin: number;
  wateringDuration: number;
  autoWatering: boolean;
  imageUrl?: string | null;
  telemetries?: Telemetry[];
  waterings?: WateringLog[];
}

export default function App() {
  const [plants, setPlants] = useState<Plant[]>([]);
  const [backendConnected, setBackendConnected] = useState(false);
  const [isRealEsp32, setIsRealEsp32] = useState(false);
  const [selectedPlantForHistory, setSelectedPlantForHistory] = useState<Plant | null>(null);
  const [historyData, setHistoryData] = useState<{ telemetries: Telemetry[]; waterings: WateringLog[] }>({ telemetries: [], waterings: [] });
  const [editingPlant, setEditingPlant] = useState<Plant | null>(null);
  const [isWateringMap, setIsWateringMap] = useState<Record<number, boolean>>({});
  const [wsError, setWsError] = useState<string | null>(null);
  
  // Onglets et données globales (3 onglets désignés)
  const [activeTab, setActiveTab] = useState<'dashboard' | 'stats' | 'history'>('dashboard');
  const [globalHistory, setGlobalHistory] = useState<any[]>([]);
  const [globalStats, setGlobalStats] = useState<any>(null);
  const [loadingGlobal, setLoadingGlobal] = useState(false);
  
  // État de l'arrosage automatique global
  const [globalAutoWater, setGlobalAutoWater] = useState(true);
  
  // Authentification et Sécurité (Mode Démo vs Mode Admin)
  const [adminToken, setAdminToken] = useState<string>(() => localStorage.getItem('adminToken') || '');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  
  interface PlantStats {
    lastWatering: WateringLog | null;
    wateringCount30Days: number;
    totalWateringDuration30Days: number;
    averageMoisture24h: number | null;
    minMoisture24h: number | null;
    maxMoisture24h: number | null;
  }
  const [plantStats, setPlantStats] = useState<PlantStats | null>(null);

  const socketRef = useRef<WebSocket | null>(null);

  // Déterminer les URLs d'API et WebSocket à partir des variables d'environnement
  const isProd = import.meta.env.PROD;
  const envBackendUrl = import.meta.env.VITE_BACKEND_URL;
  const envWsUrl = import.meta.env.VITE_WS_URL;

  const backendUrl = envBackendUrl || (isProd 
    ? window.location.origin
    : `http://${window.location.hostname}:3001`);

  const wsUrl = envWsUrl || (isProd
    ? `${window.location.origin.replace(/^http/, 'ws')}/ws?clientType=dashboard`
    : `ws://${window.location.hostname}:3001/ws?clientType=dashboard`);

  // 0. Test de santé du serveur (Ping /health)
  const checkHealth = async () => {
    try {
      const res = await fetch(`${backendUrl}/health`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok') {
          setBackendConnected(true);
          return true;
        }
      }
      setBackendConnected(false);
      return false;
    } catch (err) {
      console.error("Serveur indisponible ou hors ligne (Ping /health échoué):", err);
      setBackendConnected(false);
      return false;
    }
  };

  // 1. Charger les plantes initialement par API REST
  const fetchPlants = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/plants`);
      if (res.ok) {
        const data = await res.json();
        setPlants(data);
        setBackendConnected(true);
      } else {
        setBackendConnected(false);
      }
    } catch (err) {
      console.error("Erreur lors de la récupération des plantes:", err);
      setBackendConnected(false);
    }
  };

  // 1b. Charger la configuration système globale
  const fetchSystemConfig = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/plants/system/config`);
      if (res.ok) {
        const config = await res.json();
        setGlobalAutoWater(config.globalAutoWater);
      }
    } catch (err) {
      console.error("Erreur de récupération de la config globale:", err);
    }
  };

  // Soumission du mot de passe Admin
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`${backendUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem('adminToken', data.token);
        setAdminToken(data.token);
        setShowAuthModal(false);
        setPasswordInput('');
      } else {
        setAuthError(data.error || 'Mot de passe incorrect');
      }
    } catch (err) {
      setAuthError('Erreur de connexion au serveur');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    setAdminToken('');
  };

  // Toggler l'arrosage automatique global (Protégé par Admin)
  const toggleGlobalAutoWater = async () => {
    if (!adminToken) {
      setShowAuthModal(true);
      return;
    }
    try {
      const res = await fetch(`${backendUrl}/api/plants/system/config`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({ globalAutoWater: !globalAutoWater })
      });
      if (res.ok) {
        const config = await res.json();
        setGlobalAutoWater(config.globalAutoWater);
      } else if (res.status === 401) {
        handleLogout();
        setShowAuthModal(true);
      }
    } catch (err) {
      console.error("Erreur lors de la modification de la config globale:", err);
    }
  };

  // 2. Connexion WebSocket et Test de santé initial
  useEffect(() => {
    checkHealth();
    fetchPlants();
    fetchSystemConfig();

    const connectWebSocket = () => {
      console.log('Connexion au WebSocket...', wsUrl);
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        console.log('Connecté au serveur WebSocket');
        setBackendConnected(true);
        setWsError(null);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // Si on est connecté en Admin, on ignore volontairement les messages du simulateur
          // L'interface restera figée sur les vraies dernières données de l'ESP32
          const localAdminToken = localStorage.getItem('adminToken');
          if (localAdminToken && message.isSimulated) {
            return;
          }
          
          if (message.type === 'INIT_STATE') {
            setPlants(message.plants);
            if (message.isRealEsp32 !== undefined) {
              setIsRealEsp32(message.isRealEsp32);
            }
          } else if (message.type === 'ESP32_STATUS_UPDATE') {
            setIsRealEsp32(Boolean(message.isRealEsp32));
          } else if (message.type === 'TELEMETRY_UPDATE') {
            // Mettre à jour l'humidité en direct pour la plante concernée
            setPlants(prev => prev.map(p => {
              if (p.id === message.plantId) {
                return {
                  ...p,
                  telemetries: [{ id: message.id || 'temp', moisture: message.moisture, createdAt: message.createdAt }]
                };
              }
              return p;
            }));
          } else if (message.type === 'WATERING_EVENT') {
            // Indiquer qu'un arrosage est en cours/terminé
            const { plantId, duration } = message;
            setIsWateringMap(prev => ({ ...prev, [plantId]: true }));
            
            // Rafraîchir les infos
            fetchPlants();

            // Arrêter l'animation d'arrosage après la durée
            setTimeout(() => {
              setIsWateringMap(prev => ({ ...prev, [plantId]: false }));
            }, duration * 1000);
          } else if (message.type === 'PLANT_CONFIG_UPDATED') {
            // Mettre à jour la config de la plante
            setPlants(prev => prev.map(p => p.id === message.plant.id ? { ...p, ...message.plant } : p));
          } else if (message.type === 'SYSTEM_CONFIG_UPDATED') {
            // Synchroniser la config globale du système
            setGlobalAutoWater(message.config.globalAutoWater);
          } else if (message.type === 'ERROR') {
            setWsError(message.message);
            setTimeout(() => setWsError(null), 5000);
          }
        } catch (error) {
          console.error("Erreur de décodage du message WS:", error);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket déconnecté. Tentative de reconnexion dans 3s...');
        setBackendConnected(false);
        setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = (err) => {
        console.error('Erreur WebSocket:', err);
        ws.close();
      };
    };

    connectWebSocket();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  // Déclencher un arrosage manuel via WebSocket (Protégé par Admin)
  const triggerWatering = (plantId: number, duration: number) => {
    if (!adminToken) {
      setShowAuthModal(true);
      return;
    }
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'TRIGGER_WATERING',
        plantId,
        duration,
        token: adminToken
      }));
      // Activer l'état d'arrosage localement en prévision
      setIsWateringMap(prev => ({ ...prev, [plantId]: true }));
      setTimeout(() => {
        setIsWateringMap(prev => ({ ...prev, [plantId]: false }));
      }, duration * 1000);
    } else {
      alert("Erreur: Le serveur n'est pas connecté. Impossible de lancer l'arrosage.");
    }
  };

  // Mettre à jour la configuration via REST (Protégé par Admin)
  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPlant) return;

    if (!adminToken) {
      setShowAuthModal(true);
      return;
    }

    try {
      const res = await fetch(`${backendUrl}/api/plants/${editingPlant.id}`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          name: editingPlant.name,
          moistureMin: editingPlant.moistureMin,
          wateringDuration: editingPlant.wateringDuration,
          autoWatering: editingPlant.autoWatering,
          imageUrl: editingPlant.imageUrl
        })
      });

      if (res.ok) {
        const updated = await res.json();
        setPlants(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
        setEditingPlant(null);
      } else if (res.status === 401) {
        handleLogout();
        setShowAuthModal(true);
      }
    } catch (err) {
      console.error("Erreur de sauvegarde de configuration:", err);
    }
  };

  // Convertir une image locale sélectionnée en Base64
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setEditingPlant(prev => prev ? { ...prev, imageUrl: reader.result as string } : null);
      };
      reader.readAsDataURL(file);
    }
  };

  // Récupérer l'historique d'une plante
  const openHistory = async (plant: Plant) => {
    setSelectedPlantForHistory(plant);
    setPlantStats(null);
    try {
      const [historyRes, statsRes] = await Promise.all([
        fetch(`${backendUrl}/api/plants/${plant.id}/history`),
        fetch(`${backendUrl}/api/plants/${plant.id}/stats`)
      ]);

      if (historyRes.ok) {
        const data = await historyRes.json();
        setHistoryData(data);
      }
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setPlantStats(statsData);
      }
    } catch (err) {
      console.error("Erreur historique et statistiques:", err);
    }
  };

  // Récupérer l'historique global de toutes les plantes
  const fetchGlobalData = async () => {
    setLoadingGlobal(true);
    try {
      const [historyRes, statsRes] = await Promise.all([
        fetch(`${backendUrl}/api/plants/global/history`),
        fetch(`${backendUrl}/api/plants/global/stats`)
      ]);

      if (historyRes.ok) {
        const data = await historyRes.json();
        setGlobalHistory(data);
      }
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setGlobalStats(statsData);
      }
    } catch (err) {
      console.error("Erreur de récupération des données globales:", err);
    } finally {
      setLoadingGlobal(false);
    }
  };

  return (
    <div className="app-container">
      {/* Background radial glow */}
      <div className="bg-glow"></div>
      
      {/* Header */}
      <header className="main-header">
        <div className="brand">
          <div className="logo-pulse">
            <Droplet className="icon-logo" />
          </div>
          <div>
            <h1>HydroPulse</h1>
            <p className="subtitle">Dashboard d'Arrosage Intelligent</p>
          </div>
        </div>

        {/* Status Indicators */}
        <div className="status-container">
          {wsError && <div className="ws-error-badge">{wsError}</div>}
          
          {/* Badge Mode Admin / Démo */}
          {adminToken ? (
            <button 
              onClick={handleLogout}
              className="status-badge admin-badge logged-in"
              title="Vous êtes connecté en Administrateur. Cliquez pour vous déconnecter."
            >
              <ShieldCheck className="status-icon" />
              <span>Admin (Déconnexion)</span>
            </button>
          ) : (
            <button 
              onClick={() => setShowAuthModal(true)}
              className="status-badge admin-badge demo-mode"
              title="Cliquez pour déverrouiller le Mode Administrateur"
            >
              <Lock className="status-icon" />
              <span>Mode Démo (Se connecter)</span>
            </button>
          )}

          <button 
            onClick={toggleGlobalAutoWater}
            className={`status-badge global-auto-toggle ${globalAutoWater ? 'active' : 'inactive'}`}
            title="Activer ou désactiver l'arrosage automatique global"
          >
            <Power className="status-icon" />
            <span>Arrosage Auto : {globalAutoWater ? 'ON' : 'OFF'}</span>
          </button>

          <div className={`status-badge ${backendConnected ? 'online' : 'offline'}`}>
            {backendConnected ? <Wifi className="status-icon" /> : <WifiOff className="status-icon" />}
            <span>Serveur : {backendConnected ? 'En ligne' : 'Hors ligne'}</span>
          </div>

          <div className={`status-badge ${!backendConnected ? 'offline' : (isRealEsp32 ? 'online' : (adminToken ? 'offline' : 'simulator'))}`}>
            <Activity className="status-icon" />
            <span>
              ESP32 : {!backendConnected 
                ? 'Non connecté' 
                : (isRealEsp32 
                    ? 'Connecté (Physique)' 
                    : (adminToken ? 'Déconnecté' : 'Mode Simulateur')
                  )}
            </span>
          </div>
        </div>
      </header>

      {/* Navigation par Onglets (3 Onglets) */}
      <div className="tab-navigation">
        <button 
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <Gauge size={16} className="icon-inline" />
          <span>Tableau de Bord</span>
        </button>
        <button 
          className={`tab-btn ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('stats');
            fetchGlobalData();
          }}
        >
          <Activity size={16} className="icon-inline" />
          <span>Statistiques</span>
        </button>
        <button 
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('history');
            fetchGlobalData();
          }}
        >
          <History size={16} className="icon-inline" />
          <span>Journal d'Historique</span>
        </button>
      </div>

      {activeTab === 'dashboard' && (
        /* Main Grid (Dashboard) */
        <main className="dashboard-grid">
          {plants.length === 0 ? (
            <div className="empty-state">
              <RotateCcw className="spinner" />
              <p>Chargement des configurations de vos plantes...</p>
            </div>
          ) : (
            plants.map(plant => {
              const currentMoisture = plant.telemetries?.[0]?.moisture ?? 0;
              const isDry = currentMoisture < plant.moistureMin;
              const isCritical = currentMoisture < 15;
              const isWatering = isWateringMap[plant.id];

              // Déterminer la couleur de statut
              const isOfflineAdmin = adminToken && !isRealEsp32;

              let statusClass = 'wet';
              let statusText = 'Humide';
              let StatusIcon = CheckCircle2;

              if (isOfflineAdmin) {
                statusClass = 'offline-plant'; // Nouvelle classe CSS
                statusText = 'Hors Ligne';
                StatusIcon = WifiOff;
              } else if (isCritical) {
                statusClass = 'critical';
                statusText = 'Critique (Sec)';
                StatusIcon = AlertTriangle;
              } else if (isDry) {
                statusClass = 'dry';
                statusText = 'Besoin d\'eau';
                StatusIcon = AlertTriangle;
              }

              return (
                <div key={plant.id} className={`plant-card ${statusClass} ${isWatering ? 'watering-active' : ''}`}>
                  
                  {/* Photo de la Plante */}
                  {plant.imageUrl && (
                    <div className="plant-image-container">
                      <img src={plant.imageUrl} alt={plant.name} className="plant-card-image" style={{ filter: isOfflineAdmin ? 'grayscale(100%)' : 'none' }} />
                      <div className="plant-image-overlay"></div>
                    </div>
                  )}

                  {/* Header Carte */}
                  <div className="card-header">
                    <div>
                      <h3>{plant.name}</h3>
                      <span className="gpio-tag">GPIO {plant.pinNumber}</span>
                    </div>
                    <div className={`status-pill ${statusClass}`}>
                      <StatusIcon size={14} className="icon-inline" />
                      <span>{isWatering ? 'Arrosage...' : statusText}</span>
                    </div>
                  </div>

                  {/* Gauge Section */}
                  <div className="gauge-section">
                    <div className="moisture-display">
                      <span className="moisture-value">{isOfflineAdmin ? '--' : currentMoisture.toFixed(1)}%</span>
                      <span className="moisture-label">Humidité du sol</span>
                    </div>
                    
                    {/* Progress bar container */}
                    <div className="progress-bar-container">
                      <div 
                        className={`progress-bar-fill ${statusClass}`} 
                        style={{ width: `${isOfflineAdmin ? 0 : Math.min(Math.max(currentMoisture, 0), 100)}%` }}
                      ></div>
                      {/* Seuil minimum indicator */}
                      <div 
                        className="threshold-line"
                        style={{ left: `${plant.moistureMin}%` }}
                        title={`Seuil min: ${plant.moistureMin}%`}
                      ></div>
                    </div>
                  </div>

                  {/* Details Config */}
                  <div className="config-summary">
                    <div className="summary-item">
                      <span className="label">Seuil d'arrosage</span>
                      <span className="value">{plant.moistureMin}%</span>
                    </div>
                    <div className="summary-item">
                      <span className="label">Durée jet</span>
                      <span className="value">{plant.wateringDuration}s</span>
                    </div>
                    <div className="summary-item">
                      <span className="label">Mode Auto</span>
                      <span className={`value mode-badge ${plant.autoWatering ? 'active' : 'inactive'}`}>
                        {plant.autoWatering ? 'Activé' : 'Désactivé'}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="card-actions">
                    <button 
                      onClick={() => triggerWatering(plant.id, plant.wateringDuration)}
                      disabled={isWatering}
                      className={`btn-water ${isWatering ? 'watering' : ''}`}
                    >
                      <Droplet size={16} className={`icon-btn ${isWatering ? 'drop-anim' : ''}`} />
                      <span>{isWatering ? 'Arrosage en cours' : 'Arroser'}</span>
                    </button>

                    <button 
                      onClick={() => setEditingPlant(plant)}
                      className="btn-icon"
                      title="Modifier"
                    >
                      <Pencil size={18} />
                    </button>

                    <button 
                      onClick={() => openHistory(plant)}
                      className="btn-icon"
                      title="Historique"
                    >
                      <History size={18} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </main>
      )}

      {activeTab === 'stats' && (
        /* Statistiques Tab view */
        <main className="global-history-container glass-card">
          <div className="global-history-header">
            <h2>Statistiques Analytiques</h2>
            <p className="subtitle">Indicateurs clés du système de culture et d'arrosage</p>
          </div>

          {loadingGlobal ? (
            <div className="global-loader">
              <RotateCcw className="spinner" />
              <p>Calcul des statistiques globales...</p>
            </div>
          ) : (
            <div className="global-history-body">
              {/* Cartes statistiques globales */}
              {globalStats && (
                <div className="stats-grid global-stats-grid">
                  <div className="stat-card-mini">
                    <span className="stat-label">Humidité Moyenne Globale</span>
                    <span className="stat-value">
                      {globalStats.globalAvgMoisture !== null 
                        ? `${globalStats.globalAvgMoisture.toFixed(1)}%` 
                        : 'Aucune donnée'}
                    </span>
                    <span className="stat-subtext">Moyenne de tous les capteurs</span>
                  </div>

                  <div className="stat-card-mini">
                    <span className="stat-label">Total Arrosages (30j)</span>
                    <span className="stat-value">{globalStats.totalWaterings30Days} fois</span>
                    <span className="stat-subtext">
                      Temps de jet total : {globalStats.totalDuration30Days} sec
                    </span>
                  </div>

                  <div className="stat-card-mini">
                    <span className="stat-label">Plante la plus arrosée</span>
                    <span className="stat-value">
                      {globalStats.mostWateredPlant ? globalStats.mostWateredPlant.name : 'Aucune'}
                    </span>
                    <span className="stat-subtext">
                      {globalStats.mostWateredPlant 
                        ? `Arrosée ${globalStats.mostWateredPlant.count} fois en 30 jours` 
                        : 'Aucun relevé d\'arrosage'}
                    </span>
                  </div>
                </div>
              )}

              {/* Comparatif par plante */}
              <div className="plants-comparison-section" style={{ marginTop: '2rem' }}>
                <h3>État comparatif des 6 plantes</h3>
                <div className="comparison-list" style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {plants.map(plant => {
                    const currentMoisture = plant.telemetries?.[0]?.moisture ?? 0;
                    const isDry = currentMoisture < plant.moistureMin;
                    const isCritical = currentMoisture < 15;
                    let statusColor = '#10b981'; // success
                    let statusLabel = 'Satisfaisant';

                    if (isCritical) {
                      statusColor = '#ef4444'; // danger
                      statusLabel = 'Critique (Sec)';
                    } else if (isDry) {
                      statusColor = '#f59e0b'; // warning
                      statusLabel = 'Sec';
                    }

                    return (
                      <div 
                        key={plant.id} 
                        className="comparison-row clickable-row-item"
                        onClick={() => openHistory(plant)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: 'rgba(255,255,255,0.02)',
                          padding: '1rem',
                          borderRadius: '12px',
                          border: '1px solid rgba(255,255,255,0.05)',
                          cursor: 'pointer'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1 }}>
                          {plant.imageUrl && (
                            <img 
                              src={plant.imageUrl} 
                              alt={plant.name} 
                              style={{ width: '40px', height: '40px', borderRadius: '8px', objectFit: 'cover' }} 
                            />
                          )}
                          <div>
                            <span style={{ fontWeight: 600, display: 'block' }}>{plant.name}</span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>GPIO {plant.pinNumber}</span>
                          </div>
                        </div>

                        {/* Barre de comparaison */}
                        <div style={{ flex: 2, padding: '0 2rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                          <span style={{ fontSize: '0.85rem', width: '40px', textAlign: 'right' }}>{currentMoisture.toFixed(0)}%</span>
                          <div style={{ flex: 1, height: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', position: 'relative' }}>
                            <div style={{ height: '100%', width: `${currentMoisture}%`, background: statusColor, borderRadius: '4px' }}></div>
                            <div style={{ position: 'absolute', top: '-4px', left: `${plant.moistureMin}%`, width: '2px', height: '16px', background: '#fff' }} title="Seuil minimal"></div>
                          </div>
                          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }} title="Seuil minimal">Seuil: {plant.moistureMin}%</span>
                        </div>

                        <span style={{ 
                          fontSize: '0.75rem', 
                          fontWeight: 600, 
                          color: statusColor, 
                          background: `${statusColor}15`, 
                          padding: '0.25rem 0.75rem', 
                          borderRadius: '20px' 
                        }}>
                          {statusLabel}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {activeTab === 'history' && (
        /* Journal d'Historique view */
        <main className="global-history-container glass-card">
          <div className="global-history-header">
            <h2>Journal d'Activité Global</h2>
            <p className="subtitle">Liste chronologique de tous les arrosages (Cliquez sur une ligne pour ouvrir les détails de la plante)</p>
          </div>

          {loadingGlobal ? (
            <div className="global-loader">
              <RotateCcw className="spinner" />
              <p>Chargement du journal d'arrosage...</p>
            </div>
          ) : (
            <div className="global-history-body">
              {/* Table d'événements globaux */}
              <div className="logs-container global-logs-container">
                {globalHistory.length === 0 ? (
                  <p className="no-data">Aucun arrosage enregistré pour le moment.</p>
                ) : (
                  <div className="table-wrapper global-table-wrapper">
                    <table className="logs-table">
                      <thead>
                        <tr>
                          <th>Date / Heure</th>
                          <th>Plante</th>
                          <th>Câblage (GPIO)</th>
                          <th>Durée</th>
                          <th>Mode de déclenchement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {globalHistory.map(log => (
                          <tr 
                            key={log.id} 
                            onClick={() => {
                              // Retrouver la plante correspondante dans l'état local
                              const matchedPlant = plants.find(p => p.id === log.plant.id);
                              if (matchedPlant) {
                                openHistory(matchedPlant);
                              }
                            }}
                            className="clickable-row-item"
                            title="Cliquez pour afficher les statistiques détaillées de cette plante"
                            style={{ cursor: 'pointer' }}
                          >
                            <td>{new Date(log.createdAt).toLocaleString('fr-FR')}</td>
                            <td className="plant-name-cell">{log.plant.name}</td>
                            <td><span className="gpio-tag">GPIO {log.plant.pinNumber}</span></td>
                            <td>{log.duration} sec</td>
                            <td>
                              <span className={`mode-badge ${log.mode.toLowerCase()}`}>
                                {log.mode}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      )}

      {/* MODAL CONFIGURATION */}
      {editingPlant && (
        <div className="modal-backdrop">
          <div className="modal-content glass-card animate-slide-up">
            <div className="modal-header">
              <h2>Configurer {editingPlant.name}</h2>
              <button className="btn-close" onClick={() => setEditingPlant(null)}>
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={saveConfig} className="config-form">
              <div className="modal-form-body">
                <div className="form-group">
                  <label>Nom de la Plante</label>
                  <input 
                    type="text" 
                    value={editingPlant.name}
                    onChange={e => setEditingPlant({ ...editingPlant, name: e.target.value })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Photo de la Plante</label>
                  <div className="image-presets-grid">
                    {[
                      { label: 'Bonsaï', value: '/images/bonsai.jpg' },
                      { label: 'Cactus', value: '/images/cactus.jpg' },
                      { label: 'Monstera', value: '/images/monstera.jpg' },
                      { label: 'Fougère', value: '/images/fern.jpg' },
                      { label: 'Menthe', value: '/images/mint.jpg' },
                      { label: 'Basilic', value: '/images/basil.jpg' },
                    ].map(preset => (
                      <button
                        key={preset.value}
                        type="button"
                        className={`preset-btn ${editingPlant.imageUrl === preset.value ? 'selected' : ''}`}
                        onClick={() => setEditingPlant({ ...editingPlant, imageUrl: preset.value })}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  {/* Téléversement d'image manuelle locale */}
                  <div className="file-upload-wrapper" style={{ marginTop: '0.75rem' }}>
                    <span className="helper-text" style={{ display: 'block', marginBottom: '0.25rem' }}>Téléverser une photo locale :</span>
                    <input 
                      type="file" 
                      accept="image/*"
                      onChange={handleFileChange}
                      className="file-input-custom"
                    />
                  </div>

                  <input 
                    type="text" 
                    placeholder="Ou collez un lien d'image personnalisé (URL)"
                    value={editingPlant.imageUrl && !editingPlant.imageUrl.startsWith('data:') ? editingPlant.imageUrl : ''}
                    onChange={e => setEditingPlant({ ...editingPlant, imageUrl: e.target.value })}
                    style={{ marginTop: '0.75rem' }}
                  />
                </div>

                <div className="form-group">
                  <label>Seuil minimal d'humidité ({editingPlant.moistureMin}%)</label>
                  <div className="slider-container">
                    <input 
                      type="range" 
                      min="10" 
                      max="90" 
                      value={editingPlant.moistureMin}
                      onChange={e => setEditingPlant({ ...editingPlant, moistureMin: Number(e.target.value) })}
                    />
                    <div className="slider-labels">
                      <span>Sec (10%)</span>
                      <span>Humide (90%)</span>
                    </div>
                  </div>
                </div>

                <div className="form-group">
                  <label>Durée d'arrosage par défaut (secondes)</label>
                  <input 
                    type="number" 
                    min="1" 
                    max="60" 
                    value={editingPlant.wateringDuration}
                    onChange={e => setEditingPlant({ ...editingPlant, wateringDuration: Number(e.target.value) })}
                    required
                  />
                </div>

                <div className="form-group toggle-group">
                  <label className="toggle-label">
                    <span>Arrosage automatique intelligent</span>
                    <p className="helper-text">Arrose dès que le taux descend en-dessous du seuil</p>
                  </label>
                  <button
                    type="button"
                    className={`toggle-btn ${editingPlant.autoWatering ? 'active' : ''}`}
                    onClick={() => setEditingPlant({ ...editingPlant, autoWatering: !editingPlant.autoWatering })}
                  >
                    <Power size={16} />
                    <span>{editingPlant.autoWatering ? 'Activé' : 'Désactivé'}</span>
                  </button>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setEditingPlant(null)}>
                  Annuler
                </button>
                <button type="submit" className="btn-primary">
                  <Save size={16} className="icon-inline" />
                  Sauvegarder
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL HISTORIQUE & GRAPHIQUE */}
      {selectedPlantForHistory && (
        <div className="modal-backdrop">
          <div className="modal-content glass-card history-modal animate-slide-up">
            <div className="modal-header">
              <div>
                <h2>Historique : {selectedPlantForHistory.name}</h2>
                <p className="subtitle">Visualisation des 50 dernières mesures</p>
              </div>
              <button className="btn-close" onClick={() => setSelectedPlantForHistory(null)}>
                <X size={20} />
              </button>
            </div>

            <div className="history-body">
              {/* Statistiques clés de la plante */}
              {plantStats ? (
                <div className="stats-grid">
                  <div className="stat-card-mini">
                    <span className="stat-label">Humidité Moyenne (24h)</span>
                    <span className="stat-value">
                      {plantStats.averageMoisture24h !== null 
                        ? `${plantStats.averageMoisture24h.toFixed(1)}%` 
                        : 'Aucune donnée'}
                    </span>
                    <span className="stat-subtext">
                      Min: {plantStats.minMoisture24h !== null ? `${plantStats.minMoisture24h.toFixed(1)}%` : 'N/A'} | 
                      Max: {plantStats.maxMoisture24h !== null ? `${plantStats.maxMoisture24h.toFixed(1)}%` : 'N/A'}
                    </span>
                  </div>

                  <div className="stat-card-mini">
                    <span className="stat-label">Arrosages (30j)</span>
                    <span className="stat-value">{plantStats.wateringCount30Days} fois</span>
                    <span className="stat-subtext">
                      Temps total : {plantStats.totalWateringDuration30Days} sec
                    </span>
                  </div>

                  <div className="stat-card-mini">
                    <span className="stat-label">Dernier Arrosage</span>
                    <span className="stat-value">
                      {plantStats.lastWatering 
                        ? `${plantStats.lastWatering.duration} sec` 
                        : 'Aucun'}
                    </span>
                    <span className="stat-subtext">
                      {plantStats.lastWatering 
                        ? `${new Date(plantStats.lastWatering.createdAt).toLocaleDateString('fr-FR')} (${plantStats.lastWatering.mode})` 
                        : 'Pas d\'arrosage'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="stats-loader">
                  <p>Calcul des statistiques en cours...</p>
                </div>
              )}

              {/* Graphique SVG sur mesure (Évite d'installer chart.js) */}
              <div className="chart-container">
                {historyData.telemetries.length < 2 ? (
                  <p className="no-data">Pas assez de données pour générer un graphique.</p>
                ) : (
                  <div className="svg-chart-wrapper">
                    <svg viewBox="0 0 500 200" className="svg-chart">
                      {/* Lignes de repères d'humidité */}
                      <line x1="40" y1="20" x2="480" y2="20" stroke="rgba(255,255,255,0.07)" strokeDasharray="4 4" />
                      <text x="15" y="24" fill="rgba(255,255,255,0.4)" fontSize="10">100%</text>

                      <line x1="40" y1="100" x2="480" y2="100" stroke="rgba(255,255,255,0.07)" strokeDasharray="4 4" />
                      <text x="15" y="104" fill="rgba(255,255,255,0.4)" fontSize="10">50%</text>

                      <line x1="40" y1="180" x2="480" y2="180" stroke="rgba(255,255,255,0.07)" strokeDasharray="4 4" />
                      <text x="15" y="184" fill="rgba(255,255,255,0.4)" fontSize="10">0%</text>

                      {/* Génération de la ligne brisée */}
                      {(() => {
                        const width = 440;
                        const height = 160; // De y=20 à y=180
                        const pointsCount = historyData.telemetries.length;
                        const points = historyData.telemetries.map((t, idx) => {
                          const x = 40 + (idx / (pointsCount - 1)) * width;
                          // 100% -> y=20, 0% -> y=180
                          const y = 180 - (t.moisture / 100) * height;
                          return `${x},${y}`;
                        }).join(' ');

                        return (
                          <>
                            {/* Dégradé sous la courbe */}
                            <path
                              d={`M 40,180 L ${points} L ${40 + width},180 Z`}
                              fill="url(#chart-grad)"
                              opacity="0.15"
                            />
                            {/* Dégradé définition */}
                            <defs>
                              <linearGradient id="chart-grad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#00b4d8" />
                                <stop offset="100%" stopColor="#00b4d8" stopOpacity="0" />
                              </linearGradient>
                            </defs>
                            {/* Ligne principale */}
                            <polyline
                              fill="none"
                              stroke="#00b4d8"
                              strokeWidth="3"
                              points={points}
                            />
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                )}
              </div>

              {/* Table d'historique des arrosages */}
              <div className="logs-container">
                <h3>Historique des Arrosages</h3>
                {historyData.waterings.length === 0 ? (
                  <p className="no-data">Aucun arrosage enregistré.</p>
                ) : (
                  <div className="table-wrapper">
                    <table className="logs-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Durée</th>
                          <th>Mode</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyData.waterings.map(log => (
                          <tr key={log.id}>
                            <td>{new Date(log.createdAt).toLocaleString('fr-FR')}</td>
                            <td>{log.duration} sec</td>
                            <td>
                              <span className={`mode-badge ${log.mode.toLowerCase()}`}>
                                {log.mode}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal d'Authentification Administrateur */}
      {showAuthModal && (
        <div className="modal-backdrop">
          <div className="modal-content auth-modal">
            <div className="modal-header">
              <div className="modal-title-group">
                <ShieldCheck className="icon-header text-primary" />
                <h3>Accès Administrateur</h3>
              </div>
              <button onClick={() => setShowAuthModal(false)} className="btn-close">
                <X size={18} />
              </button>
            </div>
            
            <form onSubmit={handleLogin} className="auth-form">
              <p className="auth-description">
                Vous êtes actuellement en <strong>Mode Démo</strong> (consultation libre). Entrez le mot de passe Administrateur pour modifier les réglages ou déclencher l'arrosage.
              </p>
              
              {authError && (
                <div className="auth-error-banner">
                  <AlertTriangle size={16} />
                  <span>{authError}</span>
                </div>
              )}

              <div className="form-group">
                <label>
                  <Key size={14} className="icon-inline" /> Mot de Passe Administrateur
                </label>
                <input 
                  type="password" 
                  value={passwordInput} 
                  onChange={e => setPasswordInput(e.target.value)} 
                  placeholder="Entrez votre mot de passe..."
                  autoFocus
                  required
                />
              </div>

              <div className="modal-actions">
                <button type="button" onClick={() => setShowAuthModal(false)} className="btn-secondary">
                  Rester en Démo
                </button>
                <button type="submit" disabled={authLoading} className="btn-primary">
                  {authLoading ? 'Vérification...' : 'Déverrouiller l\'accès'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
