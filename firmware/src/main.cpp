#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// --- CONFIGURATION WI-FI & BACKEND ---
const char* ssid = "VOTRE_SSID_WIFI";
const char* password = "VOTRE_MOT_DE_PASSE_WIFI";

// Remplacez par l'IP de votre machine en local ou par le domaine Railway en production
// Exemple local : "192.168.1.50" (Ne mettez pas "http://")
// Exemple prod : "plantwatering-production.up.railway.app"
const char* ws_host = "192.168.1.50"; 
const int ws_port = 3001; // Port par défaut pour Express
const char* ws_path = "/ws?clientType=esp32";
const bool is_secure = false; // Mettez à true pour wss:// (Railway en production)

// --- CONFIGURATION DU MATÉRIEL (GPIO) ---
// Note : Les GPIO 34, 35, 36, 39 sont en entrée seule sur l'ESP32, ce qui convient parfaitement aux capteurs.
const int NUM_PLANTS = 6;

struct PlantConfig {
  int sensorPin;   // Pin de lecture analogique (AOUT du capteur)
  int relayPin;    // Pin de commande du relais (IN du module relais)
  int airValue;    // Valeur brute dans l'air (Sec) - À calibrer
  int waterValue;  // Valeur brute dans l'eau (Humide) - À calibrer
};

// Initialisation de la configuration matérielle
PlantConfig plants[NUM_PLANTS] = {
  {32, 13, 3100, 1400}, // Plante 1 : Capteur GPIO 32, Relais GPIO 13
  {33, 14, 3100, 1400}, // Plante 2 : Capteur GPIO 33, Relais GPIO 14
  {34, 15, 3100, 1400}, // Plante 3 : Capteur GPIO 34, Relais GPIO 15
  {35, 19, 3100, 1400}, // Plante 4 : Capteur GPIO 35, Relais GPIO 19
  {36, 21, 3100, 1400}, // Plante 5 : Capteur GPIO 36, Relais GPIO 21
  {39, 22, 3100, 1400}  // Plante 6 : Capteur GPIO 39, Relais GPIO 22
};

// --- TIMERS ET VARIABLES D'ÉTAT ---
WebSocketsClient webSocket;
unsigned long lastTelemetryTime = 0;
const unsigned long telemetryInterval = 10000; // Envoi de télémesure toutes les 10 secondes

// Structures pour suivre l'arrosage non-bloquant
unsigned long wateringEndTime[NUM_PLANTS] = {0};
bool isWateringActive[NUM_PLANTS] = {false};

// Définition de l'état logique des relais
// La plupart des modules de relais Arduino standard s'activent au niveau BAS (LOW).
// Si vos relais s'activent au niveau HAUT, changez ces valeurs :
const int RELAY_ON = LOW;
const int RELAY_OFF = HIGH;

// --- DÉCLARATION DES FONCTIONS ---
void connectWiFi();
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length);
void sendTelemetry();
void handleWaterCommand(JsonDocument& doc);
void updateWateringTimers();
float readMoisturePercentage(PlantConfig config);

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("Initialisation du système d'arrosage connecté...");

  // Configurer les broches de relais comme sorties et les désactiver immédiatement
  for (int i = 0; i < NUM_PLANTS; i++) {
    pinMode(plants[i].relayPin, OUTPUT);
    digitalWrite(plants[i].relayPin, RELAY_OFF);
  }

  // Connexion Wi-Fi
  connectWiFi();

  // Configuration du client WebSocket
  if (is_secure) {
    // webSocket.beginSSL(ws_host, 443, ws_path); // Pour la production HTTPS
    Serial.println("WebSocket configuré en mode sécurisé (WSS) non supporté nativement sans certs sur ESP32.");
  } else {
    webSocket.begin(ws_host, ws_port, ws_path);
  }
  
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000); // Tente de se reconnecter toutes les 5 secondes si déconnecté
}

void loop() {
  webSocket.loop();
  
  // Gérer l'arrosage non bloquant (vérifier si les timers sont expirés)
  updateWateringTimers();

  // Envoi périodique de télémesure
  unsigned long now = millis();
  if (now - lastTelemetryTime >= telemetryInterval) {
    lastTelemetryTime = now;
    if (WiFi.status() == WL_CONNECTED) {
      sendTelemetry();
    }
  }
}

