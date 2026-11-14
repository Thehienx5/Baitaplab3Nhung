#pragma once
#include <math.h>
#include <stdint.h>

// Pure logic, independent from GPIO, WiFi and FreeRTOS.
struct AlertEngine {
  bool temperature = false, altitude = false, sensor = true;
  bool havePrevious = false;
  float previousAltitude = 0;
  uint32_t previousMs = 0, altitudeMs = 0, goodMs = 0;
  bool haveGood = false;

  void sample(float t, float h, bool valid, uint32_t now) {
    if (!valid) { sensor = true; havePrevious = false; return; }
    sensor = false; haveGood = true; goodMs = now;
    if (t < 20.0f || t > 35.0f) temperature = true;
    else if (t >= 21.0f && t <= 34.0f) temperature = false;
    uint32_t dt = now - previousMs;
    if (havePrevious && dt >= 1000 && dt <= 3000 &&
        fabsf(h - previousAltitude) >= 3.0f) {
      altitude = true; altitudeMs = now;
    }
    previousAltitude = h; previousMs = now; havePrevious = true;
  }
  void tick(uint32_t now) {
    if (!haveGood || uint32_t(now - goodMs) > 6000) {
      sensor = true; havePrevious = false;
    }
    if (altitude && uint32_t(now - altitudeMs) >= 10000) altitude = false;
  }
  bool alarm() const { return temperature || altitude || sensor; }
};
