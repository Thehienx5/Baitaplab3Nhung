#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <PubSubClient.h>
#include <Adafruit_BMP085.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "AlertEngine.h"

constexpr uint8_t LED_PIN = 32, BUZZER_PIN = 26;
constexpr uint32_t SAMPLE_MS = 2000;
constexpr float P0_PA = 101325.0f;
const char *SSID = "Wokwi-GUEST", *PASSWORD = "";
const char *BROKER = "broker.emqx.io";
const char *BASE = "lab3/runner/thehienx5-20261114";

struct Data { uint32_t seq, ms; float t, p, h; bool valid; };
struct AlertData { uint32_t ms; float t, h; bool valid; };
enum Command : uint8_t { AUTO, MANUAL, LED_ON, LED_OFF, BUZZER_ON, BUZZER_OFF };
struct State {
  uint32_t ms; bool automatic, led, buzzer, tempAlarm, altitudeAlarm, sensorFault;
};
QueueHandle_t dataQueue, dataAlert, commandQueue, stateQueue;
SemaphoreHandle_t serialMutex;
Adafruit_BMP085 bmp;
WiFiClient transport;
PubSubClient mqtt(transport); // Only TaskTransmit may access this object.
String telemetryTopic, stateTopic, commandTopic, statusTopic;

void logLine(const char *s) {
  if (xSemaphoreTake(serialMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
    Serial.println(s); xSemaphoreGive(serialMutex);
  }
}

void onMessage(char *, byte *payload, unsigned int length) {
  if (length > 20) return;
  char text[21]; memcpy(text, payload, length); text[length] = 0;
  Command c;
  if (!strcmp(text, "MODE_AUTO")) c = AUTO;
  else if (!strcmp(text, "MODE_MANUAL")) c = MANUAL;
  else if (!strcmp(text, "LED_ON")) c = LED_ON;
  else if (!strcmp(text, "LED_OFF")) c = LED_OFF;
  else if (!strcmp(text, "BUZZER_ON")) c = BUZZER_ON;
  else if (!strcmp(text, "BUZZER_OFF")) c = BUZZER_OFF;
  else return;
  // Callback never writes GPIO. Alert task is the sole output owner.
  if (xQueueSend(commandQueue, &c, 0) != pdTRUE) logLine("[MQTT] Command queue full");
}

void taskRead(void *) {
  Wire.begin(21, 22); Wire.setTimeOut(100);
  bool ready = false; uint32_t sequence = 0;
  TickType_t wake = xTaskGetTickCount();
  logLine("[TaskRead] Core 1, period 2000 ms");
  for (;;) {
    if (!ready) ready = bmp.begin();
    Data d = {}; d.seq = ++sequence;
    d.t = NAN; d.p = NAN; d.h = NAN;
    // Detect unplugging as well as initial I2C failure.
    Wire.beginTransmission(0x77);
    bool present = Wire.endTransmission() == 0;
    if (ready && present) {
      d.t = bmp.readTemperature();
      int32_t pa = bmp.readPressure();
      d.p = pa / 100.0f;
      d.h = 44330.0f * (1.0f - powf(pa / P0_PA, 1.0f / 5.255f));
      d.valid = isfinite(d.t) && isfinite(d.h) && d.t >= -40 &&
                d.t <= 85 && pa >= 30000 && pa <= 110000;
    }
    ready = ready && present && d.valid;
    d.ms = millis();
    AlertData a = {d.ms, d.t, d.h, d.valid};
    xQueueOverwrite(dataAlert, &a); // Local warning is independent of WiFi.
    xQueueOverwrite(dataQueue, &d); // Latest sample, no unbounded backlog.
    char line[180];
    snprintf(line, sizeof(line),
      "[Read C%d] seq=%lu T=%.2f C P=%.2f hPa H=%.2f m valid=%d",
      xPortGetCoreID(), (unsigned long)d.seq, d.t, d.p, d.h, d.valid);
    logLine(line);
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(SAMPLE_MS));
  }
}