// Connexion au réseau Wi-Fi
void connectWiFi() {
  Serial.print("Connexion au réseau : ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("");
  Serial.println("Wi-Fi connecté !");
  Serial.print("Adresse IP de l'ESP32 : ");
  Serial.println(WiFi.localIP());
}

// Convertit la valeur brute analogique (0-4095) en pourcentage d'humidité (0-100%)
float readMoisturePercentage(PlantConfig config) {
  // Lecture moyenne sur 5 échantillons pour stabiliser le signal
  long sum = 0;
  for (int i = 0; i < 5; i++) {
    sum += analogRead(config.sensorPin);
    delay(10);
  }
  int rawValue = sum / 5;

  // Calcul du pourcentage : la valeur AirValue correspond à 0%, WaterValue correspond à 100%
  // Puisque ce sont des capteurs capacitifs, la tension baisse quand l'humidité augmente.
  float percentage = map(rawValue, config.airValue, config.waterValue, 0, 100);
  
  // Limiter le résultat entre 0 et 100%
  if (percentage < 0) percentage = 0;
  if (percentage > 100) percentage = 100;

  return percentage;
}

// Envoi des données d'humidité brutes et calculées au serveur
void sendTelemetry() {
  JsonDocument doc;
  doc["type"] = "ESP32_TELEMETRY";
  
  JsonArray readings = doc.createNestedArray("readings");
  
  for (int i = 0; i < NUM_PLANTS; i++) {
    float moisture = readMoisturePercentage(plants[i]);
    JsonObject reading = readings.createNestedObject();
    reading["pinNumber"] = plants[i].sensorPin;
    reading["moisture"] = moisture;
  }

  String jsonString;
  serializeJson(doc, jsonString);
  
  Serial.print("Envoi télémesure : ");
  Serial.println(jsonString);
  
  webSocket.sendTXT(jsonString);
}

// Gestionnaire d'événements WebSocket
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Déconnecté du serveur.");
      break;
    case WStype_CONNECTED:
      Serial.println("[WS] Connecté au serveur backend !");
      // Envoyer un premier relevé immédiatement après connexion
      sendTelemetry();
      break;
    case WStype_TEXT: {
      Serial.printf("[WS] Message reçu : %s\n", payload);
      
      // Parser le message JSON reçu
      JsonDocument doc;
      DeserializationError error = deserializeJson(doc, payload);
      
      if (error) {
        Serial.print("Erreur désérialisation JSON : ");
        Serial.println(error.c_str());
        return;
      }
      
      String msgType = doc["type"];
      if (msgType == "WATER_CMD") {
        handleWaterCommand(doc);
      }
      break;
    }
    case WStype_BIN:
      break;
    case WStype_ERROR:
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
      break;
  }
}

// Traite la commande d'arrosage
void handleWaterCommand(JsonDocument& doc) {
  JsonArray actions = doc["actions"];
  
  for (JsonObject action : actions) {
    int pinNumber = action["pinNumber"];
    bool trigger = action["triggerWatering"];
    int duration = action["duration"];

    if (trigger) {
      // Trouver l'index de la plante par la pin du capteur
      for (int i = 0; i < NUM_PLANTS; i++) {
        if (plants[i].sensorPin == pinNumber) {
          Serial.printf("Activation de l'arrosage : Plante GPIO %d, Pin Relais %d, pendant %d secondes\n", 
                        pinNumber, plants[i].relayPin, duration);
          
          // Activer la broche du relais physique
          digitalWrite(plants[i].relayPin, RELAY_ON);
          
          // Configurer le timer de désactivation non-bloquant
          wateringEndTime[i] = millis() + (duration * 1000);
          isWateringActive[i] = true;
          break;
        }
      }
    }
  }
}

// Vérifie si la durée d'arrosage d'un relais est écoulée et coupe le relais
void updateWateringTimers() {
  unsigned long now = millis();
  
  for (int i = 0; i < NUM_PLANTS; i++) {
    if (isWateringActive[i] && now >= wateringEndTime[i]) {
      // Désactiver le relais
      digitalWrite(plants[i].relayPin, RELAY_OFF);
      isWateringActive[i] = false;
      Serial.printf("Fin d'arrosage : Plante index %d, Pin Relais %d éteint.\n", i, plants[i].relayPin);
    }
  }
}