void taskAlert(void *) {
  pinMode(LED_PIN, OUTPUT); pinMode(BUZZER_PIN, OUTPUT);
  AlertEngine engine;
  bool automatic = true, manualLed = false, manualBuzzer = false;
  bool led = false, buzzer = false;
  uint32_t manualMs = 0, publishedMs = 0;
  logLine("[TaskAlert] Core 1, GPIO owner");
  for (;;) {
    uint32_t now = millis(); AlertData a;
    if (xQueueReceive(dataAlert, &a, 0) == pdTRUE)
      engine.sample(a.t, a.h, a.valid, a.ms);
    now = millis(); engine.tick(now);
    Command c; bool changed = false;
    while (xQueueReceive(commandQueue, &c, 0) == pdTRUE) {
      changed = true;
      if (c == AUTO) automatic = true;
      else {
        if (c == MANUAL || automatic) { manualLed = false; manualBuzzer = false; }
        automatic = false; manualMs = now;
        if (c == LED_ON) manualLed = true;
        if (c == LED_OFF) manualLed = false;
        if (c == BUZZER_ON) manualBuzzer = true;
        if (c == BUZZER_OFF) manualBuzzer = false;
      }
      logLine("[Alert] MQTT command applied");
    }
    // Manual test lease expires after 60 s; automatic monitoring resumes.
    if (!automatic && uint32_t(now - manualMs) >= 60000) automatic = true;
    bool nextLed = automatic ? engine.alarm() : manualLed;
    bool nextBuzzer = automatic ? engine.alarm() : manualBuzzer;
    changed |= nextLed != led || nextBuzzer != buzzer;
    digitalWrite(LED_PIN, nextLed ? HIGH : LOW);
    if (nextBuzzer != buzzer) {
      if (nextBuzzer) tone(BUZZER_PIN, 2000);
      else { noTone(BUZZER_PIN); digitalWrite(BUZZER_PIN, LOW); }
    }
    led = nextLed; buzzer = nextBuzzer;
    if (changed || uint32_t(now - publishedMs) >= 1000) {
      State s = {now, automatic, led, buzzer,
                 engine.temperature, engine.altitude, engine.sensor};
      xQueueOverwrite(stateQueue, &s); publishedMs = now;
      char line[140];
      snprintf(line, sizeof(line), "[Alert C%d] %s led=%d buzzer=%d temp=%d altitude=%d sensor=%d",
        xPortGetCoreID(), automatic ? "AUTO" : "MANUAL", led, buzzer,
        engine.temperature, engine.altitude, engine.sensor);
      logLine(line);
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void taskTransmit(void *) {
  WiFi.mode(WIFI_STA); WiFi.begin(SSID, PASSWORD);
  mqtt.setServer(BROKER, 1883); mqtt.setCallback(onMessage);
  mqtt.setBufferSize(768); mqtt.setSocketTimeout(2); mqtt.setKeepAlive(15);
  uint32_t wifiMs = millis(), mqttMs = 0;
  Data pending = {}; bool havePending = false;
  State state = {}; bool haveState = false, dirtyState = false;
  logLine("[TaskTransmit] Core 0, WiFi and MQTT owner");
  for (;;) {
    uint32_t now = millis();
    Data incoming;
    if (xQueueReceive(dataQueue, &incoming, 0) == pdTRUE) {
      pending = incoming; havePending = true;
    }
    State incomingState;
    if (xQueueReceive(stateQueue, &incomingState, 0) == pdTRUE) {
      state = incomingState; haveState = true; dirtyState = true;
    }
    if (WiFi.status() != WL_CONNECTED) {
      if (uint32_t(now - wifiMs) >= 10000) {
        WiFi.disconnect(); WiFi.begin(SSID, PASSWORD); wifiMs = now;
        logLine("[WiFi C0] Reconnecting");
      }
    } else if (!mqtt.connected()) {
      if (mqttMs == 0 || uint32_t(now - mqttMs) >= 5000) {
        mqttMs = now;
        String id = "runner-" + String((uint32_t)ESP.getEfuseMac(), HEX);
        if (mqtt.connect(id.c_str(), statusTopic.c_str(), 1, true, "offline")) {
          mqtt.subscribe(commandTopic.c_str());
          mqtt.publish(statusTopic.c_str(), "online", true);
          dirtyState = haveState;
          logLine("[MQTT C0] Connected and subscribed");
        } else logLine("[MQTT C0] Retry in 5 s");
      }
    } else {
      mqtt.loop();
      if (havePending) {
        char json[320];
        if (pending.valid)
          snprintf(json, sizeof(json),
            "{\"seq\":%lu,\"ms\":%lu,\"valid\":true,\"temperature\":%.2f,\"pressure\":%.2f,\"altitude\":%.2f}",
            (unsigned long)pending.seq, (unsigned long)pending.ms, pending.t, pending.p, pending.h);
        else snprintf(json, sizeof(json),
            "{\"seq\":%lu,\"ms\":%lu,\"valid\":false,\"temperature\":null,\"pressure\":null,\"altitude\":null}",
            (unsigned long)pending.seq, (unsigned long)pending.ms);
        if (mqtt.publish(telemetryTopic.c_str(), json, false)) havePending = false;
      }
      if (dirtyState && haveState) {
        char json[320];
        snprintf(json, sizeof(json),
          "{\"ms\":%lu,\"mode\":\"%s\",\"led\":%s,\"buzzer\":%s,\"tempAlarm\":%s,\"altitudeAlarm\":%s,\"sensorFault\":%s}",
          (unsigned long)state.ms, state.automatic ? "auto" : "manual",
          state.led ? "true" : "false", state.buzzer ? "true" : "false",
          state.tempAlarm ? "true" : "false", state.altitudeAlarm ? "true" : "false",
          state.sensorFault ? "true" : "false");
        if (mqtt.publish(stateTopic.c_str(), json, false)) dirtyState = false;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void setup() {
  Serial.begin(115200);
  telemetryTopic = String(BASE) + "/telemetry"; stateTopic = String(BASE) + "/state";
  commandTopic = String(BASE) + "/cmd"; statusTopic = String(BASE) + "/status";
  serialMutex = xSemaphoreCreateMutex();
  dataQueue = xQueueCreate(1, sizeof(Data)); dataAlert = xQueueCreate(1, sizeof(AlertData));
  commandQueue = xQueueCreate(8, sizeof(Command)); stateQueue = xQueueCreate(1, sizeof(State));
  if (!serialMutex || !dataQueue || !dataAlert || !commandQueue || !stateQueue) {
    Serial.println("FATAL: allocation failed"); while (true) delay(1000);
  }
  BaseType_t a = xTaskCreatePinnedToCore(taskAlert, "TaskAlert", 4096, nullptr, 3, nullptr, 1);
  BaseType_t r = xTaskCreatePinnedToCore(taskRead, "TaskRead", 4096, nullptr, 2, nullptr, 1);
  BaseType_t n = xTaskCreatePinnedToCore(taskTransmit, "TaskTransmit", 6144, nullptr, 1, nullptr, 0);
  if (a != pdPASS || r != pdPASS || n != pdPASS) {
    logLine("FATAL: task creation failed; restart required"); while (true) delay(1000);
  }
}
void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }
